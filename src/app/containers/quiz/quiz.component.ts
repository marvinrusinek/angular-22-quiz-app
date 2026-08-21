import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  OnInit,
  signal,
  untracked,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { NgClass } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { Observable, Subscription } from 'rxjs';
import { MatCardModule } from '@angular/material/card';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltip, MatTooltipModule } from '@angular/material/tooltip';

import {
  SK_RESULTS_REACHED_ATTEMPT,
  SK_SAVED_QUESTION_INDEX,
} from '../../shared/constants/session-keys';

import { Option } from '../../shared/models/Option.model';
import { QuestionPayload } from '../../shared/models/QuestionPayload.model';
import { Quiz } from '../../shared/models/Quiz.model';
import { QuizQuestion } from '../../shared/models/QuizQuestion.model';
import { QuizQuestionEvent } from '../../shared/models/QuizQuestionEvent.type';
import { SelectedOption } from '../../shared/models/SelectedOption.model';

import { NextButtonStateService } from '../../shared/services/state/next-button-state.service';
import { QqcQuestionLoaderService } from '../../shared/services/features/qqc/qqc-question-loader.service';
import { QuizDataService } from '../../shared/services/data/quizdata.service';
import { QuizDotStatusService } from '../../shared/services/flow/quiz-dot-status.service';
import { QuizInitializationService } from '../../shared/services/flow/quiz-initialization.service';
import { QuizNavigationService } from '../../shared/services/flow/quiz-navigation.service';
import { QuizPersistenceService } from '../../shared/services/state/quiz-persistence.service';
import { QuizResetService } from '../../shared/services/flow/quiz-reset.service';
import { QuizRouteService } from '../../shared/services/flow/quiz-route.service';
import { QuizService } from '../../shared/services/data/quiz.service';
import { TopicQuizTypeRegistry } from '../../shared/services/api/topic-quiz-type-registry.service';
import { QuizQuestionManagerService } from '../../shared/services/flow/quizquestionmgr.service';
import { QuestionVerdictService } from '../../shared/services/features/verdict/question-verdict.service';
import { QuizSetupService } from '../../shared/services/flow/quiz-setup.service';
import { QuizStateService } from '../../shared/services/state/quizstate.service';
import { SelectedOptionService } from '../../shared/services/state/selectedoption.service';
import {
  SHOW_RESULTS_MSG,
  SelectionMessageService,
} from '../../shared/services/features/selection-message/selection-message.service';
import { TimerService } from '../../shared/services/features/timer/timer.service';

import { CodelabQuizContentComponent } from './quiz-content/codelab-quiz-content.component';
import { CodelabQuizHeaderComponent } from './quiz-header/quiz-header.component';
import {
  ConfirmDialogComponent,
  ConfirmDialogData,
} from '../../components/dialogs/confirm-dialog/confirm-dialog.component';
import { QuizQuestionComponent } from '../../components/question/quiz-question/quiz-question.component';
import { ScoreboardComponent } from '../scoreboard/scoreboard.component';
import { SharedOptionComponent } from '../../components/question/answer/shared-option-component/shared-option.component';

import { QUESTION_ROUTE_REGEX } from '../../shared/constants/route-patterns';

import { ChangeRouteAnimation } from '../../animations/animations';
import { withCorrectCountBanner } from '../../shared/utils/correct-count-banner';
import { norm } from '../../shared/utils/text-norm';
import { swallow } from '../../shared/utils/error-logging';

const INFO_ICON_COLOR = '#1e90ff';

type AnimationState = 'animationStarted' | 'none';

@Component({
  selector: 'codelab-quiz-component',
  standalone: true,
  imports: [
    NgClass,
    MatCardModule,
    MatIconModule,
    MatTooltipModule,
    QuizQuestionComponent,
    CodelabQuizHeaderComponent,
    CodelabQuizContentComponent,
    ScoreboardComponent,
  ],
  templateUrl: './quiz.component.html',
  styleUrls: ['./quiz.component.scss'],
  animations: [ChangeRouteAnimation.changeRoute],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(window:keydown)': 'onGlobalKey($event)',
    '(window:focus)': 'onWindowFocus()',
    '(window:scroll)': 'onWindowScroll()',
    '(window:resize)': 'onWindowResize()',
  },
})
export class QuizComponent implements OnInit, AfterViewInit {
  // ── injects ─────────────────────────────────────────────────────
  private readonly dialog = inject(MatDialog);
  private readonly dotStatusService = inject(QuizDotStatusService);
  private readonly nextButtonStateService = inject(NextButtonStateService);
  private readonly quizDataService = inject(QuizDataService);
  public readonly quizInitializationService = inject(QuizInitializationService);
  private readonly quizNavigationService = inject(QuizNavigationService);
  private readonly quizPersistence = inject(QuizPersistenceService);
  public readonly quizQuestionLoaderService = inject(QqcQuestionLoaderService);
  private readonly quizResetService = inject(QuizResetService);
  private readonly quizRouteService = inject(QuizRouteService);
  public readonly quizService = inject(QuizService);
  private readonly topicQuizTypeRegistry = inject(TopicQuizTypeRegistry);
  private readonly quizQuestionManagerService = inject(QuizQuestionManagerService);
  private readonly verdicts = inject(QuestionVerdictService);
  private readonly quizSetupService = inject(QuizSetupService);
  public readonly quizStateService = inject(QuizStateService);
  private readonly selectedOptionService = inject(SelectedOptionService);
  private readonly selectionMessageService = inject(SelectionMessageService);
  private readonly timerService = inject(TimerService);
  public readonly activatedRoute = inject(ActivatedRoute);
  public readonly cdRef = inject(ChangeDetectorRef);
  public readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);

  // ── viewChilds ──────────────────────────────────────────────────
  readonly quizQuestionComponent = viewChild(QuizQuestionComponent);
  readonly sharedOptionComponent = viewChild(SharedOptionComponent);
  readonly nextButtonTooltip = viewChild<MatTooltip>('nextButton');

  // ── remaining variables ─────────────────────────────────────────
  readonly selectedQuiz = signal<Quiz | null>(null);
  readonly currentQuestion = signal<QuizQuestion | null>(null);
  readonly quiz = signal<Quiz | null>(null);
  readonly quizId = signal<string>('');
  readonly question = signal<QuizQuestion | null>(null);
  readonly questions = signal<QuizQuestion[]>([]);
  readonly questionsArray = signal<QuizQuestion[]>([]);
  readonly questionsList = this.quizService.questionsSig;
  readonly answers = signal<Option[]>([]);
  readonly selectionMessage = this.selectionMessageService.selectionMessageSig;
  combinedQuestionData = signal<QuestionPayload | null>(null);
  readonly questionIndex = signal<number>(0);
  readonly currentQuestionIndex = signal<number>(0);
  readonly totalQuestions = signal<number>(0);
  readonly progressSig = signal<number>(0);
  questionToDisplaySig = signal<string>('');
  readonly optionsToDisplaySig = signal<Option[]>([]);
  readonly explanationToDisplay = signal<string>('');
  readonly isQuizLoaded = signal<boolean>(false);
  readonly isQuizDataLoaded = signal<boolean>(false);
  public isQuizRenderReadySig = signal<boolean>(false);
  readonly quizAlreadyInitialized = signal<boolean>(false);
  readonly hasOptionsLoaded = signal<boolean>(false);
  public readonly shouldRenderOptions = signal<boolean>(false);
  readonly previousIndex = signal<number | null>(null);
  readonly isNavigatedByUrl = signal<boolean>(false);
  readonly navigatingToResults = signal<boolean>(false);
  readonly nextButtonEnabled = this.nextButtonStateService.isButtonEnabled;
  animationStateSig = signal<AnimationState>('none');

  combinedQuestionDataView = computed(() => {
    const payload = this.combinedQuestionData();

    // REACTIVITY FIX: track the questions signal so this computed re-runs when
    // quiz data finishes loading. The URL-override below reads the plain
    // `quizService.questions` GETTER (not a signal), so without this the gate
    // can compute once with no data, return empty options (@if fails, the
    // question component never renders), and never recompute when data arrives
    // — the cold-load "options never show" bug (worse on slow envs).
    this.quizService.questionsSig();

    // URL-AUTHORITATIVE OVERRIDE: when the user has navigated directly to
    // /question/{quizId}/{N}, the URL is the only source we trust. Any
    // payload whose question doesn't match the URL question is a stale
    // emission (typically Q1 leaking through during the multi-step
    // initialization chain) and must NOT render. We synthesize the
    // payload from the URL-resolved question instead.
    try {
      const m = window.location.pathname.match(QUESTION_ROUTE_REGEX);
      if (m) {
        const urlIdx = Number(m[1]) - 1;
        const urlQ = this.quizService.questions?.[urlIdx];
        if (urlQ?.options?.length) {
          const urlText = norm(urlQ.questionText);
          const payloadText = norm(payload?.question?.questionText);
          if (!payloadText || urlText !== payloadText) {
            return {
              question: urlQ,
              options: urlQ.options,
              explanation: urlQ.explanation ?? '',
            };
          }
        }
      }
    } catch (err: unknown) {
      swallow('quiz.component.ts', err); /* non-browser env */
    }

    if (!payload?.question) return payload;

    const shuffled = this.quizService.shuffledQuestions;
    const isShuffleActive = this.quizService.isShuffleEnabled() && shuffled?.length > 0;
    if (isShuffleActive) {
      const idx = this.currentQuestionIndex() ?? 0;
      const correctQ = shuffled[idx];
      if (correctQ) {
        // ALWAYS use shuffled data when shuffle is active
        return {
          question: correctQ,
          options: correctQ.options ?? [],
          explanation: correctQ.explanation ?? '',
        };
      }
    }
    return payload;
  });

  // Derive the displayed question text from the URL-authoritative
  // combinedQuestionDataView rather than questionToDisplaySig directly.
  // questionToDisplaySig is written from many code paths (some still
  // emit Q1's text on direct URL nav to /question/.../5), and binding
  // its raw stream caused Q1's question text to render alongside Q5's
  // options. The view computed already enforces the URL question, so
  // routing the text through it makes both pieces consistent.
  // Also re-attaches the "(Select N correct answers)" banner for
  // multi-answer questions — the inline display path would otherwise
  // drop it because we're synthesising from raw URL question data.
  readonly questionToDisplayTextView = computed(() => {
    const view = this.combinedQuestionDataView();
    const baseText = (view?.question?.questionText ?? this.questionToDisplaySig() ?? '').trim();
    if (!baseText) return '';

    // THE COUNT IS DECLARED, NOT COUNTED.
    //
    // This filtered `option.correct` over the rendered options, which made the
    // banner an answer-key derivative: API-sourced options carry no `correct`,
    // so the count was always 0 and the banner silently vanished. It is also
    // why a shuffled question needed a canonical re-lookup by text before the
    // first selection — the view's options were empty and the count collapsed.
    //
    // `correctCount` is CARDINALITY, not identity: how many options are right,
    // never which. `/questions` ships it deliberately (the number has always
    // been on screen before the user answers), and TopicQuizTypeRegistry stores
    // it keyed by question text — so this is a metadata read, and neither the
    // options nor the pristine bank are consulted at all.
    //
    // FAILS CLOSED. `null` means the API has not told us, and an undeclared
    // count renders NO banner rather than a reconstructed one. Showing nothing
    // is the same state every single-answer question is already in.
    const declaredCount = this.topicQuizTypeRegistry.correctCountOf(baseText);
    if (declaredCount === null || declaredCount <= 1) return baseText;

    // Both helpers already exist and are the single sources of truth for their
    // half: the manager owns the wording and pluralisation, `withCorrectCountBanner`
    // owns the markup that downstream code detects by class.
    const banner = this.quizQuestionManagerService.getNumberOfCorrectAnswersText(
      declaredCount,
      view?.options?.length
    );
    return withCorrectCountBanner(baseText, banner);
  });

  // ── Template getters ──────────────────────────────────────────
  readonly showPaging = computed(() => this.isQuizDataLoaded() && this.totalQuestions() > 0);

  readonly shouldShowPrevButton = computed(() => this.getEffectiveQuestionIndex() > 0);

  readonly shouldShowRestartButton = computed(() => {
    const idx = this.getEffectiveQuestionIndex();
    const serviceCount = this.quizService.questions?.length || 0;
    const effectiveTotal = Math.max(this.totalQuestions(), serviceCount);
    return idx > 0 && idx <= effectiveTotal - 1;
  });

  readonly shouldShowNextButton = computed(() => {
    const serviceCount = this.quizService.questions?.length || 0;
    const effectiveTotal = Math.max(this.totalQuestions(), serviceCount);
    return this.getEffectiveQuestionIndex() < effectiveTotal - 1;
  });

  questions$: Observable<QuizQuestion[]> = this.quizService.questions$;
  currentQuestion$ = this.quizStateService.currentQuestion$;
  subscriptions: Subscription = new Subscription();
  public questionToDisplay$ = toObservable(this.questionToDisplayTextView);
  displayState$ = this.quizStateService.displayState$;
  lastLoggedIndex = -1;
  public answeredQuestionIndices = new Set<number>();
  public _processingOptionClick = false;
  public _lastClickTime = 0;
  public _lastOptionId = -1;
  private scrollIndicatorEl: HTMLElement | null = null;

  constructor() {
    this.quizSetupService.wireConstructor(this);

    // Re-assert SHOW_RESULTS_MSG when the user lands back on the last question
    // from Results. Runs as the index/total signals settle after the rebuild.
    effect(() => this.restoreShowResultsMessageOnReturn());

    this.destroyRef.onDestroy(() => {
      this.removeScrollIndicator();
      this.quizSetupService.runOnDestroy(this);
    });
  }

  async ngOnInit(): Promise<void> {
    return this.quizSetupService.runOnInit(this);
  }

  async ngAfterViewInit(): Promise<void> {
    return this.quizSetupService.runAfterViewInit(this);
  }

  async onGlobalKey(event: KeyboardEvent): Promise<void> {
    return this.quizSetupService.runOnGlobalKey(this, event);
  }

  onWindowFocus(): void {
    if (!this.quizStateService.isLoading()) {
      const idx = this.quizService.getCurrentQuestionIndex();
      const total = this.totalQuestions();
      if (idx >= 0 && idx < total) {
        this.quizService.updateBadgeText(idx + 1, total);
      }
      this.cdRef.markForCheck();
    }
  }

  onWindowScroll(): void {
    this.checkScrollIndicator();
  }

  onWindowResize(): void {
    this.checkScrollIndicator();
  }

  checkScrollIndicator(): void {
    const quizCard = document.querySelector('.quiz-card');
    if (!quizCard) {
      this.removeScrollIndicator();
      return;
    }
    const cardRect = quizCard.getBoundingClientRect();
    const shouldShow = cardRect.bottom - window.innerHeight > 80;
    if (shouldShow && !this.scrollIndicatorEl) {
      this.createScrollIndicator();
    } else if (!shouldShow && this.scrollIndicatorEl) {
      this.removeScrollIndicator();
    }
  }

  scrollToBottom(): void {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
  }

  async initializeQuizId(): Promise<string | null> {
    let quizId = this.quizService.getCurrentQuizId();
    if (!quizId) {
      const routeQuizId = this.activatedRoute.snapshot.paramMap.get('quizId');
      if (routeQuizId) {
        quizId = routeQuizId;
        this.quizService.setQuizId(routeQuizId);
      }
    }
    if (!quizId) {
      await this.router.navigate(['/select']);
      return null;
    }
    return quizId;
  }

  initializeQuestionIndex(): void {
    const idx = this.quizRouteService.getRouteQuestionIndex(this.activatedRoute, this.router);
    this.currentQuestionIndex.set(idx);
    this.quizService.setCurrentQuestionIndex(idx);
    try {
      localStorage.setItem(SK_SAVED_QUESTION_INDEX, JSON.stringify(idx));
    } catch (err: unknown) {
      console.error('Failed to persist question index to localStorage:', err);
    }
  }

  public normalizeQuestionIndex(rawIndex: number | undefined): number {
    const current = this.currentQuestionIndex();
    if (!Number.isInteger(rawIndex)) return current;
    const idx = Number(rawIndex);
    const total = this.totalCount;
    if (idx === current) return idx;
    if (idx === current + 1) return current;
    if (total > 0 && idx >= total && idx - 1 >= 0 && idx - 1 < total) return idx - 1;
    return idx;
  }

  public onOptionSelected(option: SelectedOption, isUserAction: boolean = true): Promise<void> {
    return this.quizSetupService.onOptionSelected(this, option, isUserAction);
  }

  resetQuestionState(): void {
    this.quizResetService.resetQuestionServiceState();
    this.currentQuestion.set(null);
    this.question.set(null);
    this.optionsToDisplaySig.set([]);
    this.quizQuestionComponent()?.resetFeedback?.();
    this.quizQuestionComponent()?.resetState?.();
    this.cdRef.markForCheck();
  }

  /**
   * Is a score-relevant verdict still pending, or failed?
   *
   * Delegates to the verdict service, which owns the state — scoring readiness
   * must not be re-derived per call site or the two gates could disagree.
   */
  private hasBlockingVerdicts(): boolean {
    const quizId = this.quizId() || this.quizService.quizId || undefined;
    return this.verdicts.hasBlockingVerdicts(quizId);
  }

  public get shouldShowResultsButton(): boolean {
    // Hidden while any check is in flight or has failed, so the button never
    // looks available for an action `advanceToResults` would then refuse. The
    // keyboard shortcut reads this same getter, so both paths agree.
    if (this.hasBlockingVerdicts()) return false;

    const serviceCount = this.quizService.questions?.length || 0;
    const effectiveTotal = Math.max(this.totalQuestions(), serviceCount);
    const idx = this.getEffectiveQuestionIndex();
    // The URL is authoritative for "which question am I on". On a rebuilt
    // component (browser Back from Results) `getEffectiveQuestionIndex()` can
    // still read 0 while the payload settles, which would early-return below
    // and never re-show the button.
    const urlIdx = this.getUrlQuestionIndex();
    const isLast =
      effectiveTotal > 0 && (idx === effectiveTotal - 1 || urlIdx === effectiveTotal - 1);
    if (!isLast) return false;

    // Checked BEFORE the question guard: coming back from Results, this must
    // not depend on the rebuilt component's question payload having arrived.
    if (this.hasReachedResultsThisAttempt()) return true;

    const question: QuizQuestion | null =
      this.question() ??
      this.quizService.questions?.[idx] ??
      this.quizService.shuffledQuestions?.[idx] ??
      null;

    if (!question) return false;

    // Authoritative in-session answered probe. We deliberately do NOT use
    // `selectedOptionService.getSelectedOptionsForQuestion(idx)` here:
    // selectedOptionsMap + sessionStorage SK_SEL_Q are keyed by DISPLAY
    // index, which leaks across shuffle reshuffles — a prior shuffle's
    // selection at display idx 5 would appear as if the new shuffle's
    // (different) question at display 5 was already answered, surfacing
    // Show Results on a fresh page load. isCompletedInSession is the
    // in-session set, fresh per session and only marked when pushMessage
    // records a real completion (NEXT_BTN / SHOW_RESULTS / Answered ✓).
    if (this.selectionMessageService.isCompletedInSession(idx)) return true;

    // Any in-session click on the last question enables Show Results.
    // _hasUserInteracted is a fresh-per-session Set populated by the click
    // pipeline (markUserInteracted) — shuffle-safe because it's in-memory
    // only, NOT persisted. Lets users see results after ANY click (right
    // or wrong) rather than requiring a fully-correct answer first.
    if (this.quizStateService._hasUserInteracted?.has(idx)) return true;

    // Also show Results when timer expired this session on the last
    // unanswered question.
    return this.dotStatusService.timerExpiredUnanswered.has(idx);
  }

  // ── Results round-trip marker ───────────────────────────────────
  // Written on the way to Results, read when the user comes back to the last
  // question. Scoped to `<quizId>|<attemptId>` so it is self-invalidating:
  // Restart Quiz and a fresh attempt both mint a new attempt id, which stops a
  // stale marker from surfacing Show Results on an unanswered last question.

  private resultsReachedToken(quizId: string): string {
    return `${quizId}|${this.quizService.getCurrentAttemptId()}`;
  }

  /** 0-based question index straight off the URL, or -1 when unavailable. */
  private getUrlQuestionIndex(): number {
    try {
      const match = window.location.pathname.match(QUESTION_ROUTE_REGEX);
      if (!match) return -1;
      const oneBased = Number(match[1]);
      return Number.isFinite(oneBased) && oneBased >= 1 ? oneBased - 1 : -1;
    } catch (err: unknown) {
      swallow('quiz.component#getUrlQuestionIndex', err);
      return -1;
    }
  }

  private activeQuizId(): string {
    return (
      this.quizId() ||
      this.quizService.quizId ||
      this.activatedRoute.snapshot.paramMap.get('quizId') ||
      ''
    );
  }

  private markResultsReached(quizId: string): void {
    try {
      sessionStorage.setItem(SK_RESULTS_REACHED_ATTEMPT, this.resultsReachedToken(quizId));
    } catch (err: unknown) {
      swallow('quiz.component#markResultsReached', err);
    }
  }

  private restoreShowResultsMessageOnReturn(): void {
    // Reactive deps. Reading the message itself is what makes this self-healing:
    // if the init/reset cascade later stomps it with a baseline, this effect
    // re-runs and re-asserts, instead of a one-shot write that gets lost.
    const currentMsg = this.selectionMessage();
    this.quizService.questionsSig();
    const signalIdx = this.currentQuestionIndex();
    const total = Math.max(this.totalQuestions(), this.quizService.questions?.length || 0);
    if (total <= 0) return;

    const urlIdx = this.getUrlQuestionIndex();
    const idx = urlIdx >= 0 ? urlIdx : signalIdx;
    if (idx !== total - 1) return;

    if (!this.hasReachedResultsThisAttempt()) return;

    // Once the user clicks on the restored question the normal pipeline owns
    // the message again — stop asserting so we never fight a real selection.
    if (this.quizStateService._hasUserInteracted?.has(idx)) return;
    if (currentMsg === SHOW_RESULTS_MSG) return;

    untracked(() => {
      // `selectionMessageSig` is keyed on quizService.currentQuestionIndexSig(),
      // so an override pushed at `idx` is ignored while that index is still the
      // stale 0 from the missed NavigationEnd. Repair it first — this is the
      // same pair of writes the route handler performs, just not skipped.
      if (this.currentQuestionIndex() !== idx) this.currentQuestionIndex.set(idx);
      if (this.quizService.getCurrentQuestionIndex() !== idx) {
        this.quizService.setCurrentQuestionIndex(idx);
      }

      this.selectionMessageService.forceNextButtonMessage(idx, { isLastQuestion: true });
      this.cdRef.markForCheck();
    });
  }

  private hasReachedResultsThisAttempt(): boolean {
    const quizId = this.activeQuizId();
    if (!quizId) return false;

    try {
      const stored = sessionStorage.getItem(SK_RESULTS_REACHED_ATTEMPT);
      return !!stored && stored === this.resultsReachedToken(quizId);
    } catch (err: unknown) {
      swallow('quiz.component#hasReachedResultsThisAttempt', err);
      return false;
    }
  }

  public handleQuizQuestionEvent(event: QuizQuestionEvent): void {
    switch (event.type) {
      case 'answer':
        // A genuine answer ends the "navigated here" state, so the FET may show
        // for the current view. The nav flag stays set across navigation (no
        // timer reset) and is cleared here on a real selection.
        this.quizNavigationService.setIsNavigatingToPrevious(false);
        this.quizSetupService.selectedAnswer(this, event.payload);
        break;
      case 'optionSelected':
        this.quizNavigationService.setIsNavigatingToPrevious(false);
        if (event.payload && (event.payload as any).option) {
          void this.onOptionSelected((event.payload as any).option);
        } else {
          void this.onOptionSelected(event.payload as any);
        }
        break;
      case 'explanationToDisplayChange':
        this.quizSetupService.onExplanationChanged(this, event.payload, event.index);
        break;
      case 'showExplanationChange':
        if (event.payload) {
          this.quizStateService.setDisplayState({ mode: 'explanation', answered: true });
        }
        break;
    }
  }

  public async advanceToNextQuestion(): Promise<void> {
    await this.quizSetupService.advanceQuestion(this, 'next');
    this.scrollToTop();
  }
  public async advanceToPreviousQuestion(): Promise<void> {
    await this.quizSetupService.advanceQuestion(this, 'previous');
    this.scrollToTop();
  }

  // On question navigation, bring the new question to the top of the page (the
  // user may have scrolled down to the last option before pressing Next/Prev).
  private scrollToTop(): void {
    try {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      swallow('quiz.component#scrollToTop', err);
    }
  }
  public advanceToResults(): void {
    if (this.navigatingToResults()) return;

    // FINALIZATION GATE. Both entry points (this button and the keyboard
    // shortcut in quiz-setup.service) funnel through here, so the invariant is
    // enforced once rather than duplicated per caller.
    //
    // Scoring must not run while a check is in flight or has failed: the result
    // would either come from a superseded verdict or from the local answer key.
    // The UI gate below (`shouldShowResultsButton`) hides the button in the
    // same states, so this is a backstop rather than the primary UX.
    if (this.hasBlockingVerdicts()) return;

    this.navigatingToResults.set(true);

    // Record elapsed time and stop timer (no navigation from service)
    this.quizNavigationService.recordElapsedAndGoToResults(this.currentQuestionIndex());

    // Navigate to results from the component
    const quizId =
      this.quizId() ||
      this.quizService.quizId ||
      this.quizService.getCurrentQuizId() ||
      this.activatedRoute.snapshot.paramMap.get('quizId') ||
      '';
    if (quizId) {
      this.markResultsReached(quizId);
      this.router.navigateByUrl(`/quiz/results/${quizId}`);
    }
  }

  restartQuiz(): void {
    // Guard against accidental clicks mid-quiz — restart wipes every
    // answer + reschedules the timer. A themed confirm dialog matches
    // the app (incl. dark mode) instead of the native confirm() box.
    const ref = this.dialog.open<ConfirmDialogComponent, ConfirmDialogData, boolean>(
      ConfirmDialogComponent,
      {
        width: '360px',
        panelClass: 'themed-confirm-dialog',
        autoFocus: 'dialog',
        data: {
          title: 'Restart the quiz?',
          message: 'Your progress will be lost.',
          confirmText: 'Restart',
          cancelText: 'Cancel',
          confirmColor: 'warn',
        },
      }
    );

    ref.afterClosed().subscribe((confirmed) => {
      if (!confirmed) return;
      // Restart = a NEW attempt → new attempt id so the retake records its own
      // High Scores row. This only resets the active attempt; the persistent
      // highScoresLocal history is intentionally left untouched.
      this.quizService.startNewAttempt();
      this.quizSetupService.restartQuiz(this);
    });
  }

  // ── Progress / dots ────────────────────────────────────────────
  updateProgressValue(): void {
    const total = this.totalCount;
    if (total <= 0) {
      this.cdRef.markForCheck();
      return;
    }
    this.progressSig.set(Math.round((this.answeredQuestionIndices.size / total) * 100));
    try {
      sessionStorage.setItem('quizProgress', String(this.progressSig()));
      sessionStorage.setItem('quizProgressQuizId', this.quizId());
      sessionStorage.setItem(
        'answeredQuestionIndices',
        JSON.stringify([...this.answeredQuestionIndices])
      );
    } catch (err: unknown) {
      console.error('Failed to persist quiz progress to sessionStorage:', err);
    }
    this.cdRef.markForCheck();
  }

  /**
   * Marks a question as answered. Always recomputes progress from the
   * authoritative selectedOptionsMap (every entry with selections counts
   * as answered). This bypasses brittle index-passing through several
   * layers — the progress %% no longer depends on `index` matching the
   * caller's understanding of the current question.
   */
  public markQuestionAnswered(index: number): void {
    const liveIdx = this.quizService?.currentQuestionIndex;
    const effectiveIdx = Number.isFinite(liveIdx) && liveIdx >= 0 ? liveIdx : index;
    if (effectiveIdx >= 0) this.answeredQuestionIndices.add(effectiveIdx);

    // Always merge the live selectedOptionsMap so any question that has
    // had at least one option committed counts toward the progress %%,
    // regardless of which path called us first.
    try {
      const map = this.selectedOptionService?.selectedOptionsMap;
      if (map) {
        for (const [qIdx, selections] of map) {
          if (Array.isArray(selections) && selections.length > 0 && qIdx >= 0) {
            this.answeredQuestionIndices.add(qIdx);
          }
        }
      }
    } catch (err: unknown) {
      swallow('quiz.component.ts', err); /* ignore */
    }

    this.updateProgressValue();
  }

  getSelectionsForQuestion(index: number): SelectedOption[] {
    return this.dotStatusService.getSelectionsForQuestion({ index, ...this._dotParams });
  }

  getQuestionStatus(
    index: number,
    options?: { forceRecompute?: boolean }
  ): 'correct' | 'wrong' | 'pending' {
    return this.dotStatusService.getQuestionStatusSimple({ index, ...this._dotParams, options });
  }

  updateDotStatus(index: number): void {
    this.dotStatusService.timerExpiredUnanswered.delete(index);
    let status = this.getQuestionStatus(index, { forceRecompute: true });

    // Override with confirmed click status when it's more authoritative
    const confirmed = this.selectedOptionService.clickConfirmedDotStatus.get(index);
    if (confirmed === 'correct' || confirmed === 'wrong') {
      if (status === 'pending' || (status === 'wrong' && confirmed === 'correct')) {
        status = confirmed;
      }
    }

    this.dotStatusService.dotStatusCache.set(index, status);
    this.cdRef.markForCheck();
  }

  getDotClass(index: number): string {
    return this.dotStatusService.getDotClassSimple({ index, ...this._dotParams });
  }

  // True only when this question's countdown ran out with no answer
  // committed — distinct from the generic 'pending' (unanswered) state.
  isDotTimedOut(index: number): boolean {
    return this.dotStatusService.timerExpiredUnanswered.has(index);
  }

  navigateToDot(index: number): void {
    if (!this.isDotClickable(index)) return;
    this.dotStatusService.clearForIndex(index);
    this.selectedOptionService.lastClickedCorrectByQuestion.clear();
    this.quizPersistence.clearPersistedDotStatus(this.quizId(), index);
    this.selectedOptionService.resetLocksForQuestion(index);
    // Route through the navigation service (same path as Next/Prev) so the
    // destination question is fetched and EMITTED — a raw router.navigate only
    // changes the URL and leaves the displayed question unchanged.
    void this.quizNavigationService.navigateToQuestion(index).then(() => this.scrollToTop());
  }

  isDotClickable(index: number): boolean {
    if (index === this.currentQuestionIndex()) return true;
    const status = this.getQuestionStatus(index);
    if (status === 'correct' || status === 'wrong') return true;
    return true;
  }

  // Read the URL question index — used as a fallback when
  // this.currentQuestionIndex hasn't propagated yet during URL/dot
  // navigation. The button-visibility getters depend on the index
  // matching the URL, otherwise Prev/Restart/Show-Results all
  // disappear on direct URL nav to a non-Q1 question.
  private getEffectiveQuestionIndex(): number {
    const signalIdx = this.currentQuestionIndex();

    // The URL is authoritative. On a component rebuilt by a navigation that
    // created it (browser Back from Results, or a direct deep link) the
    // NavigationEnd that carries the index can fire before this component's
    // route subscription exists, leaving `currentQuestionIndex` at 0. Every
    // nav-button computed reads this, which is why a stale 0 kept the Next
    // button visible on the last question.
    const urlIdx = this.getUrlQuestionIndex();
    if (urlIdx < 0) return signalIdx;

    const total = Math.max(this.totalQuestions(), this.quizService.questions?.length || 0);
    if (total > 0 && urlIdx >= total) return signalIdx;

    return urlIdx;
  }

  private createScrollIndicator(): void {
    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;bottom:20px;left:0;right:0;margin:0 auto;z-index:9999;width:48px;height:48px;border-radius:50%;background:rgba(255,255,255,0.95);box-shadow:0 4px 12px rgba(0,0,0,0.25);display:flex;justify-content:center;align-items:center;cursor:pointer;animation:scrollBounce 2s infinite;';
    // Build the icon with DOM APIs rather than innerHTML. The markup was a fixed
    // literal (INFO_ICON_COLOR is a module constant, no user/quiz data), so this
    // is not an XSS fix — it removes the app's last raw innerHTML write, which is
    // exactly what a Trusted Types policy (require-trusted-types-for 'script')
    // rejects at runtime. Rendered output is byte-for-byte equivalent.
    const icon = document.createElement('i');
    icon.className = 'material-icons';
    icon.style.fontSize = '32px';
    icon.style.color = INFO_ICON_COLOR;
    icon.textContent = 'keyboard_arrow_down';
    el.appendChild(icon);
    el.addEventListener('click', () => this.scrollToBottom());
    document.body.appendChild(el);
    this.scrollIndicatorEl = el;
  }

  private removeScrollIndicator(): void {
    if (this.scrollIndicatorEl) {
      this.scrollIndicatorEl.remove();
      this.scrollIndicatorEl = null;
    }
  }

  private get totalCount(): number {
    return this.dotStatusService.computeTotalCount(
      this.totalQuestions(),
      this.quizService.questions?.length || 0,
      this.quiz()?.questions?.length || 0
    );
  }

  private get _dotParams() {
    return {
      quizId: this.quizId(),
      currentQuestionIndex: this.currentQuestionIndex(),
      optionsToDisplay: this.optionsToDisplaySig(),
      currentQuestion: this.currentQuestion(),
      questionsArray: this.questionsArray(),
    };
  }
}
