import { inject, Service, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, Observable, of, throwError } from 'rxjs';
import {
  catchError,
  distinctUntilChanged,
  filter,
  map,
  switchMap,
  take,
  tap,
} from 'rxjs/operators';

import { SK_COMPLETED_QUIZ_IDS, SK_STARTED_QUIZ_IDS } from '../../constants/session-keys';
import { readSessionJson } from '../../utils/session-storage';

import { QuestionType } from '../../models/question-type.enum';
import { resolveIsMultiAnswer } from '../../utils/question-type-authority';

import { Option } from '../../models/Option.model';
import { Quiz } from '../../models/Quiz.model';
import { QuizQuestion } from '../../models/QuizQuestion.model';

import { TopicQuizQuestionsService } from '../api/topic-quiz-questions.service';
import { TopicQuizTypeRegistry } from '../api/topic-quiz-type-registry.service';
import { QuizService } from './quiz.service';
import { QuizShuffleService } from '../flow/quiz-shuffle.service';

import { isOptionCorrect } from '../../utils/is-option-correct';
import { questionsFromApiViews } from '../../utils/topic-quiz-content';
import { swallow } from '../../utils/error-logging';

@Service()
export class QuizDataService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly quizService = inject(QuizService);
  private readonly quizShuffleService = inject(QuizShuffleService);
  private readonly http = inject(HttpClient);
  private readonly topicQuizQuestions = inject(TopicQuizQuestionsService);
  private readonly topicQuizTypeRegistry = inject(TopicQuizTypeRegistry);

  // ── remaining variables ─────────────────────────────────────────
  private quizUrl = 'assets/data/quiz.json'; // single source of truth: { quizzes, resources }
  question: QuizQuestion | null = null;
  questionType: string | null = null;

  readonly quizzesSig = signal<Quiz[]>([]);
  quizzes$ = toObservable(this.quizzesSig);
  private quizzes: Quiz[] = [];
  private readonly baseQuizQuestionCache = new Map<string, QuizQuestion[]>();
  private readonly quizQuestionCache = new Map<string, QuizQuestion[]>();

  private selectedQuizSig = signal<Quiz | null>(null);
  selectedQuiz$: Observable<Quiz | null> = toObservable(this.selectedQuizSig);

  private readonly currentQuizSig = signal<Quiz | null>(null);

  readonly isContentAvailableSig = signal<boolean>(false);
  public isContentAvailable$: Observable<boolean> = toObservable(this.isContentAvailableSig);

  // Clear the question cache for a quiz to force fresh shuffle on next load.
  // Call this when starting a quiz to ensure shuffle flag is applied correctly.
  clearQuizQuestionCache(quizId: string): void {
    this.quizQuestionCache.delete(quizId);
    this.baseQuizQuestionCache.delete(quizId);
  }

  getQuizzes(): Observable<Quiz[]> {
    return this.quizzes$.pipe(
      filter((quizzes) => quizzes.length > 0), // ensure data is loaded
      take(1) // ensure it emits only once
    );
  }

  loadQuizzes(): Observable<Quiz[]> {
    return this.http.get<{ quizzes: Quiz[] }>(this.quizUrl).pipe(
      map((res) => res?.quizzes ?? []),
      tap((quizzes) => {
        // Preserve existing statuses from previously loaded quizzes
        const existingStatuses = new Map<string, string>();
        for (const quiz of this.quizzesSig()) {
          if (quiz.status) existingStatuses.set(quiz.quizId, quiz.status);
        }
        // Also restore quiz statuses from sessionStorage
        const completedIds = readSessionJson<string[]>(SK_COMPLETED_QUIZ_IDS, []);
        for (const id of completedIds) {
          if (!existingStatuses.has(id)) existingStatuses.set(id, 'completed');
        }
        const startedIds = readSessionJson<string[]>(SK_STARTED_QUIZ_IDS, []);
        for (const id of startedIds) {
          if (!existingStatuses.has(id)) existingStatuses.set(id, 'started');
        }

        // Merge statuses into new data
        const mergedQuizzes = Array.isArray(quizzes)
          ? quizzes.map((q) => ({
              ...q,
              status: existingStatuses.get(q.quizId) || q.status
            }))
          : [];

        this.quizzes = mergedQuizzes;
        this.quizzesSig.set(mergedQuizzes);
      }),
      catchError(() => {
        return throwError(() => new Error('Error fetching quiz data'));
      })
    );
  }

  // Ensure quiz metadata is available before performing operations that rely on it.
  // If quizzes have already been loaded, returns the cached list; otherwise triggers a load.
  ensureQuizzesLoaded(): Observable<Quiz[]> {
    const cached = this.quizzesSig();
    if (Array.isArray(cached) && cached.length > 0) return of(cached);

    return this.loadQuizzes();
  }

  // Returns a synchronously cached quiz instance, if available.
  // Falls back to `null` when the quizzes list has not been populated yet
  // or when the requested quiz cannot be found.
  getCachedQuizById(quizId: string): Quiz | null {
    if (!quizId) return null;

    // Prefer the signal cache (always up-to-date)
    const quizzes = this.quizzesSig();

    // Fallback to your original this.quizzes array if ever needed
    const source = Array.isArray(quizzes) && quizzes.length > 0 ? quizzes : this.quizzes;

    if (!Array.isArray(source) || source.length === 0) return null;

    return source.find((q) => q.quizId === quizId) ?? null;
  }

  //  Update the status of a quiz (e.g., to 'completed') and persist it.
  // This updates both the local array and the signal so subscribers see the change.
  updateQuizStatus(quizId: string, status: string): void {
    if (!quizId) return;

    // Update in the local array
    const quizIndex = this.quizzes.findIndex((q) => q.quizId === quizId);
    if (quizIndex >= 0) {
      this.quizzes[quizIndex] = { ...this.quizzes[quizIndex], status };
    }

    // Update in the signal
    const currentQuizzes = this.quizzesSig();
    const updatedQuizzes = currentQuizzes.map((q) => (q.quizId === quizId ? { ...q, status } : q));
    this.quizzesSig.set(updatedQuizzes);
  }

  async loadQuizById(quizId: string): Promise<Quiz | null> {
    try {
      const quiz = await firstValueFrom(
        this.getQuiz(quizId).pipe(
          filter((q): q is Quiz => q !== null),
          take(1)
        )
      );

      if (!quiz.questions?.length) return null;

      return quiz;
    } catch {
      return null;
    }
  }

  isValidQuiz(quizId: string): Observable<boolean> {
    return this.getQuizzes().pipe(
      map((quizzes: Quiz[]) => quizzes.some((quiz) => quiz.quizId === quizId)),
      catchError(() => {
        return of(false); // return `false` to indicate an invalid quiz
      })
    );
  }

  getCurrentQuizId(): string | null {
    const currentQuiz = this.currentQuizSig();
    return currentQuiz ? currentQuiz.quizId : null;
  }

  setSelectedQuiz(quiz: Quiz | null): void {
    this.selectedQuizSig.set(quiz);
  }

  getSelectedQuizSnapshot(): Quiz | null {
    return this.selectedQuizSig();
  }

  setSelectedQuizById(quizId: string): Observable<void> {
    return this.getQuizzes().pipe(
      map((quizzes: Quiz[]) => {
        this.quizzes = quizzes;
        const selectedQuiz = quizzes.find((quiz) => quiz.quizId === quizId);

        if (!selectedQuiz) {
          throw new Error(`Quiz with ID "${quizId}" not found.`);
        }

        this.setSelectedQuiz(selectedQuiz);
      }),
      catchError(() => {
        return throwError(() => new Error('Error retrieving quizzes'));
      })
    );
  }

  setCurrentQuiz(quiz: Quiz): void {
    this.currentQuizSig.set(quiz);
  }

  getCurrentQuizSnapshot(): Quiz | null {
    return this.currentQuizSig();
  }

  getQuiz(quizId: string): Observable<Quiz | null> {
    return this.quizzes$.pipe(
      filter((quizzes) => Array.isArray(quizzes) && quizzes.length > 0),
      map((quizzes) => {
        const quiz = quizzes.find((q) => q.quizId === quizId);
        if (!quiz) {
          throw new Error(`[QuizDataService] Quiz with ID ${quizId} not found.`);
        }
        return quiz;
      }),
      take(1),
      catchError(() => {
        return of(null);
      })
    );
  }

  updateContentAvailableState(isAvailable: boolean): void {
    this.isContentAvailableSig.set(isAvailable);
  }

  // Return a brand-new array of questions with fully-cloned options.
  getQuestionsForQuiz(quizId: string): Observable<QuizQuestion[]> {
    //  When shuffle is ON, ALWAYS delegate to prepareQuizSession
    // This ensures ONE consistent shuffle regardless of which code path calls this
    if (this.quizService.isShuffleEnabled()) {
      const hasShuffled =
        this.quizService.shuffledQuestions?.length > 0 && this.quizService.quizId === quizId;
      const baseCached = this.baseQuizQuestionCache.get(quizId);

      if (hasShuffled && baseCached && baseCached.length > 0) {
        this.quizService.setCanonicalQuestions(quizId, baseCached);
        return of(this.cloneQuestions(this.quizService.shuffledQuestions!));
      }

      if (hasShuffled && (!baseCached || baseCached.length === 0)) {
        // API-sourced, like every other content path since S4.
        return this.topicQuizQuestions.loadQuestions(quizId).pipe(
          map((views) => {
            const base = questionsFromApiViews(views)
              .map((q, i) => this.normalizeQuestion(q, i));
            this.baseQuizQuestionCache.set(quizId, base);
            this.quizService.setCanonicalQuestions(quizId, base);
            return this.cloneQuestions(this.quizService.shuffledQuestions!);
          }),
          catchError(() => of([] as QuizQuestion[]))
        );
      }
      return this.prepareQuizSession(quizId);
    }

    // Cache Check: Return cached questions if already built for this quiz (unshuffled case)
    const cachedQuestions = this.quizQuestionCache.get(quizId);
    if (Array.isArray(cachedQuestions) && cachedQuestions.length > 0) {
      // Sync cache hit with QuizService so standard subscribers (like ScoreComponent) get the update
      this.quizService.questions = this.cloneQuestions(cachedQuestions);
      return of(this.cloneQuestions(cachedQuestions));
    }

    // CONTENT FROM THE API. This read `quiz.questions` off the bank; only the
    // metadata argument to syncSelectedQuizState is gone with it (that
    // parameter is optional, and the sibling call at the cached branch above
    // already omits it).
    return this.topicQuizQuestions.loadQuestions(quizId).pipe(
      map((views) => {
        if (!views.length) {
          throw new Error(`Quiz with ID ${quizId} has no questions`);
        }

        // Build normalized base questions (clone options per question)
        const baseQuestions: QuizQuestion[] = questionsFromApiViews(views).map(
          (question, index) => this.normalizeQuestion(question, index)
        );

        this.baseQuizQuestionCache.set(quizId, this.cloneQuestions(baseQuestions));
        this.quizService.setCanonicalQuestions(quizId, baseQuestions);

        const shouldShuffle = this.quizService.isShuffleEnabled();
        const sessionQuestions = this.buildSessionQuestions(quizId, baseQuestions, shouldShuffle);

        this.quizQuestionCache.set(quizId, this.cloneQuestions(sessionQuestions));
        this.quizService.applySessionQuestions(quizId, this.cloneQuestions(sessionQuestions));
        this.syncSelectedQuizState(quizId, sessionQuestions);

        // Assign questions to QuizService so UI can access them
        this.quizService.questions = this.cloneQuestions(sessionQuestions);

        // Stamp multi-answer flag for each question
        for (const [_qIndex, question] of this.quizService.questions.entries()) {
          // DECLARED TYPE WINS. The count used to be an equal arm of the OR, so
          // this stamped isMulti=true onto a declared single-answer question the
          // moment the local bank carried a second `correct` flag — and every
          // consumer of the stamp inherited that.
          (question as any).isMulti = resolveIsMultiAnswer(
            question,
            Array.isArray(question.options) &&
              question.options.filter((o: Option) => isOptionCorrect(o)).length > 1
          );
        }

        return this.cloneQuestions(sessionQuestions);
      }),
      catchError((error) => {
        return throwError(() => error);
      })
    );
  }

  // Ensure the quiz session questions are available before starting a quiz.
  // Reuses any cached clone for the quiz and re-applies it to the quiz service
  // so downstream consumers receive a consistent question set.
  prepareQuizSession(quizId: string): Observable<QuizQuestion[]> {
    if (!quizId) return of([]);

    const shouldShuffle = this.quizService.isShuffleEnabled();
    const cached = this.quizQuestionCache.get(quizId);
    const baseForCanonical = this.baseQuizQuestionCache.get(quizId);

    if (Array.isArray(baseForCanonical) && baseForCanonical.length > 0) {
      this.quizService.setCanonicalQuestions(quizId, baseForCanonical);
    }

    // Cache Policy: Only use cache if NOT shuffling.
    // If shuffling is enabled, we MUST regenerate to ensure the user gets a shuffled set.
    // (Future improvement: Store 'isShuffled' metadata in cache to allow resuming shuffled sessions correctly)
    if (!shouldShuffle && Array.isArray(cached) && cached.length > 0) {
      const sessionReadyQuestions = this.cloneQuestions(cached);
      this.quizService.applySessionQuestions(quizId, sessionReadyQuestions);
      this.syncSelectedQuizState(quizId, sessionReadyQuestions);
      return of(this.cloneQuestions(sessionReadyQuestions));
    } else if (shouldShuffle) {
      const existingShuffled = this.quizService.shuffledQuestions;
      if (existingShuffled?.length > 0) {
        return of(this.cloneQuestions(existingShuffled));
      }
      // No shuffled data yet â€” fall through to buildSessionQuestions to generate initial shuffle
    }

    const baseQuestions = this.baseQuizQuestionCache.get(quizId);

    if (Array.isArray(baseQuestions) && baseQuestions.length > 0) {
      const sessionQuestions = this.buildSessionQuestions(quizId, baseQuestions, shouldShuffle);

      this.quizQuestionCache.set(quizId, this.cloneQuestions(sessionQuestions));
      const sessionClone = this.cloneQuestions(sessionQuestions);
      this.quizService.setCanonicalQuestions(quizId, baseQuestions);
      this.quizService.applySessionQuestions(quizId, sessionClone);
      this.syncSelectedQuizState(quizId, sessionClone);

      return of(this.cloneQuestions(sessionClone));
    }

    // CONTENT FROM THE API — the third and last of the bank reads on this path.
    return this.apiBaseQuestions$(quizId).pipe(
      map((base) => {
        const sessionQuestions = this.buildSessionQuestions(quizId, base, shouldShuffle);

        this.quizQuestionCache.set(quizId, this.cloneQuestions(sessionQuestions));

        const sessionClone = this.cloneQuestions(sessionQuestions);
        this.quizService.setCanonicalQuestions(quizId, base);
        this.quizService.applySessionQuestions(quizId, sessionClone);
        this.syncSelectedQuizState(quizId, sessionClone);

        return this.cloneQuestions(sessionClone);
      }),
      catchError(() => {
        return of([]);
      })
    );
  }

  private buildSessionQuestions(
    quizId: string,
    baseQuestions: QuizQuestion[],
    shouldShuffle: boolean
  ): QuizQuestion[] {
    const workingSet = this.cloneQuestions(baseQuestions);

    if (shouldShuffle) {
      this.quizShuffleService.prepareShuffle(quizId, workingSet);
      const shuffled = this.quizShuffleService.buildShuffledQuestions(quizId, workingSet);

      return this.cloneQuestions(shuffled);
    }

    this.quizShuffleService.clear(quizId);
    return workingSet;
  }

  private sanitizeOptions(options: Option[] = [], questionIndex: number): Option[] {
    // Ensure numeric IDs (idempotent)
    const withIds = this.quizShuffleService.assignOptionIds(options, questionIndex);

    const toNum = (v: unknown): number | null => {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      const n = Number(String(v));
      return Number.isFinite(n) ? n : null;
    };

    return withIds.map((option, index): Option => {
      // Keep value strictly numeric per Option type
      const numericValue =
        toNum(option.value) ??
        toNum((option as any).text) ?? // in case text is "3"
        index + 1;

      return {
        ...option,
        value: numericValue,
        // PRESERVE ABSENCE. `isOptionCorrect` answers false for an option that
        // carries no `correct` field, so restating it unconditionally turned
        // "nobody has said" into "this option is wrong" for every API-sourced
        // option. Only re-derive a flag that is actually present.
        ...(option.correct === undefined ? {} : { correct: isOptionCorrect(option) }),
        selected: option.selected === true,
        highlight: option.highlight ?? false,
        showIcon: option.showIcon ?? false,
      };
    });
  }

  private normalizeQuestion(question: QuizQuestion, questionIndex: number): QuizQuestion {
    const sanitizedOptions = this.sanitizeOptions(question.options ?? [], questionIndex);
    const alignedAnswers = this.quizShuffleService.alignAnswersWithOptions(
      question.answer,
      sanitizedOptions
    );

    // NO ANSWER KEY, NO CLAIM.
    //
    // This stamped `correct` on EVERY option from the aligned answers, which is
    // right when there is an answer key to align against. Questions from
    // `GET /questions` carry no `answer` at all, so `alignedAnswers` is empty
    // and every option would be stamped `correct: false` — asserting that each
    // one is WRONG rather than that nobody has said.
    //
    // `false` is not "unknown", and the distinction is the whole point of the
    // migration: absence is the only honest representation, and correctness
    // comes from the verdict.
    const hasAnswerKey = Array.isArray(question.answer) && question.answer.length > 0;
    const correctIds = new Set(alignedAnswers.map((a) => Number(a.optionId)));
    const finalOptions = hasAnswerKey
      ? sanitizedOptions.map((o) => ({
          ...o,
          correct: correctIds.has(Number(o.optionId)),
        }))
      : sanitizedOptions;

    return {
      ...question,
      options: finalOptions.map((option) => ({ ...option })),
      // Same rule: an empty `answer` array reads as "this question has no
      // correct options", which is a claim. Undefined says nobody has said.
      answer: hasAnswerKey ? alignedAnswers.map((option) => ({ ...option })) : undefined,
      selectedOptions: Array.isArray(question.selectedOptions)
        ? question.selectedOptions.map((option) => ({ ...option }))
        : undefined,
      selectedOptionIds: Array.isArray(question.selectedOptionIds)
        ? [...question.selectedOptionIds]
        : undefined,
    };
  }

  private cloneQuestions(questions: QuizQuestion[] = []): QuizQuestion[] {
    return (questions ?? []).map((question) => ({
      ...question,
      options: Array.isArray(question.options)
        ? question.options.map((option) => ({ ...option }))
        : [],
      answer: Array.isArray(question.answer)
        ? question.answer.map((answer) => ({ ...answer }))
        : undefined,
      selectedOptions: Array.isArray(question.selectedOptions)
        ? question.selectedOptions.map((option) => ({ ...option }))
        : undefined,
      selectedOptionIds: Array.isArray(question.selectedOptionIds)
        ? [...question.selectedOptionIds]
        : undefined,
    }));
  }

  private cloneQuestion(question: QuizQuestion | undefined | null): QuizQuestion | null {
    if (!question) return null;

    return this.cloneQuestions([question])[0] ?? null;
  }

  /**
   * The quiz's base questions, from the API.
   *
   * `getQuestionsForQuiz` and `prepareQuizSession` used to read
   * `quiz.questions` off the object `getQuiz()` returns — that is, off
   * `assets/data/quiz.json`. This is the second content path S4 had to cut
   * over; the first was `quiz-data-loader.performFetch`.
   *
   * `getQuiz()` still supplies METADATA (milestone, image, summary) and is
   * deliberately untouched — that is S7's problem, not this slice's.
   *
   * Shares the cached request with the type registry and the other loader, so
   * this costs no extra round trip. FAILS CLOSED: an error propagates and the
   * callers' existing `catchError` turns it into no questions, never a read of
   * the local bank.
   */
  private apiBaseQuestions$(quizId: string): Observable<QuizQuestion[]> {
    const cached = this.baseQuizQuestionCache.get(quizId);
    if (Array.isArray(cached) && cached.length > 0) {
      this.quizService.setCanonicalQuestions(quizId, cached);
      return of(this.cloneQuestions(cached));
    }

    return this.topicQuizQuestions.loadQuestions(quizId).pipe(
      map((views) => this.ensureBaseQuestions(quizId, questionsFromApiViews(views)))
    );
  }

  private ensureBaseQuestions(quizId: string, apiQuestions: QuizQuestion[]): QuizQuestion[] {
    const cached = this.baseQuizQuestionCache.get(quizId);
    if (Array.isArray(cached) && cached.length > 0) {
      this.quizService.setCanonicalQuestions(quizId, cached);
      return this.cloneQuestions(cached);
    }

    // `normalizeQuestion` assigns ids and aligns answers. With no `answer` on
    // an API question it now leaves correctness alone rather than stamping
    // `correct: false` on everything — see the note there.
    const normalized = apiQuestions.map((question, index) =>
      this.normalizeQuestion(question, index)
    );

    const normalizedClone = this.cloneQuestions(normalized);
    this.baseQuizQuestionCache.set(quizId, this.cloneQuestions(normalizedClone));
    this.quizService.setCanonicalQuestions(quizId, normalizedClone);

    return normalizedClone;
  }

  getQuestionAndOptions(
    quizId: string,
    questionIndex: number
  ): Observable<[QuizQuestion | null, Option[] | null]> {
    if (typeof questionIndex !== 'number' || isNaN(questionIndex)) {
      return of<[QuizQuestion | null, Option[] | null]>([null, null]);
    }

    // CONTENT FROM THE API — the fourth and last bank read on this service's
    // question paths. `getQuiz()` is no longer consulted here at all; it only
    // ever supplied `quiz.questions`, and the metadata it also carries was
    // never used by this method.
    return this.apiBaseQuestions$(quizId).pipe(
      map((base) => {
        let questionsToUse = this.quizQuestionCache.get(quizId);

        if (!Array.isArray(questionsToUse) || questionsToUse.length === 0) {
          const sessionQuestions = this.buildSessionQuestions(
            quizId,
            base,
            this.quizService.isShuffleEnabled()
          );

          this.quizQuestionCache.set(quizId, this.cloneQuestions(sessionQuestions));
          questionsToUse = sessionQuestions;
        }

        if (
          questionIndex < 0 ||
          !Array.isArray(questionsToUse) ||
          questionIndex >= questionsToUse.length
        )
          return [null, null] as [QuizQuestion | null, Option[] | null];

        const question = this.cloneQuestion(questionsToUse[questionIndex]);
        if (!question) {
          return [null, null] as [QuizQuestion | null, Option[] | null];
        }

        // `correct: isOptionCorrect(option)` used to be stamped here. With no
        // answer key on an API question that evaluates to FALSE for every
        // option — a claim that each is wrong. Display flags only now;
        // correctness is the verdict's to state.
        const options = (question.options ?? []).map((option) => ({
          ...option,
          selected: option.selected === true,
          highlight: option.highlight ?? false,
          showIcon: option.showIcon ?? false,
        }));

        question.options = [...options];
        // Only align an answer key that actually exists — see normalizeQuestion.
        if (Array.isArray(question.answer) && question.answer.length > 0) {
          question.answer = this.quizShuffleService.alignAnswersWithOptions(question.answer, options);
        }

        return [question, options] as [QuizQuestion | null, Option[] | null];
      }),
      catchError(() => {
        return of<[QuizQuestion | null, Option[] | null]>([null, null]);
      })
    );
  }

  fetchQuizQuestionByIdAndIndex(
    quizId: string,
    questionIndex: number
  ): Observable<QuizQuestion | null> {
    if (!quizId) return of(null);

    // Get the total-question count
    return this.quizService.getTotalQuestionsCount(quizId).pipe(
      take(1),
      switchMap((totalQuestions) => {
        // Index-bounds guard now that we have the number
        if (!Number.isFinite(totalQuestions) || totalQuestions <= 0) {
          return of(null);
        }

        const maxIndex = totalQuestions - 1;
        if (questionIndex < 0 || questionIndex > maxIndex) return of(null);

        // Fall through to existing tuple-fetch logic
        return this.getQuestionAndOptions(quizId, questionIndex).pipe(
          switchMap((result) => {
            if (!result) return of(null);

            const [question, options] = result;
            if (!question || !options) {
              return of(null);
            }

            question.options = options;
            return of(question);
          })
        );
      }),
      // Unchanged operators
      distinctUntilChanged(),
      catchError((err) => {
        return throwError(() => new Error('An error occurred while fetching data: ' + err.message));
      })
    );
  }

  async fetchQuestionAndOptionsFromAPI(
    quizId: string,
    currentQuestionIndex: number
  ): Promise<[QuizQuestion, Option[]] | null> {
    try {
      const questionAndOptions = await firstValueFrom(
        this.getQuestionAndOptions(quizId, currentQuestionIndex).pipe(
          filter((v): v is [QuizQuestion, Option[]] => v !== null),
          take(1)
        )
      );

      return questionAndOptions;
    } catch {
      return null;
    }
  }

  getOptions(quizId: string, questionIndex: number): Observable<Option[]> {
    return this.getQuiz(quizId).pipe(
      map((quiz) => {
        const cachedQuestions = this.quizQuestionCache.get(quizId);
        if (cachedQuestions) {
          if (questionIndex < 0 || questionIndex >= cachedQuestions.length) {
            return [];
          }
          return cachedQuestions[questionIndex].options ?? [];
        }

        // Only call extractOptions if quiz is valid
        if (quiz) {
          return this.extractOptions(quiz, questionIndex);
        } else {
          return [];
        }
      }),
      distinctUntilChanged(),
      catchError(() => {
        return throwError(() => new Error('Failed to fetch question options.'));
      })
    );
  }

  private extractOptions(quiz: Quiz, questionIndex: number): Option[] {
    if (!quiz?.questions || quiz.questions.length <= questionIndex) return [];

    return quiz.questions[questionIndex].options || [];
  }

  getAllExplanationTextsForQuiz(quizId: string): Observable<string[]> {
    return this.getQuiz(quizId).pipe(
      filter((quiz): quiz is Quiz => quiz !== null),
      switchMap((quiz: Quiz) => {
        const sourceQuestions = this.quizQuestionCache.get(quizId) ?? quiz.questions ?? [];

        const explanationTexts = sourceQuestions.map((q) =>
          typeof q.explanation === 'string' ? q.explanation : ''
        );

        return of(explanationTexts);
      }),
      catchError(() => {
        return of([]);
      })
    );
  }

  async asyncOperationToSetQuestion(quizId: string, currentQuestionIndex: number): Promise<void> {
    try {
      if (!quizId || currentQuestionIndex < 0) return;

      const observable = this.fetchQuizQuestionByIdAndIndex(quizId, currentQuestionIndex);
      if (!observable) return;

      const question = await firstValueFrom(observable);
      this.question = question ?? null;
    } catch (err) {
      swallow('quizdata.service#1', err);
    }
  }

  /**
   * The question's selection type — DECLARED FIRST, counted only as a fallback.
   *
   * This used to count `option.correct` unconditionally and assign the result.
   * With question content coming from `/questions` there is no `correct` to
   * count, so the count is always 0 and every question it touched was rewritten
   * to SingleAnswer — silently DEMOTING declared multi-answer questions.
   *
   * The damage was invisible on single-answer questions (SingleAnswer is what
   * they already were) and, in the unshuffled path, was repaired moments later
   * when `applyDeclaredTypes` stamped the same array. Under shuffle the repair
   * lands on the loader's array while the view renders the SESSION array, so
   * nothing repaired it: the question rendered as radio buttons, a second
   * correct pick was refused as if it were a wrong answer on a single-answer
   * question, and `/check` therefore received an incomplete selection — which
   * the server correctly judged `incomplete`, so the score never credited.
   *
   * A COUNT MAY NEVER OVERRULE A DECLARATION. The registry is keyed by question
   * text and is authoritative; the count survives only for questions nobody has
   * declared, and disappears with the local bank.
   */
  setQuestionType(question: QuizQuestion): void {
    if (!question) return;
    if (!Array.isArray(question.options)) return;
    if (question.options.length === 0) return;

    const declared = this.topicQuizTypeRegistry.questionTypeOf(question.questionText);
    if (declared !== null) {
      question.type = declared;
      this.questionType = declared;
      return;
    }

    const numCorrectAnswers = question.options.filter((option) => option?.correct ?? false).length;
    question.type = numCorrectAnswers > 1 ? QuestionType.MultipleAnswer : QuestionType.SingleAnswer;
    this.questionType = question.type;
  }

  // NOTE: a submitQuiz() method used to live here. It POSTed the whole quiz to
  // `assets/data/quiz.json/results/<quizId>` — a nonsensical URL built from the
  // static asset path — and had no callers anywhere in the app. It was a leftover
  // from a server-backed ancestor of this project. Removed because it was the
  // only outbound HTTP write in an otherwise backend-less, static-hosted SPA, and
  // leaving it invited someone to wire it up to a non-existent endpoint.

  private syncSelectedQuizState(
    quizId: string,
    questions: QuizQuestion[],
    sourceQuiz?: Quiz | null
  ): void {
    if (!Array.isArray(questions) || questions.length === 0) return;

    const baseQuiz =
      sourceQuiz ??
      this.selectedQuizSig() ??
      this.quizService.selectedQuiz ??
      this.getCachedQuizById(quizId);

    if (!baseQuiz) return;

    const sanitizedQuestions = questions.map((question) => ({
      ...question,
      options: Array.isArray(question.options)
        ? question.options.map((option) => ({ ...option }))
        : [],
    }));

    const syncedQuiz: Quiz = {
      ...baseQuiz,
      quizId: baseQuiz.quizId ?? quizId,
      questions: sanitizedQuestions,
    };

    this.setSelectedQuiz(syncedQuiz);
    this.setCurrentQuiz(syncedQuiz);
    this.quizService.setSelectedQuiz(syncedQuiz);
    this.quizService.setActiveQuiz(syncedQuiz);
  }
}
