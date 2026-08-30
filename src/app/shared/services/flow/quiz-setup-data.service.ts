import { Service, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { EMPTY, firstValueFrom, of } from 'rxjs';
import { catchError, switchMap, tap } from 'rxjs/operators';

import { Option } from '../../models/Option.model';
import { QuestionPayload } from '../../models/QuestionPayload.model';
import { Quiz } from '../../models/Quiz.model';
import { QuizQuestion } from '../../models/QuizQuestion.model';

import { ExplanationTextService } from '../features/explanation/explanation-text.service';
import { NextButtonStateService } from '../state/next-button-state.service';
import { QuizContentLoaderService } from './quiz-content-loader.service';
import { QuizDataService } from '../data/quizdata.service';
import { QuizQuestionDataService } from './quiz-question-data.service';
import { QuizService } from '../data/quiz.service';
import { QuizStateService } from '../state/quizstate.service';
import { SelectedOptionService } from '../state/selectedoption.service';
import { TimerService } from '../features/timer/timer.service';

import { reportError } from '../../utils/error-logging';

import type { QuizComponent } from '../../../containers/quiz/quiz.component';
import { swallow } from '../../utils/error-logging';

type Host = QuizComponent;

/**
 * Handles quiz data loading, session hydration, and question stream initialization for QuizComponent.
 * Extracted from QuizSetupService.
 */
@Service()
export class QuizSetupDataService {
  // ── injects ─────────────────────────────────────────────────────
  private explanationTextService = inject(ExplanationTextService);
  private nextButtonStateService = inject(NextButtonStateService);
  private quizContentLoaderService = inject(QuizContentLoaderService);
  private quizDataService = inject(QuizDataService);
  private quizQuestionDataService = inject(QuizQuestionDataService);
  private quizService = inject(QuizService);
  private quizStateService = inject(QuizStateService);
  private router = inject(Router);
  private selectedOptionService = inject(SelectedOptionService);
  private timerService = inject(TimerService);

  // ── public methods ──────────────────────────────────────────────

  // â”€â”€ Data loading â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async loadQuestions(host: Host): Promise<void> {
    try {
      const questions = await this.quizService.fetchQuizQuestions(host.quizId());
      if (!questions?.length) return;
      host.questionsArray.set([...questions]);
      host.totalQuestions.set(questions.length);
      host.isQuizDataLoaded.set(true);
      host.cdRef.markForCheck();
    } catch (err) {
      swallow('quiz-setup-data.service#1', err);
    }
    this.pushInitialQuestionPayload(host);
  }

  private pushInitialQuestionPayload(host: Host): void {
    const initialIdx = host.currentQuestionIndex() || 0;
    const initialQuestion = this.quizService.questions?.[initialIdx]
      ?? host.questionsArray()?.[initialIdx];
    if (!initialQuestion?.options?.length) return;

    host.currentQuestion.set(initialQuestion);
    host.questionToDisplaySig.set(initialQuestion.questionText?.trim() ?? '');
    const payload = {
      question: initialQuestion,
      options: initialQuestion.options,
      explanation: initialQuestion.explanation
    };
    host.combinedQuestionData.set(payload);
    host.cdRef.markForCheck();

    Promise.resolve().then(() => {
      const current = host.combinedQuestionData();
      if (!current || current.options?.length === 0) {
        host.combinedQuestionData.set(payload);
        host.cdRef.markForCheck();
      }
    });
  }

  async loadQuizData(host: Host): Promise<boolean> {
    if (host.isQuizLoaded()) return true;
    if (!host.quizId()) return false;

    try {
      const result = await this.quizContentLoaderService.loadQuizDataFromService(host.quizId());
      if (!result) return false;

      host.quiz.set(result.quiz);
      this.applyQuestionsFromSession(host, result.questions);

      const safeIndex = Math.min(Math.max(host.currentQuestionIndex() ?? 0, 0), host.questions().length - 1);
      host.currentQuestionIndex.set(safeIndex);
      host.currentQuestion.set(host.questions()[safeIndex] ?? null);

      const currentQuiz = host.quiz();
      if (currentQuiz) this.quizService.setCurrentQuiz(currentQuiz);
      host.isQuizLoaded.set(true);
      return true;
    } catch {
      host.questions.set([]);
      return false;
    }
  }

  loadCurrentQuestion(host: Host): void {
    this.quizService.getQuestionByIndex(host.currentQuestionIndex())
      .pipe(
        tap((question: QuizQuestion | null) => {
          if (!question) return;
          host.question.set(question);
          this.quizService.getOptions(host.currentQuestionIndex()).subscribe({
            next: (options: Option[]) => {
              host.optionsToDisplaySig.set(options || []);
              if (!this.selectedOptionService.isQuestionAnswered(host.currentQuestionIndex())) {
                this.timerService.restartForQuestion(host.currentQuestionIndex());
              }
            },
            error: () => {
              host.optionsToDisplaySig.set([]);
            }
          });
        }),
        catchError(() => {
          return of(null);
        })
      )
      .subscribe();
  }

  refreshQuestionOnReset(host: Host): void {
    firstValueFrom(this.quizService.getQuestionByIndex(0))
      .then((question: QuizQuestion | null) => {
        if (!question) return;
        this.quizService.setCurrentQuestion(question);
        this.loadCurrentQuestion(host);
      })
      .catch((err: unknown) => reportError('quiz-setup-data: load first question', err));
  }

  async getQuestion(host: Host): Promise<void | null> {
    const quizId = host.activatedRoute.snapshot.params['quizId'];
    const question = await this.quizContentLoaderService.fetchQuestionFromAPI(
      quizId, host.currentQuestionIndex()
    );
    host.question.set(question ?? null);
  }

  // â”€â”€ Session hydration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  applyQuestionsFromSession(host: Host, questions: QuizQuestion[]): void {
    const result = this.quizContentLoaderService.hydrateQuestionsFromSession({
      questions, quiz: host.quiz(), selectedQuiz: host.selectedQuiz(),
    });

    host.questions.set(result.hydratedQuestions);

    const currentQuiz = host.quiz();
    if (result.quizQuestions && currentQuiz) {
      host.quiz.set({ ...currentQuiz, questions: result.quizQuestions });
    }
    const currentSelectedQuiz = host.selectedQuiz();
    if (result.selectedQuizQuestions && currentSelectedQuiz) {
      host.selectedQuiz.set({ ...currentSelectedQuiz, questions: result.selectedQuizQuestions });
    }

    this.syncQuestionSnapshotFromSession(host, result.hydratedQuestions);
  }

  private syncQuestionSnapshotFromSession(host: Host, hydratedQuestions: QuizQuestion[]): void {
    const result = this.quizContentLoaderService.syncQuestionSnapshot({
      hydratedQuestions, currentQuestionIndex: host.currentQuestionIndex(),
      previousIndex: host.previousIndex(), serviceCurrentIndex: this.quizService?.currentQuestionIndex,
    });
    if (result.isEmpty) {
      host.questionToDisplaySig.set('');
      host.currentQuestion.set(null);
      host.optionsToDisplaySig.set([]);
      host.hasOptionsLoaded.set(false);
      host.shouldRenderOptions.set(false);
      host.explanationToDisplay.set('');
      this.explanationTextService.setExplanationText('', { index: host.currentQuestionIndex() ?? 0 });
      return;
    }
    host.currentQuestionIndex.set(result.normalizedIndex);
    host.question.set(result.question);
    host.currentQuestion.set(result.question);
    host.questionToDisplaySig.set(result.trimmedQuestionText);
    host.optionsToDisplaySig.set([...result.normalizedOptions]);
    host.hasOptionsLoaded.set(result.normalizedOptions.length > 0);
    host.shouldRenderOptions.set(host.hasOptionsLoaded());
    host.explanationToDisplay.set(result.trimmedExplanation);
    const qqc = host.quizQuestionComponent?.();
    if (qqc) qqc.optionsToDisplay.set([...result.normalizedOptions]);
  }

  // â”€â”€ Quiz initialization â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  resolveQuizData(host: Host): void {
    host.activatedRoute.data
      .pipe(takeUntilDestroyed(host.destroyRef))
      .subscribe(async (data: any) => {
        const quizData = data['quizData'];
        // S6f: existence only — quizData.questions is always [] now (the
        // resolver no longer carries the bank's real question content), so
        // this can no longer gate on .questions.length like it used to.
        if (!quizData?.quizId) {
          void this.router.navigate(['/select']);
          return;
        }
        host.selectedQuiz.set(quizData);
        this.quizContentLoaderService.initializeFetForQuizData(quizData);
        await this.initializeQuiz(host);
        this.quizContentLoaderService.initializeFetForShuffledQuiz();
      });
  }

  private async initializeQuiz(host: Host): Promise<void> {
    if (host.quizAlreadyInitialized()) return;
    host.quizAlreadyInitialized.set(true);

    await this.prepareQuizSession(host);

    // Honour the URL-derived question index. host.currentQuestionIndex is
    // set by initializeQuestionIndex earlier in runOnInit (which parses the
    // route param). Hard-coding 0 here on direct nav to /question/.../5
    // overwrote it and made the entire init use Q1 â€” visible to the user
    // as Q1's text + options on Q5.
    const currentIdx = host.currentQuestionIndex();
    const targetIdx = Number.isFinite(currentIdx) && currentIdx >= 0
      ? currentIdx
      : (Number.isFinite(host.questionIndex()) && host.questionIndex() >= 0 ? host.questionIndex() : 0);

    if (targetIdx >= 0) {
      this.quizContentLoaderService.fetchAndSubscribeQuestionAndOptions(host.quizId(), targetIdx);
    }
    this.quizService.setCurrentQuestionIndex(targetIdx);

    const targetQuestion = await firstValueFrom(this.quizService.getQuestionByIndex(targetIdx));
    if (targetQuestion) {
      this.quizService.setCurrentQuestion(targetQuestion);
      this.quizQuestionDataService.forceRegenerateExplanation(targetQuestion, targetIdx);
    }
  }

  private async prepareQuizSession(host: Host): Promise<void> {
    // Don't blow away host.currentQuestionIndex here â€” initializeQuestionIndex
    // ran earlier in runOnInit and may have set it from the URL param.
    // Reset only when no URL-derived index was established yet.
    const idx = host.currentQuestionIndex();
    if (!Number.isFinite(idx) || idx < 0) {
      host.currentQuestionIndex.set(0);
    }
    host.quizId.set(host.activatedRoute.snapshot.paramMap.get('quizId') ?? '');
    await this.quizContentLoaderService.prepareQuizSession({
      quizId: host.quizId(),
      applyQuestionsFromSession: (questions: QuizQuestion[]) => this.applyQuestionsFromSession(host, questions)
    });
  }

  initializeQuizFromRoute(host: Host): void {
    host.activatedRoute.data
      .pipe(
        takeUntilDestroyed(host.destroyRef),
        switchMap((data: { quizData?: Quiz }) => {
          if (!data.quizData) {
            void this.router.navigate(['/select']);
            return EMPTY;
          }
          host.quiz.set(data.quizData);
          this.quizContentLoaderService.resetFetStateForInit();
          return of(true);
        })
      )
      .subscribe(() => {
        const trimmed = (this.quizService.questions?.[0]?.questionText ?? '').trim();
        if (trimmed) host.questionToDisplaySig.set(trimmed);
        this.quizContentLoaderService.seedFirstQuestionText();
        host.cdRef.markForCheck();
      });
  }

  initializeQuestionStreams(host: Host): void {
    host.questions$ = this.quizDataService.getQuestionsForQuiz(host.quizId());
    host.questions$.subscribe((questions: QuizQuestion[]) => {
      if (!questions?.length) return;
      // Honour the URL-derived index that initializeQuestionIndex set
      // earlier in runOnInit. Hard-resetting to 0/questions[0] here
      // overwrote it on direct URL navigation to /question/.../3,
      // making Q3's view start with Q1's question and options.
      const currentIdx = host.currentQuestionIndex();
      const idx = Number.isFinite(currentIdx) && currentIdx >= 0
        ? currentIdx : 0;
      const safeIdx = idx < questions.length ? idx : 0;
      for (const [index] of questions.entries()) {
        this.quizStateService.setQuestionState(
          host.quizId(), index, this.quizStateService.createDefaultQuestionState()
        );
      }
      host.currentQuestionIndex.set(safeIdx);
      host.currentQuestion.set(questions[safeIdx]);
    });
  }

  loadQuizQuestionsForCurrentQuiz(host: Host): void {
    host.isQuizDataLoaded.set(false);
    this.quizDataService.getQuestionsForQuiz(host.quizId()).subscribe({
      next: (questions: QuizQuestion[]) => {
        this.applyQuestionsFromSession(host, questions);
        host.isQuizDataLoaded.set(true);
      },
      error: () => { host.isQuizDataLoaded.set(true); }
    });
  }

  createQuestionData(host: Host): void {
    const sub = this.quizContentLoaderService.createNormalizedQuestionPayload$()
      .subscribe((payload: QuestionPayload) => {
        host.combinedQuestionData.set(payload);
        host.questionToDisplaySig.set(payload.question?.questionText?.trim() ?? 'No question available');
        host.explanationToDisplay.set(payload.explanation ?? '');
        host.question.set(payload.question);
        host.currentQuestion.set(payload.question);
        host.optionsToDisplaySig.set([...payload.options]);
        host.cdRef.markForCheck();
      });
    host.subscriptions.add(sub);
  }

  // â”€â”€ Question state + answer handling â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async handleNavigationToQuestion(host: Host, questionIndex: number): Promise<void> {
    this.quizService.getCurrentQuestion(questionIndex).subscribe({
      next: (question: QuizQuestion | null) => {
        if (question?.type != null) this.quizDataService.setQuestionType(question);
        this.quizContentLoaderService.restoreSelectionState(host.currentQuestionIndex());
        this.nextButtonStateService.evaluateNextButtonState(
          this.selectedOptionService.isAnsweredSig(),
          this.quizStateService.isLoadingSig(),
          this.quizStateService.isNavigatingSig()
        );
      },
      error: () => { }
    });
  }

  async updateQuestionStateAndExplanation(host: Host, questionIndex: number): Promise<void> {
    const result = await this.quizContentLoaderService.evaluateQuestionStateAndExplanation({
      quizId: host.quizId(), questionIndex,
    });
    if (!result.handled) return;
    host.explanationToDisplay.set(result.explanationText);
    if (result.showExplanation) host.cdRef.markForCheck();
  }

  selectedAnswer(host: Host, optionIndex: number): void {
    const idx = host.currentQuestionIndex();
    host.markQuestionAnswered(idx);

    const result = this.quizContentLoaderService.processSelectedAnswer({
      optionIndex,
      question: host.question(),
      optionsToDisplay: host.optionsToDisplaySig(),
      currentQuestionIndex: idx,
      answers: host.answers()
    });

    if (!result.option) return;
    host.answers.set(result.answers);
    void this.updateQuestionStateAndExplanation(host, idx);
  }
}