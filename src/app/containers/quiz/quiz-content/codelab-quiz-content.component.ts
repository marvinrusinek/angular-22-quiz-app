import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  computed,
  contentChild,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  OnInit,
  output,
  Renderer2,
  SecurityContext,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { DomSanitizer } from '@angular/platform-browser';

import { ActivatedRoute, ParamMap } from '@angular/router';
import { BehaviorSubject, Observable, of, Subscription } from 'rxjs';

import { CombinedQuestionDataType } from '../../../shared/models/CombinedQuestionDataType.model';
import { Option } from '../../../shared/models/Option.model';
import { QuizQuestion } from '../../../shared/models/QuizQuestion.model';

import { CqcOrchestratorService } from '../../../shared/services/features/quiz-content/cqc-orchestrator.service';
import {
  ExplanationTextService,
  FETPayload,
} from '../../../shared/services/features/explanation/explanation-text.service';
import { QuizContentDisplayService } from '../../../shared/services/features/quiz-content/quiz-content-display.service';
import { QuizDataService } from '../../../shared/services/data/quizdata.service';
import { QuizNavigationService } from '../../../shared/services/flow/quiz-navigation.service';
import { QuizQuestionManagerService } from '../../../shared/services/flow/quizquestionmgr.service';
import { QuizService } from '../../../shared/services/data/quiz.service';
import { QuizStateService } from '../../../shared/services/state/quizstate.service';
import { SelectedOptionService } from '../../../shared/services/state/selectedoption.service';
import { TimerService } from '../../../shared/services/features/timer/timer.service';
import { FeedbackPolicyService } from '../../../shared/services/features/interview/feedback-policy.service';

import { QuizQuestionComponent } from '../../../components/question/quiz-question/quiz-question.component';

import { QuestionVerdictService } from '../../../shared/services/features/verdict/question-verdict.service';

import { buildHeadingInputs } from '../../../shared/utils/heading-inputs';
import { deriveHeadingHtml, shouldShowFet } from '../../../shared/utils/heading-model';

@Component({
  selector: 'codelab-quiz-content',
  standalone: true,
  imports: [],
  templateUrl: './codelab-quiz-content.component.html',
  styleUrls: ['./codelab-quiz-content.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CodelabQuizContentComponent implements OnInit {
  // ── injects ─────────────────────────────────────────────────────
  private readonly displayService = inject(QuizContentDisplayService);
  public readonly explanationTextService = inject(ExplanationTextService);
  private readonly questionVerdictService = inject(QuestionVerdictService);
  private readonly orchestrator = inject(CqcOrchestratorService);
  public readonly quizDataService = inject(QuizDataService);
  private readonly quizNavigationService = inject(QuizNavigationService);
  public readonly quizQuestionManagerService = inject(QuizQuestionManagerService);
  public readonly quizService = inject(QuizService);
  public readonly quizStateService = inject(QuizStateService);
  public readonly selectedOptionService = inject(SelectedOptionService);
  public readonly timerService = inject(TimerService);
  public readonly feedbackPolicyService = inject(FeedbackPolicyService);
  public readonly activatedRoute = inject(ActivatedRoute);
  public readonly cdRef = inject(ChangeDetectorRef);
  public readonly destroyRef = inject(DestroyRef);
  public readonly renderer = inject(Renderer2);
  private readonly sanitizer = inject(DomSanitizer);

  // ── viewChilds ──────────────────────────────────────────────────
  readonly quizQuestionComponent = viewChild(QuizQuestionComponent);
  // PROJECTED heading: the <h3 #qText quiz-projected-content> is projected in by
  // quiz.component into this component's <ng-content> slot, so it's CONTENT (not
  // view) — it must be queried with contentChild, or the heading writer no-ops.
  readonly qText = contentChild<ElementRef<HTMLHeadingElement>>('qText');

  // ── outputs ─────────────────────────────────────────────────────
  readonly isContentAvailableChange = output<boolean>();

  // ── inputs ──────────────────────────────────────────────────────
  readonly questionToDisplay = input<string>('');
  readonly questionToDisplay$ = input<Observable<string | null> | null>(null);
  readonly explanationToDisplay = input<string | null>(null);
  readonly question = input<QuizQuestion | null>(null);
  readonly question$ = input<Observable<QuizQuestion | null> | null>(null);
  readonly questions = input<QuizQuestion[]>([]);
  readonly options = input<Option[]>([]);
  readonly correctAnswersText = input<string>('');
  readonly questionText = input<string>('');
  readonly quizData = input<CombinedQuestionDataType | null>(null);
  readonly displayState$ = input<Observable<{
    mode: 'question' | 'explanation';
    answered: boolean;
  }> | null>(null);
  readonly displayVariables = input<{ question: string; explanation: string } | null>(null);
  readonly localExplanationText = input<string>('');
  readonly showLocalExplanation = input<boolean>(false);
  readonly questionIndex = input<number>(0);

  // ── remaining variables ─────────────────────────────────────────
  private _combinedQuestionDataSig = signal<Observable<CombinedQuestionDataType> | null>(null);
  readonly combinedQuestionData$ = this._combinedQuestionDataSig.asReadonly();
  readonly currentQuestionSig = signal<QuizQuestion | null>(null);
  readonly currentQuestion$ = toObservable(this.currentQuestionSig);
  private _quizIdSig = signal<string>('');
  readonly quizId = this._quizIdSig.asReadonly();

  currentQuestionIndexValue = 0;
  currentQuestionIndex$!: Observable<number>;

  // Aliased directly from the navigation service signal — no wrapper getter needed.
  readonly isNavigatingToPrevious = this.quizNavigationService.isNavigatingToPreviousSig;

  currentIndex = -1;
  // Signal source of truth + sync BS mirror so .asObservable() consumers
  // (displayText$ pipeline) keep their sync emission. Migrating fully to
  // toObservable(sig) would re-introduce the FET flash bug fixed earlier.
  readonly questionIndexSig = signal<number>(0);
  questionIndexSubject = new BehaviorSubject<number>(0);
  currentIndex$ = this.questionIndexSubject.asObservable();

  isExplanationTextDisplayed$: Observable<boolean>;

  formattedExplanation$!: Observable<FETPayload>;
  public activeFetText$!: Observable<string>;

  // Never written; cqc-orchestrator subscribes only to seed its
  // combineLatest pipeline. Constant observable keeps the API stable.
  readonly numberOfCorrectAnswers$ = of('0');

  readonly correctAnswersTextSig = signal<string>('');

  readonly questionRenderedSig = signal<boolean>(false);

  isContentAvailable$!: Observable<boolean>;

  // Purge-proof, per-index memo of the last non-empty FET html. The FET
  // pipeline can transiently clear formattedExplanations[idx] for a frame during
  // the revisit transition (the purge branch in
  // getFormattedExplanationTextForQuestion), which makes buildHeadingInputs.fetHtml
  // momentarily empty and would flip the heading question→FET→question = the
  // revisit flicker (visible only in slower runtimes like StackBlitz). This memo
  // survives that purge so the heading can hold the FET when it SHOULD be shown.
  private readonly _lastGoodFetByIndex = new Map<number, string>();

  // The single-source heading decision: one pure computed that decides the <h3>
  // contents (question text + banner, or the FET) from quiz state. Bound to the
  // heading's innerHTML by the lone DOM-write effect in the constructor.
  readonly headingHtml = computed<string>(() => {
    // Reactivity triggers (Phase 3 step 3c): recompute whenever any heading-
    // relevant state changes. We read these signals only to establish the
    // computed's dependencies — the values are gathered fresh by
    // buildHeadingInputs below (which itself reads currentQuestionIndex, the
    // timer-expiry signal and the nav-back signal). This replaces the previous
    // htmlSig trigger, decoupling the heading from the setHtml writers so they
    // can be removed. Extra triggers are harmless; a missing one is the bug, so
    // we read every signal that correlates with a heading change.
    this.currentQuestionSig(); // question data resolved / changed
    this.selectedOptionService.selectedOptionSig(); // option selection changed
    this.quizStateService.lastInteractionTimeSig(); // any genuine option click
    this.explanationTextService.formattedExplanationSig(); // FET text became available
    this.questionVerdictService.states(); // a verdict was recorded/updated
    this.feedbackPolicyService.feedbackMode(); // immediate ↔ deferred (Interview Mode)
    const idx = this.quizService.currentQuestionIndex;
    const inputs = buildHeadingInputs({
      idx,
      quizService: this.quizService,
      explanationTextService: this.explanationTextService,
      timerService: this.timerService,
      selectedOptionService: this.selectedOptionService,
      quizStateService: this.quizStateService,
      quizNavigationService: this.quizNavigationService,
      quizQuestionManagerService: this.quizQuestionManagerService,
      feedbackPolicyService: this.feedbackPolicyService,
      questionVerdictService: this.questionVerdictService,
    });
    if (!inputs) return '';

    // Anti-blip: remember the last real FET for this index; when the FET SHOULD
    // show but its text momentarily blips empty (transient purge during a
    // revisit), reuse the remembered value so the heading never flips to the
    // question text and back. Gated by shouldShowFet, so it can only ever hold a
    // FET that is legitimately due — never resurrect one after nav/reset (those
    // make shouldShowFet false, and the memo is not consulted).
    if (inputs.fetHtml.trim().length > 0) {
      this._lastGoodFetByIndex.set(idx, inputs.fetHtml);
    } else if (shouldShowFet(inputs)) {
      const remembered = this._lastGoodFetByIndex.get(idx);
      if (remembered) inputs.fetHtml = remembered;
    }

    return deriveHeadingHtml(inputs);
  });

  // Signal source of truth + sync BS mirror. The TIMER-EXPIRY FAST PATH
  // in cqc-display-text and the displayText$ pipeline both read .getValue()
  // / subscribe to currentIndex$/timedOutIdx$ and rely on sync emission
  // so they don't observe a stale-Q FET window during navigation.
  readonly timedOutIdxSig = signal<number>(-1);
  timedOutIdxSubject = new BehaviorSubject<number>(-1);
  public timedOutIdx$ = this.timedOutIdxSubject.asObservable();

  // Runtime-mutated state used by cqc-orchestrator + cqc-display-text +
  // cqc-fet-guard + cqc-question-nav services. Declared here so the Host
  // type sees them; values default to falsy/empty until the services
  // assign on init.
  combinedText$!: Observable<string>;
  combinedSub?: Subscription;
  _lastDisplayedText = '';
  _fetLockedForIndex = -1;
  _eagerFetRetryTimers: any[] = [];
  _refreshInitialIdx: number | null = null;
  _refreshInitialLoadConsumed: boolean | null = null;
  _postRefreshCleanedIndices?: Set<number>;
  lastQuestionIndexForReset = -1;
  explanationTexts: string[] = [];

  constructor() {
    this.formattedExplanation$ = this.displayService.createFormattedExplanation$(
      this.currentIndex$
    );
    this.activeFetText$ = this.displayService.createActiveFetText$(this.currentIndex$);

    this.isExplanationTextDisplayed$ = this.explanationTextService.isExplanationTextDisplayed$;

    let effectFiredOnce = false;
    effect(() => {
      const idx = this.questionIndex();
      untracked(() => {
        if (!effectFiredOnce) {
          // Skip the effect's own first run — ngOnInit primes synchronously.
          effectFiredOnce = true;
          return;
        }
        this._fetLocked = false;
        this._lockedForIndex = -1;
        this.orchestrator.runQuestionIndexSet(this, idx);
        this.currentIndex = idx;
        this.resetExplanationView();
        this.cdRef.markForCheck();
      });
    });

    // First-render latch. Replaces a now-unreachable ngOnChanges that
    // tried to flip questionRenderedSig the first time questionText
    // resolved to a non-empty string. Signal-input changes don't fire
    // ngOnChanges, so this only runs as an effect.
    effect(() => {
      if (!!this.questionText() && !this.questionRenderedSig()) {
        this.questionRenderedSig.set(true);
      }
    });

    // qText DOM-write effect: the SINGLE canonical writer of the heading's DOM
    // state. It binds the single-source `headingHtml` computed to the H3's
    // innerHTML — one pure function decides the heading, one effect renders it.
    // (Phase 3 Step 0: the legacy htmlSig branch + __headingSingleSource escape
    // hatch are removed; the old setHtml/writeQText writers are now fully dead and
    // are being deleted in the following steps.)
    effect(() => {
      const el = this.qText()?.nativeElement;
      if (!el) return;
      // Sanitize before the innerHTML write — never trust the raw string. The
      // sanitizer keeps ordinary formatting (<code>/<strong>/<span>/<em>) and
      // strips only unsafe constructs (scripts, dangerous URLs, event handlers).
      const sanitizedHtml =
        this.sanitizer.sanitize(SecurityContext.HTML, this.headingHtml()) ?? '';
      if ((el.innerHTML ?? '') === sanitizedHtml) return;
      this.renderer.setProperty(el, 'innerHTML', sanitizedHtml);
    });

    this.destroyRef.onDestroy(() => {
      // FET watchdog cleanup is handled by orchestrator.runOnDestroy via fetGuard.
      this.orchestrator.runOnDestroy(this);
    });
  }

  async ngOnInit(): Promise<void> {
    this.primeQuestionIndex();
    const result = this.orchestrator.runOnInit(this);
    return result;
  }

  setCombinedQuestionData$(v: Observable<CombinedQuestionDataType> | null): void {
    this._combinedQuestionDataSig.set(v);
  }

  setQuizId(v: string): void {
    this._quizIdSig.set(v);
  }

  get _lastQuestionTextByIndex(): Map<number, string> {
    return this.displayService._lastQuestionTextByIndex;
  }

  get _fetDisplayedThisSession(): Set<number> {
    return this.displayService._fetDisplayedThisSession;
  }

  get _fetLocked(): boolean {
    return this.displayService._fetLockedSig();
  }
  set _fetLocked(v: boolean) {
    this.displayService._fetLockedSig.set(v);
  }
  get _lockedForIndex(): number {
    return this.displayService._lockedForIndexSig();
  }
  set _lockedForIndex(v: number) {
    this.displayService._lockedForIndexSig.set(v);
  }

  resetInitialState(): void {
    this.explanationTextService.setIsExplanationTextDisplayed(false);
  }

  setupQuestionResetSubscription(): void {
    this.orchestrator.runSetupQuestionResetSubscription(this);
  }

  resetExplanationService(): void {
    this.resetExplanationView();

    this.explanationTextService.setShouldDisplayExplanation(false);

    this.explanationTextService.resetForIndex(0);
    this.explanationTextService.setShouldDisplayExplanation(false, {
      force: true,
    });
  }

  setupContentAvailability(): void {
    this.orchestrator.runSetupContentAvailability(this);
  }

  resetExplanationView(): void {
    this.explanationTextService.setShouldDisplayExplanation(false);
    this.explanationTextService.setExplanationText('');
  }

  emitContentAvailableState(): void {
    this.orchestrator.runEmitContentAvailableState(this);
  }

  loadQuizDataFromRoute(): void {
    this.orchestrator.runLoadQuizDataFromRoute(this);
  }

  async loadQuestion(quizId: string, zeroBasedIndex: number): Promise<void> {
    return this.orchestrator.runLoadQuestion(this, quizId, zeroBasedIndex);
  }

  async initializeComponent(): Promise<void> {
    await this.initializeQuestionData();
    this.initializeCombinedQuestionData();
  }

  fetchQuestionsAndExplanationTexts(params: ParamMap): Observable<[QuizQuestion[], string[]]> {
    return this.orchestrator.runFetchQuestionsAndExplanationTexts(this, params);
  }

  initializeCurrentQuestionIndex(): void {
    const idx = this.currentQuestionIndexValue ?? 0;
    this.quizService.currentQuestionIndex = idx;
    this.questionIndexSig.set(idx);
    this.questionIndexSubject.next(idx);
    this.currentIndex = idx;
    this.currentQuestionIndex$ = this.quizService.getCurrentQuestionIndexObservable();
  }

  updateCorrectAnswersDisplay(question: QuizQuestion | null): Observable<void> {
    return this.orchestrator.runUpdateCorrectAnswersDisplay(this, question);
  }

  combineCurrentQuestionAndOptions(): Observable<{
    currentQuestion: QuizQuestion | null;
    currentOptions: Option[];
    explanation: string;
    currentIndex: number;
  }> {
    return this.orchestrator.runCombineCurrentQuestionAndOptions(this);
  }

  haveSameOptionOrder(left: Option[] = [], right: Option[] = []): boolean {
    return this.orchestrator.runHaveSameOptionOrder(this, left, right);
  }

  calculateCombinedQuestionData(
    currentQuizData: CombinedQuestionDataType,
    numberOfCorrectAnswers: number,
    isExplanationDisplayed: boolean,
    formattedExplanation: string
  ): CombinedQuestionDataType {
    return this.orchestrator.runCalculateCombinedQuestionData(
      this,
      currentQuizData,
      numberOfCorrectAnswers,
      isExplanationDisplayed,
      formattedExplanation
    );
  }

  // Prime synchronously with the initial input value so runOnInit's
  // downstream setup sees the correct currentIndex / FET state.
  private primeQuestionIndex(): void {
    this.orchestrator.runQuestionIndexSet(this, this.questionIndex());
  }

  private async initializeQuestionData(): Promise<void> {
    return this.orchestrator.runInitializeQuestionData(this);
  }

  private initializeCombinedQuestionData(): void {
    this.orchestrator.runInitializeCombinedQuestionData(this);
  }
}
