import { inject, Injector, Service, signal, WritableSignal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { BehaviorSubject, firstValueFrom, from, Observable, of, Subject } from 'rxjs';
import { distinctUntilChanged, map } from 'rxjs/operators';

import { QuizStatus } from '../../models/quiz-status.enum';

import { FinalResult, toDurableFinalResult } from '../../models/Final-Result.model';
import { Option } from '../../models/Option.model';
import { QuestionPayload } from '../../models/QuestionPayload.model';
import { Quiz } from '../../models/Quiz.model';
import { QuizQuestion } from '../../models/QuizQuestion.model';
import { QuizScore } from '../../models/QuizScore.model';
import { QuizSelectionParams } from '../../models/QuizSelectionParams.model';
import { Resource } from '../../models/Resource.model';
import { SelectedOption } from '../../models/SelectedOption.model';

import { QuizAnswerEvaluationService } from './quiz-answer-evaluation.service';
import { QuizBannerService } from './quiz-banner.service';
import { QuizDataLoaderService } from './quiz-data-loader.service';
import { QuizOptionsService } from './quiz-options.service';
import { QuizQuestionEmitterService } from './quiz-question-emitter.service';
import { QuizQuestionResolverService } from './quiz-question-resolver.service';
import { QuizScoringService } from './quiz-scoring.service';
import { QuizSessionManagerService } from './quiz-session-manager.service';
import { QuizShuffleService } from '../flow/quiz-shuffle.service';
import { TopicQuizTypeRegistry } from '../api/topic-quiz-type-registry.service';
import { QuestionVerdictService } from '../features/verdict/question-verdict.service';
import { QuizStateService } from '../state/quizstate.service';

import { SK_SHUFFLED_QUESTIONS, SK_SHUFFLED_QUESTIONS_QUIZ_ID, SK_USER_ANSWERS } from '../../constants/session-keys';

import { getQuizData } from '../../quiz-data-cache';
import { isOptionCorrect } from '../../utils/is-option-correct';
import { norm } from '../../utils/text-norm';
import { swallow } from '../../utils/error-logging';

@Service()
export class QuizService {
  // ── injects ─────────────────────────────────────────────────────
  public readonly answerEvaluation = inject(QuizAnswerEvaluationService);
  public readonly bannerService = inject(QuizBannerService);
  public readonly dataLoader = inject(QuizDataLoaderService);
  public readonly optionsService = inject(QuizOptionsService);
  public readonly questionEmitter = inject(QuizQuestionEmitterService);
  public readonly questionResolver = inject(QuizQuestionResolverService);
  private readonly quizShuffleService = inject(QuizShuffleService);
  private readonly quizStateService = inject(QuizStateService);
  public readonly scoringService = inject(QuizScoringService);
  public readonly sessionManager = inject(QuizSessionManagerService);
  private readonly injector = inject(Injector);

  /**
   * Field-style accessor backed by currentQuestionIndexSig (the signal
   * source of truth) and currentQuestionIndexSubject (the sync BS
   * mirror added in commit 1f7ae3e0 to fix the FET flash bug).
   * Plain `quizService.currentQuestionIndex = X` writes route through
   * the setter so external writers always update both stores.
   */
  get currentQuestionIndex(): number { return this.currentQuestionIndexSig(); }
  set currentQuestionIndex(v: number) {
    this.currentQuestionIndexSig.set(v);
    this.currentQuestionIndexSubject.next(v);
  }
  activeQuiz: Quiz | null = null;
  quizInitialState: Quiz[] = structuredClone(getQuizData());
  quizData: Quiz[] | null = this.quizInitialState;
  data: {
    questionText: string,
    correctAnswersText?: string,
    currentOptions: Option[]
  } = {
      questionText: '',
      correctAnswersText: '',
      currentOptions: []
    };
  quizId = (() => {
    try { return localStorage.getItem('quizId') ?? ''; }
    catch (err: unknown) {
      console.error('QuizService.quizId localStorage read failed:', err);
      return '';
    }
  })();
  /**
   * SUPERSET completion: every required correct option has been selected.
   * Extra wrong picks do NOT clear it — that is the audited Topic Quiz rule.
   */
  /**
   * ── WHY THESE ARE SIGNALS ──────────────────────────────────────────
   *
   * These three were plain Maps, which was fine while every writer ran
   * synchronously on the click: the selection signals changed in the same turn,
   * so OnPush consumers re-rendered and happened to observe them.
   *
   * Completion now arrives ASYNCHRONOUSLY, from the authorized verdict. A plain
   * Map mutated in a subscription notifies nobody — the state was correct and
   * the DOM never looked again. That is what broke the option-item render
   * migration: grey-out, the visible score and the FET gate all read state that
   * had already arrived.
   *
   * Mutations must therefore produce a NEW Map identity. In-place `.set` on the
   * held Map would not notify, which is why the maps are private and reached
   * through the accessors below.
   */
  private readonly _multiAnswerCompletion = signal<ReadonlyMap<number, boolean>>(new Map());
  /** Reactive handle for computed/template use. */
  readonly multiAnswerCompletionSig = this._multiAnswerCompletion.asReadonly();

  /**
   * PERFECT: completion AND nothing incorrect selected.
   *
   * Strictly stronger than completion, so a wrong extra leaves this false while
   * completion is true. That difference is what keeps a wrong pick's red repaint
   * instead of greying it out with the losers.
   */
  private readonly _multiAnswerPerfect = signal<ReadonlyMap<number, boolean>>(new Map());
  readonly multiAnswerPerfectSig = this._multiAnswerPerfect.asReadonly();

  /**
   * The user's answer interaction for this question has reached a resolved
   * state — single or multi, right or wrong.
   *
   * This is the broad fact most consumers of the legacy union actually wanted:
   * "has this question been answered?" It deliberately does NOT mean the answer
   * was correct, that a multi-answer question is complete or perfect, that
   * auto-reveal painted, or that the timer expired. Those are separate facts
   * with their own state.
   *
   * INVARIANTS (each strictly stronger than the next):
   *
   *     multiAnswerPerfect ⊆ multiAnswerCompletion ⊆ questionResolved
   *
   * so a single-answer question can be resolved while both multi states stay
   * false — which is exactly the distinction the old union could not express.
   */
  private readonly _questionResolved = signal<ReadonlyMap<number, boolean>>(new Map());
  readonly questionResolvedSig = this._questionResolved.asReadonly();

  // ── Semantic accessors ─────────────────────────────────────────────
  // Reads are signal reads, so a consumer that calls one inside a computed or
  // an OnPush template is registered as a dependency and re-runs on arrival.

  isQuestionResolved(idx: number): boolean {
    return this._questionResolved().get(idx) === true;
  }
  isMultiAnswerComplete(idx: number): boolean {
    return this._multiAnswerCompletion().get(idx) === true;
  }
  isMultiAnswerPerfect(idx: number): boolean {
    return this._multiAnswerPerfect().get(idx) === true;
  }

  markQuestionResolved(idx: number): void {
    this.writeAnswerState(this._questionResolved, idx, true);
  }
  markMultiAnswerComplete(idx: number): void {
    this.writeAnswerState(this._multiAnswerCompletion, idx, true);
  }
  markMultiAnswerPerfect(idx: number): void {
    this.writeAnswerState(this._multiAnswerPerfect, idx, true);
  }

  /** New Map identity on every real change; a no-op write must not churn CD. */
  private writeAnswerState(
    target: WritableSignal<ReadonlyMap<number, boolean>>,
    idx: number,
    value: boolean
  ): void {
    if (target().get(idx) === value) return;
    const next = new Map(target());
    next.set(idx, value);
    target.set(next);
  }

  /** Clear one question's answer state across all three, on one boundary. */
  clearAnswerStateAt(idx: number): void {
    for (const target of [this._questionResolved, this._multiAnswerCompletion, this._multiAnswerPerfect]) {
      if (!target().has(idx)) continue;
      const next = new Map(target());
      next.delete(idx);
      target.set(next);
    }
  }

  /** Clear every question's answer state (quiz reset / switch). */
  clearAllAnswerState(): void {
    for (const target of [this._questionResolved, this._multiAnswerCompletion, this._multiAnswerPerfect]) {
      if (target().size === 0) continue;
      target.set(new Map());
    }
  }

  private _questions: QuizQuestion[] = [];

  // Scoring state delegated to QuizScoringService â€” getters for backwards compat
  public get questionCorrectness(): Map<number, boolean> {
    return this.scoringService.questionCorrectness;
  }
  public set questionCorrectness(val: Map<number, boolean>) {
    this.scoringService.questionCorrectness = val;
  }

  // Delegate to dataLoader's signal for single source of truth.
  private get currentQuizSig(): WritableSignal<Quiz | null> {
    return this.dataLoader.currentQuizSig;
  }
  private get currentQuiz$(): Observable<Quiz | null> {
    return this.dataLoader.currentQuiz$;
  }

  readonly questionsSig = signal<QuizQuestion[]>([]);
  questions$: Observable<QuizQuestion[]> = toObservable(this.questionsSig);

  private questionsQuizId: string | null = (() => {
    try { return localStorage.getItem(SK_SHUFFLED_QUESTIONS_QUIZ_ID); }
    catch (err: unknown) {
      console.error('QuizService.questionsQuizId localStorage read failed:', err);
      return null;
    }
  })();

  currentQuestionIndexSig = signal<number>(0);
  // Sync mirror so observable subscribers (displayText$, etc.) receive
  // index changes in the same microtask as the signal write â€” avoids the
  // toObservable() async lag that caused FET-to-q-text flicker on Next.
  currentQuestionIndexSubject = new BehaviorSubject<number>(0);
  currentQuestionIndex$: Observable<number> = this.currentQuestionIndexSubject.asObservable();

  selectedOptionsMap: Map<number, SelectedOption[]> = new Map();

  answers: Option[] = [];
  // Single source of truth: delegates to dataLoader so loadResourcesForQuiz()
  // doesn't have to mirror the value into a separate field.
  get resources(): Resource[] { return this.dataLoader.resources; }

  readonly totalQuestions = signal<number>(0);
  get correctCount(): number { return this.scoringService.correctCountSig(); }
  set correctCount(val: number) { this.scoringService.correctCountSig.set(val); }

  selectedQuiz: Quiz | null = null;
  selectedQuizSig = signal<Quiz | null>(null);
  selectedQuiz$: Observable<Quiz | null> = toObservable(this.selectedQuizSig);
  startedQuizId = '';
  continueQuizId = '';
  completedQuizId = '';
  quizCompleted = false;
  status = '';

  correctAnswers: Map<string, number[]> = new Map<string, number[]>();

  public get correctAnswersCountSig() {
    return this.scoringService.correctAnswersCountSig;
  }

  public get correctAnswersCountTextSig(): WritableSignal<string> {
    return this.bannerService.correctAnswersCountTextSig;
  }
  public get correctAnswersText$(): Observable<string> {
    return this.bannerService.correctAnswersText$;
  }

  multipleAnswer = false;

  currentQuestionSig = signal<QuizQuestion | null>(null);
  public currentQuestion$: Observable<QuizQuestion | null> =
    toObservable(this.currentQuestionSig);

  currentOptionsSig = signal<Option[]>([]);
  totalQuestions$: Observable<number> = toObservable(this.totalQuestions);

  readonly questionDataSig = signal<any>(null);
  questionData$ = toObservable(this.questionDataSig);

  private readonly shuffleEnabledSig = signal<boolean>(
    localStorage.getItem('checkedShuffle') === 'true'
  );
  checkedShuffle$ = toObservable(this.shuffleEnabledSig);

  public shuffledQuestions: QuizQuestion[] = (() => {
    try {
      // One-time purge of stale cache with corrupted correct flags
      if (!localStorage.getItem('_shuffleCacheV2')) {
        localStorage.removeItem(SK_SHUFFLED_QUESTIONS);
        localStorage.removeItem(SK_SHUFFLED_QUESTIONS_QUIZ_ID);
        localStorage.setItem('_shuffleCacheV2', '1');
        return [];
      }
      const stored = localStorage.getItem(SK_SHUFFLED_QUESTIONS);
      return stored ? JSON.parse(stored) : [];
    } catch (err: unknown) {
      console.error('QuizService.shuffledQuestions localStorage parse failed:', err);
      return [];
    }
  })();

  // Canonical question data is stored in dataLoader â€” access via getters below
  private get canonicalQuestionsByQuiz(): Map<string, QuizQuestion[]> {
    return this.dataLoader.getCanonicalQuestionsByQuiz();
  }
  private get canonicalQuestionIndexByText(): Map<string, Map<string, number>> {
    return this.dataLoader.getCanonicalQuestionIndexByText();
  }

  userAnswers: any[] = (() => {
    try { return JSON.parse(localStorage.getItem(SK_USER_ANSWERS) ?? '[]'); }
    catch (err: unknown) {
      console.error('QuizService.userAnswers localStorage parse failed:', err);
      return [];
    }
  })();
  optionsSource: Subject<Option[]> = new Subject<Option[]>();

  nextQuestionSig = signal<QuizQuestion | null>(null);
  nextQuestion$: Observable<QuizQuestion | null> = toObservable(this.nextQuestionSig);

  nextOptionsSig = signal<Option[]>([]);
  nextOptions$: Observable<Option[]> = toObservable(this.nextOptionsSig);

  public get badgeTextSig(): WritableSignal<string> {
    return this.bannerService.badgeTextSig;
  }
  public get badgeText(): Observable<string> {
    return this.bannerService.badgeText$;
  }

  readonly questionsLoadedSig = signal<boolean>(false);
  questionsLoaded$ = toObservable(this.questionsLoadedSig);

  private quizResetSource = new Subject<void>();
  quizReset$ = this.quizResetSource.asObservable();

  get score(): number { return this.scoringService.scoreSig(); }
  set score(val: number) { this.scoringService.scoreSig.set(val); }
  get quizScore(): QuizScore | null { return this.scoringService.quizScore; }
  set quizScore(val: QuizScore | null) { this.scoringService.quizScore = val; }
  get highScores(): QuizScore[] { return this.scoringService.highScores; }
  set highScores(val: QuizScore[]) { this.scoringService.highScores = val; }
  get highScoresLocal(): QuizScore[] { return this.scoringService.highScoresLocal; }
  set highScoresLocal(val: QuizScore[]) { this.scoringService.highScoresLocal = val; }

  questionPayloadSig = signal<QuestionPayload | null>(null);
  questionPayload$ = toObservable(this.questionPayloadSig).pipe(
    map((payload) => {
      if (!payload?.question) return payload;
      
      if (this.isShuffleEnabled() && this.shuffledQuestions?.length > 0) {
        const idx = this.currentQuestionIndex ?? 0;
        const correctQ = this.shuffledQuestions[idx];
        if (correctQ) {
          // ALWAYS use shuffled data when shuffle is active
          return {
            question: correctQ,
            options: correctQ.options ?? [],
            explanation: correctQ.explanation ?? ''
          };
        }
      }
      return payload;
    })
  );
  readonly finalResultSig = signal<FinalResult | null>(null);
  finalResult$ = toObservable(this.finalResultSig);

  private readonly _preReset$ = new Subject<number>();
  // Emitted with the target question index just before navigation hydrates it
  readonly preReset$ = this._preReset$.asObservable();

  constructor() {
    // Scoring state is loaded in QuizScoringService constructor (loadQuestionCorrectness)
    this.scoringService.restoreScoreFromPersistence(this.quizId);
    this.initializeData();

    // Reset State Sync
    // When quizReset$ emits (e.g. on Shuffle Toggle), clear the internal state cache
    // in QuizStateService. Otherwise, "isAnswered" state for index 0 persists across shuffles.
    this.quizReset$.subscribe(() => {
      this.quizStateService.reset();
    });
  }

  get questions() {
    // Sync Safeguard
    // Direct access to .questions should ALSO return shuffled data if active.
    // This fixes components (like CodelabQuizContentComponent) that read array indices directly.
    if (this.isShuffleEnabled() && this.shuffledQuestions.length > 0) {
      return this.shuffledQuestions;
    }
    return this._questions;
  }
  set questions(value: any) {
    // Prevent shuffled data from overwriting canonical _questions
    // Check if the incoming data is the shuffled array to prevent pollution
    const isIncomingShuffledData =
      this.shuffledQuestions.length > 0 &&
      Array.isArray(value) &&
      value.length > 0 &&
      value === this.shuffledQuestions;

    if (isIncomingShuffledData) {
      // Do NOT update _questions - the canonical data should remain unshuffled
      // But still emit the shuffled questions for subscribers
      this.questionsSig.set(this.shuffledQuestions);
      return;
    }

    this._questions = value;

    // Sync Safeguard
    // If shuffle is active and we have shuffled questions, DO NOT overwrite with incoming (likely unshuffled) data.
    // Instead, re-emit the shuffled questions to keep everyone in sync.
    // Use isShuffleEnabled() instead of checkedShuffle property
    if (this.isShuffleEnabled() && this.shuffledQuestions.length > 0) {
      this.questionsSig.set(this.shuffledQuestions);
      this.questionsQuizId = this.quizId ?? null;
    } else {
      this.questionsSig.set(value);
      this.questionsQuizId = this.quizId ?? null;
    }
  }

  initializeData(): void {
    const result = this.dataLoader.initializeData(this.quizId);

    this.quizId = result.resolvedQuizId;
    this.questions = result.questions;
    this.totalQuestions.set(result.totalQuestions);
    this.quizData = this.dataLoader.quizData;
    this.quizInitialState = this.dataLoader.quizInitialState;

    // Fetch this quiz's DECLARED question types alongside the local content.
    //
    // Question content still comes from the local bank in this transitional
    // slice; only the type comes from the API. That matters because type is
    // currently derived by counting correct options, which makes it an
    // answer-key derivative — and the local bank carries no `type` field at
    // all, so there is nothing else to read.
    //
    // Fire-and-forget: the registry answers `null` until the response lands,
    // and every consumer keeps its existing inference as a fallback, so a slow
    // or failed load changes nothing. Resolved lazily to avoid a DI cycle —
    // the registry's HTTP stack would otherwise be constructed with QuizService.
    try {
      this.injector.get(TopicQuizTypeRegistry, null)?.load(this.quizId).subscribe();
    } catch (err: unknown) { swallow('quiz.service.ts type-registry load', err); }
  }

  public setActiveQuiz(quiz: Quiz): void {
    this.activeQuiz = quiz;
    this.quizId = quiz.quizId;
    // When shuffle is active, emit shuffled questions to subscribers so
    // host.questionsArray doesn't get poisoned with unshuffled data.
    if (this.isShuffleEnabled() && this.shuffledQuestions.length > 0) {
      this.questionsSig.set(this.shuffledQuestions);
    } else {
      this.questionsSig.set(quiz.questions ?? []);
    }
    this.questionsQuizId = quiz.quizId;
    this.questions = quiz.questions ?? [];
    this.totalQuestions.set((quiz.questions ?? []).length);

    // Load resources for this quiz
    this.loadResourcesForQuiz(quiz.quizId);

    // Push quiz into the source-of-truth signal
    this.currentQuizSig.set(quiz);
  }

  // Load resources for a specific quiz ID. `resources` is a getter that
  // delegates to dataLoader, so no mirror assignment is needed.
  loadResourcesForQuiz(quizId: string): void {
    this.dataLoader.loadResourcesForQuiz(quizId);
  }

  getActiveQuiz(): Quiz | null {
    return this.activeQuiz;
  }

  setCurrentQuiz(q: Quiz): void {
    this.activeQuiz = q;
    this.currentQuizSig.set(q);
    if (q?.quizId) this.quizId = q.quizId;
    
    if (Array.isArray(q?.questions)) {
      // When shuffle is active, do NOT emit unshuffled questions to subscribers.
      // That causes questionsArray in QuizComponent to briefly hold unshuffled
      // data, which downstream code reads as the display question source.
      if (this.isShuffleEnabled() && this.shuffledQuestions.length > 0) {
        this.questionsSig.set(this.shuffledQuestions);
      } else {
        this.questionsSig.set(q.questions);
      }
      this.questionsQuizId = q.quizId;
      this.questions = q.questions;
      this.totalQuestions.set(q.questions.length);
    }
  }

  getCurrentQuizId(): string {
    return this.quizId;
  }

  setSelectedQuiz(selectedQuiz: Quiz): void {
    this.selectedQuizSig.set(selectedQuiz);
    this.selectedQuiz = selectedQuiz;
  }

  setQuizId(id: string): void {
    if (id && this.questionsQuizId && this.questionsQuizId !== id) {
      this.questionsSig.set([]);
      this.questionsQuizId = null;
      this.questions = [];
      this.shuffledQuestions = [];
    }
    this.quizId = id;
  }

  setQuizStatus(value: QuizStatus): void {
    // Hard lock: once completed, status is immutable
    if (this.quizCompleted && value === QuizStatus.CONTINUE) {
      return;
    }

    this.status = value;
  }

  setCompletedQuizId(value: string) {
    this.completedQuizId = value;
  }

  // Return a sanitized array of options for the given question index.
  getOptions(index: number): Observable<Option[]> {
    return this.optionsService.getOptions(
      index,
      (idx) => this.getQuestionByIndex(idx),
      this.currentOptionsSig
    );
  }

  getQuestionByIndex(index: number): Observable<QuizQuestion | null> {
    return this.questionResolver.getQuestionByIndex(
      index,
      () => this.resolveShuffleQuizId(),
      (idx, q) => this.resolveCanonicalQuestion(idx, q),
      () => this.isShuffleEnabled(),
      this.shuffledQuestions,
      this.questions$
    );
  }

  getQuestionsInDisplayOrder(): QuizQuestion[] {
    const shuffled = this.shuffledQuestions ?? [];
    return this.isShuffleEnabled() && shuffled.length
      ? shuffled : (this.questions ?? []);
  }

  /**
   * The single question shown at a display index — shuffle-aware. Prefer this
   * over indexing a raw array by a display index: it states the intent ("the
   * question the user sees at position i") and resolves through
   * getQuestionsInDisplayOrder, so shuffled and unshuffled both land on the
   * right question. Returns undefined when out of range / no questions.
   */
  getDisplayedQuestion(index: number): QuizQuestion | undefined {
    return this.getQuestionsInDisplayOrder()?.[index];
  }

  async fetchQuizQuestions(quizId: string): Promise<QuizQuestion[]> {
    // Ask the API what TYPE each question is before anything renders. The local
    // bank declares `type` on none of its questions, so every consumer that
    // checks `question.type` has been falling through to counting correct
    // options — which makes question type an answer-key derivative. Loading
    // here, at the one place questions are materialised, fixes that for all of
    // them at once.
    //
    // Deliberately not fatal: this is a TRANSITIONAL slice and type is not
    // correctness, so an unreachable API must leave the quiz playable on the
    // existing count-based fallback. That stops being true at the /questions
    // content cutover, when a failed load means there are no questions at all.
    // Resolved lazily, like the load at `setQuizData` — a constructor-injected
    // registry would drag its HTTP stack into QuizService's own construction.
    let registry: TopicQuizTypeRegistry | null = null;
    let typesLoaded: Promise<unknown> = Promise.resolve();
    try {
      registry = this.injector.get(TopicQuizTypeRegistry, null);
      if (registry) {
        // `load` is cached per quiz, so this rides on the in-flight request the
        // setQuizData path already started rather than issuing a second one.
        typesLoaded = firstValueFrom(registry.load(quizId)).catch(() => undefined);
      }
    } catch (err: unknown) { swallow('quiz.service.ts type-registry load', err); }

    const questions = await this.dataLoader.fetchQuizQuestions(
      quizId,
      this.questionsSig,
      (qs) => { this._questions = qs; }
    );

    // Awaited, unlike the fire-and-forget load at setQuizData: stamping after
    // the questions render would leave the first question mid-flight on the
    // count-based fallback, which is the race this slice exists to close.
    await typesLoaded;
    registry?.applyDeclaredTypes(questions);

    // RESTORE WHAT THIS SESSION ALREADY EARNED.
    //
    // The verdict store is in memory, so a reload empties it and the UI used to
    // repaint an already-answered question from the bundled answer key — the
    // last correctness dependency on that asset.
    //
    // Deliberately here and not earlier: rehydration is validated against the
    // CURRENT question set, so it can only run once `/questions` has answered.
    // A persisted entry for a question this quiz no longer serves is dropped,
    // and a live in-memory verdict always wins over a persisted one.
    //
    // Resolved lazily for the same reason as the registry above — constructing
    // the verdict service eagerly here would pull its HTTP stack into
    // QuizService's own construction.
    try {
      this.injector
        .get(QuestionVerdictService, null)
        ?.rehydrateEarnedVerdicts(quizId, questions.map((q) => q?.questionText ?? ''));
    } catch (err: unknown) { swallow('quiz.service.ts earned-verdict rehydrate', err); }

    this.quizId = quizId;
    this.totalQuestions.set(questions.length);
    return questions;
  }

  getAllQuestions(): Observable<QuizQuestion[]> {
    // Prioritize shuffled questions if they exist!
    if (this.shuffledQuestions && this.shuffledQuestions.length > 0) {
      return of(this.shuffledQuestions);
    }

    if (this.questionsSig().length === 0) {
      // Delegate to fetchQuizQuestions which handles normalization AND shuffling!
      // This prevents getAllQuestions from returning raw/unshuffled data that bypasses the shuffle logic.
      return from(this.fetchQuizQuestions(this.quizId));
    }
    return this.questions$;
  }

  getQuestionData(
    quizId: string,
    questionIndex: number
  ): {
    questionText: string;
    currentOptions: Option[];
  } | null {
    const currentQuiz = (this.quizData ?? []).find(
      (quiz) => quiz.quizId === quizId
    );

    const questions = currentQuiz?.questions ?? [];
    if (questions.length > questionIndex) {
      const currentQuestion = questions[questionIndex];

      return {
        questionText: currentQuestion.questionText ?? '',
        currentOptions: currentQuestion.options
      };
    }

    return null;
  }

  public setCurrentQuestion(question: QuizQuestion): void {
    if (!question) return;

    const previousQuestion = this.currentQuestionSig();
    if (
      previousQuestion &&
      question &&
      previousQuestion.questionText === question.questionText &&
      previousQuestion.options?.length === question.options?.length &&
      previousQuestion.explanation === question.explanation
    ) return;
    if (!Array.isArray(question.options) || question.options.length === 0) return;

    const updatedOptions = question.options.map((option, index) => ({
      ...option,
      optionId: option.optionId ?? index,
      // PRESERVE ABSENCE. `option.correct ?? false` turns "nobody has said" into
      // "this option is WRONG" for every API-sourced option, and the result is
      // published to `currentQuestionSig`, which consumers read as live state.
      ...(option.correct === undefined ? {} : { correct: isOptionCorrect(option) }),
      selected: option.selected ?? false,
      active: option.active ?? true,
      showIcon: option.showIcon ?? false
    }));

    this.currentQuestionSig.set({ ...question, options: updatedOptions });
  }

  public getCurrentQuestion(
    questionIndex: number,
  ): Observable<QuizQuestion | null> {
    return this.questionResolver.getCurrentQuestion(questionIndex, this.questions);
  }

  public getLastKnownOptions(): Option[] {
    return this.currentQuestionSig()?.options || [];
  }

  // Get the current options for the current quiz and question
  getCurrentOptions(
    questionIndex: number = this.currentQuestionIndex ?? 0
  ): Observable<Option[]> {
    return this.optionsService.getCurrentOptions(
      questionIndex,
      (idx) => this.getQuestionByIndex(idx)
    );
  }

  setCurrentQuestionIndex(idx: number) {
    const safeIndex = Number.isFinite(idx) ? Math.max(0, Math.trunc(idx)) : 0;

    // Conditionally wipe the answer state at [safeIndex] — ONLY clear if
    // the user did NOT actually answer the question correctly on the
    // prior visit. Genuinely-correct answers should preserve their
    // green/disabled visual on revisit. We check by comparing
    // selectedOptionsMap[idx] selections against the question's
    // canonical correct texts.
    // Short-circuit on RESOLVED: nothing to wipe unless the question was
    // recorded as answered. It is written at exactly the sites the legacy union
    // is, so this triggers on precisely the same visits as before.
    const _before = this.isQuestionResolved(safeIndex) ? true : undefined;
    if (_before === true) {
      try {
        const _selections = this.selectedOptionsMap.get(safeIndex) ?? [];
        const _question = this.questions?.[safeIndex];
        const _correctTexts = new Set(
          (_question?.options ?? [])
            .filter((o: Option) => isOptionCorrect(o))
            .map((o: Option) => norm(o?.text))
            .filter((t: string) => !!t)
        );
        const _selectedTexts = new Set(
          _selections
            .map((s: SelectedOption) => norm(s?.text))
            .filter((t: string) => !!t)
        );
        const _userAnsweredCorrectly =
          _correctTexts.size > 0 &&
          [...(_correctTexts as Set<string>)].every((t: string) => _selectedTexts.has(t));
        // Trust the durable scoring map as a fallback when selections are
        // empty (they can be transiently cleared on navigation). If the
        // question is recorded correct AND the multi-perfect flag is set,
        // keep the flag — don't wipe it just because selectedOptionsMap
        // was cleared elsewhere.
        const _scored = this.questionCorrectness?.get?.(safeIndex) === true;
        if (!_userAnsweredCorrectly && !_scored) {
          this.wipeCompletionStateAt(safeIndex);
        }
      } catch (err: unknown) {
        console.error('QuizService.setCurrentQuestionIndex answer-state check failed:', err);
        // If the check fails for any reason, fall back to clearing
        // (safer than leaving a possibly-stale flag set).
        this.wipeCompletionStateAt(safeIndex);
      }
    }

    // Setter routes to both currentQuestionIndexSig and ...Subject.
    this.currentQuestionIndex = safeIndex;

    // Restore answers from persistence if available to prevent score decrement on navigation
    const prevSelected = this.selectedOptionsMap.get(safeIndex);

    if (prevSelected && prevSelected.length > 0) {
      // Re-hydrate full Option objects (needing .correct flag) from the source question
      const question = this.questions[safeIndex];  // use getter (handles shuffle)
      if (question && question.options) {
        const selectedIds = new Set(prevSelected.map(s => s.optionId));
        // text-match fallback for robustness
        const restoredAnswers = question.options.filter((o: Option) =>
          selectedIds.has(o.optionId) ||
          prevSelected.some(s => (s.text || '').trim() === (o.text || '').trim())
        );
        this.answers = restoredAnswers;
      } else {
        this.answers = [];
      }
    } else {
      this.answers = [];
    }
  }

  getCurrentQuestionIndex(): number {
    return this.currentQuestionIndexSig();
  }

  /**
   * Canonical "what question is the user on right now" resolver.
   *
   * Prefers the caller's component-input value (which the URL-authoritative
   * parent feeds down) over the service value, because `currentQuestionIndex`
   * on this service can lag or briefly reset to 0 during re-initialization
   * (signal hydration, route resolver, BehaviorSubject defaults).
   *
   * Falls back to the service value, then 0, when no input is available
   * (e.g. service callsites that don't have a component input).
   */
  resolveActiveQuestionIndex(inputIdx?: number | null): number {
    if (typeof inputIdx === 'number' && inputIdx >= 0) return inputIdx;
    const svcIdx = this.getCurrentQuestionIndex();
    if (typeof svcIdx === 'number' && svcIdx >= 0) return svcIdx;
    return Number.isFinite(this.currentQuestionIndex) && this.currentQuestionIndex >= 0
      ? this.currentQuestionIndex : 0;
  }

  getCurrentQuestionIndexObservable(): Observable<number> {
    return this.currentQuestionIndex$;
  }

  updateCurrentQuestionIndex(index: number): void {
    this.currentQuestionIndex = index;
  }

  updateBadgeText(questionIndex: number, totalQuestions: number): void {
    this.bannerService.updateBadgeText(questionIndex, totalQuestions);
  }
  updateCorrectAnswersText(newText: string): void {
    this.bannerService.updateCorrectAnswersText(newText);
  }
  clearStoredCorrectAnswersText(): void {
    this.bannerService.clearStoredCorrectAnswersText();
  }

  isAnswered(questionIndex: number): Observable<boolean> {
    const options = this.selectedOptionsMap.get(questionIndex) ?? [];
    const isAnswered = options.length > 0;
    return of(isAnswered);
  }

  getTotalQuestionsCount(quizId: string): Observable<number> {
    return this.currentQuiz$.pipe(
      map((quiz) => {
        // Try to get count from the emitted quiz object
        if (quiz && quiz.quizId === quizId) {
          return quiz.questions?.length ?? 0;
        }

        // Fallback: If quiz object missing (e.g. cached/shuffled session), check active state
        // Validation of IDs proved flaky. If we have active questions, return their count.
        if (Array.isArray(this.questions) && this.questions.length > 0) {
          return this.questions.length;
        }

        return 0;
      }),
      distinctUntilChanged()
    );
  }

  getCorrectAnswersAsString(): string {
    return Array.from(this.correctAnswers.values())
      .map((a) => a.join(','))
      .join(';');
  }

  updateAnswersForOption(selectedOption: Option): void {
    if (!this.answers) this.answers = [];

    const isOptionSelected = this.answers.some(
      (answer: Option) => answer.optionId === selectedOption.optionId
    );
    if (!isOptionSelected) this.answers.push(selectedOption);

    const answerIds = this.answers
      .map((answer: Option) => answer.optionId)
      .filter((id): id is number => id !== undefined);

    // Update the persistent userAnswers array for the current question
    if (this.currentQuestionIndex >= 0) {
      if (!this.userAnswers) this.userAnswers = [];
      this.userAnswers[this.currentQuestionIndex] = answerIds;
    }
  }


  returnQuizSelectionParams(): QuizSelectionParams {
    return {
      startedQuizId: this.startedQuizId,
      continueQuizId: this.continueQuizId,
      completedQuizId: this.completedQuizId,
      quizCompleted: this.quizCompleted,
      status: this.status
    };
  }

  setQuestionsLoaded(state: boolean): void {
    this.questionsLoadedSig.set(state);
  }

  saveHighScores(): void {
    this.scoringService.saveHighScores(this.quizId, this.totalQuestions());
  }

  recordCompletedQuizScore(quizId: string, score: number, totalQuestions: number, attemptId: string): void {
    this.scoringService.recordCompletedQuizScore(quizId, score, totalQuestions, attemptId);
  }

  startNewAttempt(): string {
    return this.scoringService.startNewAttempt();
  }

  getCurrentAttemptId(): string {
    return this.scoringService.getCurrentAttemptId();
  }

  calculatePercentageOfCorrectlyAnsweredQuestions(): number {
    return this.scoringService.calculatePercentageOfCorrectlyAnsweredQuestions(this.totalQuestions());
  }

  isShuffleEnabled(): boolean {
    return this.shuffleEnabledSig();
  }

  // Expose sub-services for direct access by consumers that need them
  get quizDataLoader(): QuizDataLoaderService { return this.dataLoader; }
  get quizQuestionResolver(): QuizQuestionResolverService {
    return this.questionResolver;
  }
  get quizOptions(): QuizOptionsService { return this.optionsService; }
  get quizScoring(): QuizScoringService { return this.scoringService; }

  setCheckedShuffle(isChecked: boolean): void {
    this.shuffleEnabledSig.set(isChecked);
    try {
      localStorage.setItem('checkedShuffle', String(isChecked));

      // Clear stale shuffledQuestions from localStorage to prevent mismatch
      localStorage.removeItem(SK_SHUFFLED_QUESTIONS);
      localStorage.removeItem(SK_SHUFFLED_QUESTIONS_QUIZ_ID);
    } catch (err: unknown) { swallow('quiz.service.ts', err); }

    // Clear shuffle state on toggle to ensure fresh shuffle
    // This prevents stale shuffled data from being used when toggling
    this.quizShuffleService.clearAll();
    this.shuffledQuestions = [];

    // Also clear basic questions to force a fresh fetch/shuffle cycle
    this.questions = [];
    this.questionsSig.set([]);
    this.questionsQuizId = null;

    // Reset score when shuffle is toggled to clear stale questionCorrectness.
    // Otherwise, questions might be marked as "already correct" from previous sessions.
    this.resetScore();

    this.quizId = '';
  }

  setCanonicalQuestions(
    quizId: string,
    questions: QuizQuestion[] | null | undefined
  ): void {
    this.dataLoader.setCanonicalQuestions(
      quizId,
      questions,
      (q, idx) => this.questionResolver.cloneQuestionForSession(q, idx),
      (text) => this.dataLoader.normalizeQuestionText(text)
    );
  }

  /**
   * Returns a PRISTINE version of the question from the canonical cache.
   * This version has not been shuffled or mutated by user interactions.
   * @param index The original (unshuffled) index of the question.
   */
  public getPristineQuestion(index: number): QuizQuestion | null {
    return this.dataLoader.getPristineQuestion(
      this.quizId,
      index,
      (q, idx) => this.questionResolver.cloneQuestionForSession(q, idx)
    );
  }

  /**
   * Lazy O(1) lookup of the pristine question object for a given live
   * questionText (matched case-insensitive after trim). Returns null on
   * cache miss. Backed by a single lazy-built Map over `quizInitialState`
   * so callers don't re-scan the bundle on every click.
   */
  public getPristineQuestionByText(
    questionText: string | null | undefined
  ): QuizQuestion | null {
    const key = norm(questionText);
    if (!key) return null;
    if (!this._pristineByQText) {
      this._pristineByQText = this.buildPristineByTextCache();
    }
    return this._pristineByQText.get(key) ?? null;
  }

  /**
   * Lazy O(1) lookup of pristine correct option texts for a given live
   * questionText. Replaces the nested `for (quiz) for (question)` scan
   * over `quizInitialState` that was being run inside hot template
   * methods (isDisabled / getOptionBackgroundColor / etc.) on every CD
   * cycle for every option-item â€” easily thousands of string compares
   * per click. Derived on-demand from the pristine-by-text cache and
   * memoized so repeat lookups are also O(1).
   */
  public getPristineCorrectTextsForQuestion(
    questionText: string | null | undefined
  ): Set<string> {
    const key = norm(questionText);
    if (!key) return new Set();
    if (!this._correctTextsByQText) this._correctTextsByQText = new Map();
    const cached = this._correctTextsByQText.get(key);
    if (cached) return cached;
    const pq = this.getPristineQuestionByText(questionText);
    if (!pq) {
      const empty = new Set<string>();
      this._correctTextsByQText.set(key, empty);
      return empty;
    }
    const texts = new Set<string>();
    for (const opt of (pq as any).options ?? []) {
      if (isOptionCorrect(opt?.correct)) {
        const txt = norm(opt?.text);
        if (txt) texts.add(txt);
      }
    }
    this._correctTextsByQText.set(key, texts);
    return texts;
  }

  /**
   * Lazy O(1) lookup of the full pristine correct Option[] for a given live
   * questionText. Same memoization strategy as the texts helper; returns the
   * actual Option references (not clones) so callers needing full option
   * objects don't have to re-walk quizInitialState.
   */
  public getPristineCorrectOptionsForQuestion(
    questionText: string | null | undefined
  ): Option[] {
    const key = norm(questionText);
    if (!key) return [];
    if (!this._correctOptionsByQText) this._correctOptionsByQText = new Map();
    const cached = this._correctOptionsByQText.get(key);
    if (cached) return cached;
    const pq = this.getPristineQuestionByText(questionText);
    if (!pq) {
      const empty: Option[] = [];
      this._correctOptionsByQText.set(key, empty);
      return empty;
    }
    const opts = ((pq as any).options ?? []).filter(
      (o: any) => isOptionCorrect(o)
    ) as Option[];
    this._correctOptionsByQText.set(key, opts);
    return opts;
  }

  /**
   * Convenience: number of pristine correct options for a given live
   * questionText. Derived from the cached correct-options helper.
   */
  public getPristineCorrectCountForQuestion(
    questionText: string | null | undefined
  ): number {
    return this.getPristineCorrectOptionsForQuestion(questionText).length;
  }

  private _pristineByQText: Map<string, QuizQuestion> | null = null;
  private _correctTextsByQText: Map<string, Set<string>> | null = null;
  private _correctOptionsByQText: Map<string, Option[]> | null = null;

  private buildPristineByTextCache(): Map<string, QuizQuestion> {
    const cache = new Map<string, QuizQuestion>();
    for (const quiz of this.quizInitialState ?? []) {
      for (const pq of quiz?.questions ?? []) {
        const key = norm(pq?.questionText);
        if (!key || cache.has(key)) continue;
        cache.set(key, pq as QuizQuestion);
      }
    }
    return cache;
  }

  applySessionQuestions(quizId: string, questions: QuizQuestion[]): void {
    const newQuizId = this.sessionManager.applySessionQuestions(
      this, quizId, questions,
      this.questionsSig, this.quizResetSource
    );
    if (newQuizId) {
      this.questionsQuizId = newQuizId;
      // Update the source-of-truth signal from the now-mutated activeQuiz
      if (this.activeQuiz) {
        this.currentQuizSig.set(this.activeQuiz);
      }
    }
  }

  resetQuestions(): void {
    this.sessionManager.resetQuestions(this);
  }

  // Ensure quiz ID exists, retrieving it if necessary
  async ensureQuizIdExists(): Promise<boolean> {
    const result = await this.dataLoader.ensureQuizIdExists(this.quizId);
    if (result.resolvedId && result.resolvedId !== this.quizId) {
      this.quizId = result.resolvedId;
    }
    return result.exists;
  }

  updateUserAnswer(questionIndex: number, answerIds: number[]): void {
    this.userAnswers[questionIndex] = answerIds;
    try {
      localStorage.setItem(SK_USER_ANSWERS, JSON.stringify(this.userAnswers));
    } catch (err: unknown) {
      console.error('QuizService.updateUserAnswer localStorage write failed:', err);
    }

    let question = this.questions[questionIndex];
    if (this.isShuffleEnabled() && this.quizId) {
      const resolved = this.resolveCanonicalQuestion(questionIndex, null);
      if (resolved) question = resolved;
    }

    this.answers = this.answerEvaluation.resolveAnswerOptions(
      answerIds,
      question,
      questionIndex,
      this.isShuffleEnabled()
    );

    if (!this.isShuffleEnabled()) {
      this.checkIfAnsweredCorrectly(questionIndex, false);
    }
  }

  async checkIfAnsweredCorrectly(index: number = -1, updateScore: boolean = false): Promise<boolean> {
    const qIndex = index >= 0 ? index : this.currentQuestionIndex;

    let currentQuestionValue: QuizQuestion | null = null;
    if (this.isShuffleEnabled()) {
      const resolved = this.resolveCanonicalQuestion(qIndex, null);
      if (resolved) currentQuestionValue = resolved;
    } else {
      currentQuestionValue = this.questions[qIndex] ?? this.currentQuestionSig();
    }

    if (!currentQuestionValue) return false;

    const storedAnswerIds = Array.isArray(this.userAnswers[qIndex])
      ? (this.userAnswers[qIndex] as number[]) : [];

    const result = await this.answerEvaluation.evaluateCorrectness(
      qIndex,
      currentQuestionValue,
      storedAnswerIds
    );

    this.multipleAnswer = result.multipleAnswer;
    this.answers = result.resolvedAnswers;

    if (updateScore && result.answerIds.length > 0) {
      this.incrementScore(result.answerIds, result.isCorrect, this.multipleAnswer, qIndex);
    }

    return result.isCorrect;
  }

  // `scoreDirectly()` is GONE, along with the `verifyScoreAgainstPristine`
  // guard it ran first.
  //
  // It took an `isCorrect` its callers had already decided from the local
  // answer key, then cross-checked that decision against the bank before
  // crediting — an answer-key gate protecting an answer-key claim. Ten call
  // sites across six services fed it, and every one of them has been removed:
  // Topic Quiz score credit now comes only from
  // QuizScoringService.creditResolvedQuestion, applied when the authorized
  // verdict arrives.
  //
  // Deleted rather than left callable. Removing only the guard would have left
  // an UNGUARDED path that still scores from whatever correctness a caller
  // decided locally, which is strictly worse than what was there before.

  incrementScore(
    answers: number[],
    correctAnswerFound: boolean,
    isMultipleAnswer: boolean,
    questionIndex: number = -1
  ): void {
    const qIndex = questionIndex >= 0 ? questionIndex : this.currentQuestionIndex;
    this.scoringService.incrementScore(
      answers, correctAnswerFound, isMultipleAnswer, qIndex, this.isShuffleEnabled(), this.quizId
    );
  }

  resetScore(): void {
    this.scoringService.resetScore(this.quizId);
  }

  sendCorrectCountToResults(value: number): void {
    this.scoringService.sendCorrectCountToResults(value, this.quizId);
  }

  resetQuizSessionState(): void {
    this.sessionManager.resetQuizSessionState(this, this.quizResetSource);
    this.questionsQuizId = null;
  }

  resetAll(): void {
    this.sessionManager.resetAll(this, this.quizResetSource);
    // Tail items not on the QuizSessionState interface â€” kept here so the
    // session manager doesn't need to know about dataLoader internals or
    // private QuizService fields.
    this.questionsQuizId = null;
    this.dataLoader.clearFetchPromise();
    this.clearAllAnswerState();
  }

  /**
   * Clear every answer state for one question, on one boundary.
   *
   * The three states must never disagree about whether a question is still
   * answered — a survivor would be exactly the kind of stale flag the
   * conditional wipe above exists to remove.
   */
  private wipeCompletionStateAt(idx: number): void {
    this.clearAnswerStateAt(idx);
  }

  private resolveShuffleQuizId(): string | null {
    return this.quizId 
      || this.activeQuiz?.quizId 
      || this.selectedQuiz?.quizId || null;
  }

  private resolveCanonicalQuestion(
    index: number,
    currentQuestion?: QuizQuestion | null
  ): QuizQuestion | null {
    return this.questionEmitter.resolveCanonicalQuestion(
      index,
      currentQuestion ?? null,
      this.quizId,
      this.activeQuiz?.quizId ?? null,
      this.selectedQuiz?.quizId ?? null,
      () => this.isShuffleEnabled(),
      () => this.isShuffleEnabled(),
      this.shuffledQuestions,
      this.canonicalQuestionsByQuiz,
      this.canonicalQuestionIndexByText,
      this.questions
    );
  }

  emitQuestionAndOptions(
    currentQuestion: QuizQuestion,
    options: Option[],
    indexOverride?: number
  ): void {
    const canonical = this.isShuffleEnabled()
      ? null
      : this.resolveCanonicalQuestion(
          Number.isFinite(indexOverride as number)
            ? Math.max(0, Math.trunc(indexOverride as number))
            : Math.max(0, Math.trunc(this.currentQuestionIndex ?? 0)),
          currentQuestion
        );

    const result = this.questionEmitter.prepareQuestionAndOptions(
      currentQuestion,
      options,
      this.currentQuestionIndex,
      indexOverride,
      this.isShuffleEnabled(),
      canonical
    );

    if (!result) return;

    // Emit to individual subjects
    this.nextQuestionSig.set(result.questionToEmit);
    this.updateCurrentQuestion(result.questionToEmit);
    this.nextOptionsSig.set(result.optionsToUse);

    // Emit the combined payload
    this.questionPayloadSig.set({
      question: result.questionToEmit,
      options: result.optionsToUse,
      explanation: result.questionToEmit.explanation ?? ''
    });
  }

  // When the service receives a new question (usually in a method
  // that loads the next question), push the text into the source:
  public updateCurrentQuestion(_question: QuizQuestion): void {
    // Kept as an extension point; callers notify QuizService of question changes
  }

  /**
   * Clears any cached question payloads so a stale value from a previous
   * run cannot leak into a freshly loaded quiz.
   */
  resetQuestionPayload(): void {
    this.questionPayloadSig.set(null);
  }

  getFinalResultSnapshot(): FinalResult | null {
    // Prefer in-memory snapshot
    const live = this.finalResultSig();
    if (live) return live;

    // Fallback to sessionStorage (tab switch / reload safe)
    try {
      const raw = sessionStorage.getItem('finalResult');
      if (!raw) return null;

      // Scrubbed on READ as well as on write, so entries persisted by earlier
      // builds stop handing back an answer key. Parsing never fails on them —
      // the summary fields are unchanged — the reveal is simply dropped.
      const parsed = JSON.parse(raw) as FinalResult;
      return toDurableFinalResult(parsed);
    } catch (err: unknown) {
      console.error('QuizService.getFinalResultSnapshot sessionStorage parse failed:', err);
      return null;
    }
  }

  clearFinalResult(): void {
    this.finalResultSig.set(null);
    try {
      sessionStorage.removeItem('finalResult');
    } catch (err: unknown) { swallow('quiz.service.ts', err); }
  }

  /**
   * Backfills the persisted result snapshot's elapsed time from a known-good
   * LIVE reading (captured while the timer is still populated, on fresh
   * completion). The results-page builder can race the timer and store 0; this
   * lets the statistics view — which reads the live timer AFTER it's populated —
   * repair the snapshot so a later revisit shows the real elapsed time. No-op
   * for non-positive values or when there is no snapshot to patch.
   */
  patchFinalResultCompletionTime(completionTime: number): void {
    if (!(completionTime > 0)) return;
    const snapshot = this.getFinalResultSnapshot();
    if (!snapshot) return;
    if (snapshot.completionTime && snapshot.completionTime > 0) return;

    const patched: FinalResult = { ...snapshot, completionTime };
    if (this.finalResultSig()) this.finalResultSig.set(patched);
    try {
      sessionStorage.setItem('finalResult', JSON.stringify(patched));
    } catch (err: unknown) { swallow('quiz.service.ts', err); }
  }

  resetQuizSessionForNewRun(quizId: string): void {
    this.sessionManager.resetQuizSessionForNewRun(this, quizId);
  }
}