import { ChangeDetectorRef, Service, WritableSignal, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormGroup } from '@angular/forms';
import {
  animationFrameScheduler, BehaviorSubject, combineLatest, Observable, of
} from 'rxjs';
import { distinctUntilChanged, filter, observeOn } from 'rxjs/operators';

import { FeedbackProps } from '../../../models/FeedbackProps.model';
import { Option } from '../../../models/Option.model';
import { OptionBindings } from '../../../models/OptionBindings.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';
import { SelectedOption } from '../../../models/SelectedOption.model';
import { SharedOptionConfig } from '../../../models/SharedOptionConfig.model';

import { QUESTION_ROUTE_REGEX } from '../../../constants/route-patterns';

import { ExplanationTextService } from '../../features/explanation/explanation-text.service';
import { FeedbackService } from '../../features/feedback/feedback.service';
import { QuizService } from '../../data/quiz.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { TimerService } from '../../features/timer/timer.service';

import { norm } from '../../../utils/text-norm';
import { swallow } from '../../../utils/error-logging';

/**
 * Interface representing the component surface area that the init service needs.
 * The component passes `this` typed as this interface so the service can
 * read/write state and call helper methods.
 */
export interface SharedOptionComponentLike {
  // --- Inputs / public fields ---
  currentQuestion: WritableSignal<QuizQuestion | null>;
  currentQuestionIndex: number;
  questionIndex: () => number | null;
  optionsToDisplay: Option[];
  quizId: () => string;
  type: 'single' | 'multiple';
  config: () => SharedOptionConfig;
  selectedOption: WritableSignal<Option | null>;
  showFeedbackForOption: { [key: string | number]: boolean };
  correctMessage: WritableSignal<string>;
  showFeedback: WritableSignal<boolean>;
  shouldResetBackground: WritableSignal<boolean>;
  highlightCorrectAfterIncorrect: () => boolean;
  optionBindings: WritableSignal<OptionBindings[]>;
  selectedOptionId: () => number | null;
  selectedOptionIndex: WritableSignal<number | null>;
  isNavigatingBackwards: WritableSignal<boolean>;
  renderReady: { set: (v: boolean) => void; (): boolean };
  finalRenderReady$: () => Observable<boolean> | null;
  questionVersion: () => number;
  sharedOptionConfig: () => SharedOptionConfig;

  // --- Public state ---
  selectedOptionMap: Map<number | string, boolean>;
  finalRenderReady: boolean;
  isSelected: WritableSignal<boolean>;
  feedbackBindings: FeedbackProps[];
  currentFeedbackConfig: FeedbackProps;
  feedbackConfigs: { [key: string]: FeedbackProps };
  activeFeedbackConfig: WritableSignal<FeedbackProps | null>;
  _feedbackDisplay: { idx: number; optionId?: number | null; config: FeedbackProps } | null;
  selectedOptions: Set<number | string>;
  clickedOptionIds: Set<number | string>;
  selectedOptionHistory: (number | string)[];
  disabledOptionsPerQuestion: Map<number, Set<number>>;
  lastSelectedOptionIndex: number;
  lastFeedbackOptionId: number | string;
  lastSelectedOptionId: number | string;
  lastClickedOptionId: number | string | null;
  lastClickTimestamp: number | null;
  hasUserClicked: WritableSignal<boolean>;
  freezeOptionBindings: WritableSignal<boolean>;
  highlightedOptionIds: Set<number | string>;
  disableRenderTrigger: number;
  flashDisabledSet: Set<number>;
  forceDisableAll: WritableSignal<boolean>;
  timerExpiredForQuestion: WritableSignal<boolean>;
  _timerExpiryHandled: boolean;
  viewReady: WritableSignal<boolean>;
  optionsReady: boolean;
  showOptions: WritableSignal<boolean>;
  showNoOptionsFallback: boolean;

  // --- Private-ish fields exposed for the service ---
  _isMultiModeCache: boolean | null;
  _lastHandledIndex: number | null;
  _lastHandledTime: number | null;
  _lastClickFeedback: { index: number; config: FeedbackProps; questionIdx: number } | null;
  _multiSelectByQuestion: Map<number, Set<number>>;
  _correctIndicesByQuestion: Map<number, number[]>;
  _pendingHighlightRAF: number | null;
  lastProcessedQuestionIndex: number;
  resolvedQuestionIndex: number | null;
  optionsRestored: boolean;
  lockedIncorrectOptionIds: Set<number>;
  timeoutCorrectOptionKeys: Set<string>;
  lastFeedbackQuestionIndex: number;
  correctClicksPerQuestion: Map<number, Set<number>>;
  destroyRef: import('@angular/core').DestroyRef;

  // --- Subjects ---
  optionsToDisplay$: BehaviorSubject<Option[]>;
  renderReadySubject: BehaviorSubject<boolean>;
  renderReady$: Observable<boolean>;

  // --- ChangeDetectorRef ---
  cdRef: ChangeDetectorRef;

  // --- Form ---
  form: FormGroup;

  optionBindingsInitialized: WritableSignal<boolean>;

  // --- Methods the service delegates back to ---
  getActiveQuestionIndex(): number;
  getQuestionAtDisplayIndex(idx: number): QuizQuestion | null;
  updateResolvedQuestionIndex(idx: number): void;
  resolveCurrentQuestionIndex(): number;
  generateOptionBindings(): void;
  rehydrateUiFromState(reason: string): void;
  applySelectionsUI(selList: SelectedOption[]): void;
  regenerateFeedback(questionIndex: number): void;
  synchronizeOptionBindings(): void;
  determineQuestionType(question: QuizQuestion): 'single' | 'multiple';
  initializeFeedbackBindings(): void;
  finalizeOptionPopulation(): void;
  keyOf(o: Option, i: number): string;
  setOptionBindingsIfChanged(newOptions: Option[]): void;
  rebuildShowFeedbackMapFromBindings(): void;
}

@Service()
export class SharedOptionInitService {
  // ── injects ─────────────────────────────────────────────────────
  private explanationTextService = inject(ExplanationTextService);
  private feedbackService = inject(FeedbackService);
  private quizService = inject(QuizService);
  private selectedOptionService = inject(SelectedOptionService);
  private timerService = inject(TimerService);

  // ── public methods ──────────────────────────────────────────────

  /**
   * Resets all mutable state on the component for a new question.
   * Corresponds to SharedOptionComponent.resetStateForNewQuestion().
   */
  resetStateForNewQuestion(comp: SharedOptionComponentLike): void {
    comp._isMultiModeCache = null; // invalidate: new question may have different answer count
    comp.disabledOptionsPerQuestion.clear();
    comp.lockedIncorrectOptionIds.clear();
    comp.flashDisabledSet.clear();
    comp.timerExpiredForQuestion.set(false);
    comp._timerExpiryHandled = false;
    comp.timeoutCorrectOptionKeys.clear();
    comp.forceDisableAll.set(false);  // reset forceDisableAll for new question

    // Clear per-binding timer-expiry stamps applied by the timer-expiry
    // handler in shared-option.component.ts. Without this, Q2's options
    // inherit Q1's _timerExpiredStamped flag, and isDisabled() returns
    // true for every option on the new question via isTimerStamped().
    // RESOLVE: comp.optionBindings is a signal in -clean / plain array in -main.
    const _rawBindings = (comp as any).optionBindings;
    const _bindings: any[] = typeof _rawBindings === 'function'
      ? (_rawBindings() ?? [])
      : (_rawBindings ?? []);
    for (const b of _bindings) {
      if (!b) continue;
      delete b._timerExpiredStamped;
      // Same reasoning for the multi-answer end-state lock: a stale flag would
      // render the new question's untouched options grey and unclickable.
      delete b._autoRevealLocked;
      if (b.cssClasses) {
        delete b.cssClasses['correct-option'];
        delete b.cssClasses['incorrect-option'];
      }
    }

    // Strip the DOM mutations the timer-expiry handler applied directly
    // (pointer-events:none and the 'correct-option' class on .option-row).
    // Angular may reuse the row nodes across questions, so leftover
    // inline styles/classes leak from Q1 into Q2.
    try {
      for (const el of Array.from(document.querySelectorAll('.option-row'))) {
        const html = el as HTMLElement;
        html.style.pointerEvents = '';
        el.classList.remove('correct-option');
      }
    } catch (err: unknown) { swallow('shared-option-init.service.ts option-row DOM strip (non-browser env)', err); }
    comp.selectedOptions.clear();
    comp.selectedOptionMap.clear();
    comp._multiSelectByQuestion.clear();
    comp._correctIndicesByQuestion.clear();
    comp.feedbackConfigs = {};
    comp.showFeedbackForOption = {};
    comp._feedbackDisplay = null;
    comp.showFeedback.set(false);
    // CRITICAL: Reset hasUserClicked so that new question starts fresh.
    // Without this, hasUserClicked from Q1 leaks into Q2 and blocks
    // all guard-protected paths (rehydrateUiFromState, initializeFromConfig, etc.)
    comp.hasUserClicked.set(false);
    comp.freezeOptionBindings.set(false);
    comp.selectedOptionHistory = [];

    // Cancel any pending deferred emitExplanation from the previous question
    // to prevent stale Q(N) FET from being stored at Q(N+1)'s index
    if (comp._pendingHighlightRAF !== null) {
      cancelAnimationFrame(comp._pendingHighlightRAF);
      comp._pendingHighlightRAF = null;
    }

    // Reset FET state so next question can emit freely
    try {
      this.explanationTextService._fetLocked = false;
      this.explanationTextService.unlockExplanation();
      const newIdx = comp.currentQuestionIndex ?? comp.questionIndex() ?? 0;
      this.explanationTextService._activeIndex = newIdx;
      this.explanationTextService.latestExplanationIndex = newIdx;
    } catch (err: unknown) {
      console.error('SharedOptionInitService.resetStateForNewQuestion FET state reset failed:', err);
    }
  }

  /**
   * Subscribes to timer expired$ events.
   * Corresponds to SharedOptionComponent.subscribeToTimerExpiration().
   */
  subscribeToTimerExpiration(comp: SharedOptionComponentLike): void {
    this.timerService.expired$.pipe(takeUntilDestroyed(comp.destroyRef)).subscribe(() => {
      // TIME IS UP — that is ALL this subscriber may conclude.
      //
      // It used to also rebuild `timeoutCorrectOptionKeys` from the local bank
      // (option.correct, then optionId, then text). That made it a SECOND,
      // racing source of timeout correctness: this and the orchestrator's
      // authorized reveal both subscribe to the same `expired$` emission, so
      // whichever ran last won — and this one could overwrite verdict-derived
      // keys with locally-derived ones.
      //
      // Timeout correctness now comes from exactly one place:
      // QuestionVerdictService.revealExpiredQuestion() -> correctOptionTexts,
      // written by QqcOrchTimerService. Painting waits for that verdict rather
      // than filling the gap from data that is about to stop existing.
      comp.timerExpiredForQuestion.set(true);
      comp.cdRef.markForCheck();
    });
  }

  /**
   * Retry logic for rendering / fallback display.
   * Corresponds to SharedOptionComponent.setupFallbackRendering().
   */
  setupFallbackRendering(comp: SharedOptionComponentLike): void {
    // Stackblitz can be slower, so we retry at multiple intervals before
    // showing the fallback message
    const checkAndRetry = (attempt: number) => {
      const maxAttempts = 5;  // increased for Stackblitz
      const delays = [100, 200, 400, 800, 1500];  // progressive delays for retries

      setTimeout(() => {
        // If options are now ready, try to initialize them
        if (comp.optionsToDisplay?.length && !comp.optionBindings()?.length) {
          comp.generateOptionBindings();
          comp.cdRef.markForCheck();  // force immediate update for OnPush
          return;
        }

        // If we have options and bindings but display flags aren't set, fix them
        if (comp.optionsToDisplay?.length && comp.optionBindings()?.length) {
          if (!comp.showOptions() || !comp.renderReady()) {

            comp.showOptions.set(true);
            comp.renderReady.set(true);
            comp.optionsReady = true;
            comp.showNoOptionsFallback = false;
            comp.cdRef.markForCheck();  // force immediate update for OnPush
          }
          return;
        }

        // If we've exhausted retries, show fallback
        if (attempt >= maxAttempts) {
          if (!comp.renderReady() || !comp.optionsToDisplay?.length) {
            comp.showNoOptionsFallback = true;
            comp.cdRef.markForCheck();  // force immediate update for OnPush
          }
          return;
        }

        // Try again
        checkAndRetry(attempt + 1);
      }, delays[attempt - 1] || 1500);
    };

    checkAndRetry(1);
  }

  /**
   * Config initialization.
   * Corresponds to SharedOptionComponent.initializeConfiguration().
   */
  initializeConfiguration(comp: SharedOptionComponentLike): void {
    this.initializeFromConfig(comp);
  
    const cfg = comp.config();
    const configOptions = cfg?.optionsToDisplay;
  
    if (configOptions?.length) {
      comp.optionsToDisplay = configOptions;
    }
  
    comp.renderReady.set(!!comp.optionsToDisplay?.length);
  }

  /**
   * Initialize option display with feedback.
   * Corresponds to SharedOptionComponent.initializeOptionDisplayWithFeedback().
   */
  private initializeOptionBindings(comp: SharedOptionComponentLike): void {
    try {
      if (comp.optionBindingsInitialized()) return;

      comp.optionBindingsInitialized.set(true);

      const options = comp.optionsToDisplay;

      if (!options?.length) {
        comp.optionBindingsInitialized.set(false);
        return;
      }

      // Use generateOptionBindings for consistency (handles deduplication, showOptions, etc.)
      comp.generateOptionBindings();
    } catch (err: unknown) {
      console.error('SharedOptionInitService.initializeOptionBindings binding init failed:', err);
      comp.optionBindingsInitialized.set(false);
    }
  }

  initializeOptionDisplayWithFeedback(comp: SharedOptionComponentLike): void {
    this.initializeOptionBindings(comp);
    comp.synchronizeOptionBindings();

    // Initialize display flags if form and bindings are ready
    if (
      comp.form &&
      comp.optionBindings()?.length > 0 &&
      comp.optionsToDisplay?.length > 0
    ) {
      comp.renderReady.set(true);
      comp.viewReady.set(true);
    }

    // Initial feedback generation for Q1
    if (comp.currentQuestionIndex >= 0 && comp.optionsToDisplay?.length > 0) {
      comp.regenerateFeedback(comp.currentQuestionIndex);
    }

    // Immediately set display flags if options are available
    if (comp.optionsToDisplay?.length > 0) {
      comp.renderReady.set(true);
      comp.showOptions.set(true);
      comp.optionsReady = true;
      comp.cdRef.markForCheck();
    }

    // Fallback: retry after short delay for Stackblitz timing issues
    setTimeout(() => {
      if (comp.optionsToDisplay?.length > 0 && !comp.showOptions()) {
        comp.renderReady.set(true);
        comp.showOptions.set(true);
        comp.optionsReady = true;
        comp.cdRef.markForCheck();
      }
    }, 50);
  }

  /**
   * The main reactive pipeline that listens for question index changes via combineLatest.
   * Corresponds to SharedOptionComponent.setupSubscriptions().
   */
  setupSubscriptions(comp: SharedOptionComponentLike): void {
    this.wireFinalRenderReady(comp);
    this.wireIndexOptionsFeedback(comp);
  }

  /** Mirror finalRenderReady$ into comp.finalRenderReady. */
  private wireFinalRenderReady(comp: SharedOptionComponentLike): void {
    const finalReady$ = comp.finalRenderReady$();
    if (!finalReady$) return;
    finalReady$
      .pipe(takeUntilDestroyed(comp.destroyRef))
      .subscribe((ready: boolean) => {
        comp.finalRenderReady = ready;
      });
  }

  /** Regenerate feedback when the question index or latest options change (combined to avoid races). */
  private wireIndexOptionsFeedback(comp: SharedOptionComponentLike): void {
    const optionsToDisplay$ = comp.optionsToDisplay$ ?? of([] as Option[]);
    combineLatest([
      this.quizService.currentQuestionIndex$.pipe(distinctUntilChanged()),
      optionsToDisplay$
    ])
      .pipe(takeUntilDestroyed(comp.destroyRef))
      .subscribe(([idx, opts]: [number, Option[]]) => this.handleIndexOptionsChange(comp, idx, opts));
  }

  private handleIndexOptionsChange(comp: SharedOptionComponentLike, idx: number, opts: Option[]): void {
    // lastProcessedQuestionIndex is the internal tracker; the @Input may lag this emission.
    if (comp.lastProcessedQuestionIndex !== idx) {
      this.applyQuestionChangeReset(comp, idx, opts);
    }
    this.regenerateFeedbackForIndex(comp, idx, opts);
    comp.cdRef.markForCheck();
  }

  /**
   * On question change: ignore the stale BehaviorSubject(0) emission, else reset
   * interaction flags + (when bindings don't already align and nothing persisted)
   * clear visual state, then advance the trackers. Extracted verbatim.
   */
  private applyQuestionChangeReset(comp: SharedOptionComponentLike, idx: number, opts: Option[]): void {
    if (this.isStaleBehaviorSubjectIdx(idx)) return;

    const bindingsAlignWithOpts = this.bindingsAlignWithOptions(comp, opts);
    let hasPersistedForIdx = false;
    try {
      const persisted = this.selectedOptionService.getSelectedOptionsForQuestion(idx) ?? [];
      hasPersistedForIdx = persisted.length > 0;
    } catch (err: unknown) { swallow('shared-option-init.service.ts applyQuestionChangeReset', err); }

    // Always reset interaction flags so generateOptionBindings doesn't early-return.
    comp.hasUserClicked.set(false);
    comp.optionBindingsInitialized.set(false);

    if (!bindingsAlignWithOpts && !hasPersistedForIdx) {
      this.resetStateForNewQuestion(comp);
      this.clearOptionVisualState(comp);
    }

    comp.lastProcessedQuestionIndex = idx;
    if (comp.currentQuestionIndex !== idx) {
      comp.currentQuestionIndex = idx;
    }
    comp.cdRef.markForCheck();
  }

  /** The index emission is the stale BehaviorSubject(0) when it disagrees with the URL index. */
  private isStaleBehaviorSubjectIdx(idx: number): boolean {
    let urlQuestionIdx = -1;
    try {
      const m = window.location.pathname.match(QUESTION_ROUTE_REGEX);
      if (m) urlQuestionIdx = Number(m[1]) - 1;
    } catch (err: unknown) { swallow('shared-option-init.service.ts isStaleBehaviorSubjectIdx', err); }
    return urlQuestionIdx >= 0 && idx !== urlQuestionIdx;
  }

  /** Do the current bindings' optionIds already match the new question's options? */
  private bindingsAlignWithOptions(comp: SharedOptionComponentLike, opts: Option[]): boolean {
    const bindingIds = (comp.optionBindings() ?? [])
      .map((b: any) => b?.option?.optionId)
      .filter((id: any) => id != null && id !== -1);
    const optsIds = (opts ?? [])
      .map((o: Option) => o?.optionId)
      .filter((id: any) => id != null && id !== -1);
    return bindingIds.length > 0 &&
      optsIds.length > 0 &&
      bindingIds.length === optsIds.length &&
      bindingIds.every((id: any) => optsIds.includes(id));
  }

  /** Clear highlight/feedback state and reset every binding's visual flags. Extracted verbatim. */
  private clearOptionVisualState(comp: SharedOptionComponentLike): void {
    comp.highlightedOptionIds.clear();
    comp.selectedOptions.clear();
    comp.feedbackConfigs = {};
    comp.showFeedback.set(false);
    comp.showFeedbackForOption = {};
    for (const b of comp.optionBindings() ?? []) {
      b.isSelected = false;
      b.showFeedback = false;
      b.highlightCorrect = false;
      b.highlightIncorrect = false;
      b.highlightCorrectAfterIncorrect = false;
      b.disabled = false;
      if (b.option) {
        b.option.selected = false;
        b.option.showIcon = false;
      }
    }
  }

  /** Rebuild feedback configs for the question at idx and keep feedback on the last-selected option. */
  private regenerateFeedbackForIndex(comp: SharedOptionComponentLike, idx: number, opts: Option[]): void {
    if (!(idx >= 0 && Array.isArray(opts) && opts.length > 0)) return;
    const question = comp.getQuestionAtDisplayIndex(idx);
    if (!question?.options) return;

    const selections = this.selectedOptionService.getSelectedOptionsForQuestion(idx) || [];
    const freshFeedback = this.feedbackService.buildFeedbackMessage(
      question, selections, false, false, idx, comp.optionsToDisplay
    );

    comp.feedbackConfigs = {};
    comp.activeFeedbackConfig.set(null);

    const { lastSelectedId, hasSelection } = this.applyFeedbackConfigsToBindings(comp, opts, question, freshFeedback);

    if (hasSelection) {
      comp.showFeedback.set(true);
      // Keep feedback on the most recently clicked option unless it's still valid.
      const isCurrentFeedbackSelected =
        comp.lastFeedbackOptionId !== -1 &&
        comp.selectedOptions.has(comp.lastFeedbackOptionId);
      if (!isCurrentFeedbackSelected) {
        comp.lastFeedbackOptionId = lastSelectedId;
      }
    }
  }

  /** Write fresh feedback into every binding + its feedback config; return the last-selected id. Extracted verbatim. */
  private applyFeedbackConfigsToBindings(comp: SharedOptionComponentLike, opts: Option[], question: any, freshFeedback: string): { lastSelectedId: number; hasSelection: boolean } {
    let lastSelectedId = -1;
    let hasSelection = false;
    for (const [i, b] of (comp.optionBindings() ?? []).entries()) {
      if (!b.option) continue;

      b.option.feedback = freshFeedback;
      b.feedback = freshFeedback;

      const key = comp.keyOf(b.option, i);
      const optId = (b.option.optionId != null && b.option.optionId > -1) ? b.option.optionId : i;

      if (b.isSelected) {
        lastSelectedId = optId;
        hasSelection = true;
      }

      comp.feedbackConfigs[key] = {
        feedback: freshFeedback,
        showFeedback: true,
        options: opts,
        question: question,
        selectedOption: b.option,
        correctMessage: freshFeedback,
        idx: b.index
      };

      if (comp.feedbackConfigs[key].showFeedback) {
        comp.activeFeedbackConfig.set(comp.feedbackConfigs[key]);
      }
    }
    return { lastSelectedId, hasSelection };
  }

  /**
   * Subscribes to selectedOption$ changes.
   * Corresponds to SharedOptionComponent.subscribeToSelectionChanges().
   */
  subscribeToSelectionChanges(comp: SharedOptionComponentLike): void {
    this.selectedOptionService.selectedOption$
      .pipe(
        distinctUntilChanged(
          (prev, curr) => JSON.stringify(prev) === JSON.stringify(curr)
        ),
        observeOn(animationFrameScheduler),
        takeUntilDestroyed(comp.destroyRef)
      )
      .subscribe((incoming) => {
        const selList: SelectedOption[] = Array.isArray(incoming)
          ? incoming
          : incoming
            ? [incoming]
            : [];

        comp.applySelectionsUI(selList);

        const selectedIds = selList.map((s) => s.optionId);

        const selId = comp.selectedOptionId();
        if (selId != null) {
          comp.isSelected.set(selectedIds.includes(selId));
        } else {
          comp.isSelected.set(false);
        }

        comp.cdRef.markForCheck();
      });
  }

  /**
   * Setup rehydrate triggers.
   * Corresponds to SharedOptionComponent.setupRehydrateTriggers().
   */
  setupRehydrateTriggers(comp: SharedOptionComponentLike): void {
    // renderReadySubject was replaced with a signal in commit 2e084f59;
    // fall back to of(false) when no parent finalRenderReady$ is provided
    // so this trigger is a no-op rather than throwing on undefined.
    const renderReady$ = comp.finalRenderReady$() ?? of(false);

    const qIndex$ = this.quizService?.currentQuestionIndex$ ?? of(0);

    combineLatest([renderReady$, qIndex$])
      .pipe(
        filter(([ready, _index]: [boolean, number]) => ready === true),
        takeUntilDestroyed(comp.destroyRef)
      )
      .subscribe(() => {
        // Ensure bindings exist
        if (!comp.optionBindings()?.length && comp.optionsToDisplay?.length) {
          comp.generateOptionBindings();
        }

        // Hydrate selection + highlighting from persisted state
        comp.rehydrateUiFromState('renderReady/qIndex');
      });
  }

  /**
   * Complex config-based initialization.
   * Corresponds to SharedOptionComponent.initializeFromConfig().
   */
  initializeFromConfig(comp: SharedOptionComponentLike): void {
    if (comp.freezeOptionBindings() || comp.hasUserClicked()) return;

    this.resetComponentStateForInit(comp);

    // Guard: Config or options missing
    const cfg2 = comp.config();
    if (!cfg2 || !cfg2.optionsToDisplay?.length) return;

    // Assign current question
    comp.currentQuestion.set(cfg2.currentQuestion);

    // Validate currentQuestion before proceeding
    const cqAfterAssign = comp.currentQuestion();
    if (!cqAfterAssign || !Array.isArray(cqAfterAssign.options)) {
      return;
    }

    comp.optionsToDisplay = this.buildInitialOptionsToDisplay(cqAfterAssign);
    if (!comp.optionsToDisplay.length) return;

    const qIndex = this.resolveQuestionIndexByContent(comp);
    this.rehydrateSavedSelections(comp, qIndex);
    this.applyAuthoritativeQuestionType(comp, qIndex);

    // Initialize bindings and feedback maps
    comp.setOptionBindingsIfChanged(comp.optionsToDisplay);
    comp.initializeFeedbackBindings();

    comp.finalizeOptionPopulation();
  }

  // Full reset of the component's option/selection state.
  private resetComponentStateForInit(comp: SharedOptionComponentLike): void {
    comp.optionBindings.set([]);
    comp.selectedOption.set(null);
    comp.selectedOptionIndex.set(-1);
    comp.showFeedbackForOption = {};
    comp.correctMessage.set('');
    comp.showFeedback.set(false);
    comp.shouldResetBackground.set(false);
    comp.optionsRestored = false;
    comp.currentQuestion.set(null);
    comp.optionsToDisplay = [];
  }

  // Populate optionsToDisplay with structured data from the question options.
  private buildInitialOptionsToDisplay(cqAfterAssign: QuizQuestion): Option[] {
    return cqAfterAssign.options.map((opt, idx) => {
      // Ensure we have a unique and valid numeric optionId
      // Fallback to index if source is missing ID or has placeholder -1
      const rawId = opt.optionId;
      const finalId = (rawId !== undefined && rawId !== null && String(rawId) !== '-1') ? rawId : idx;

      return {
        ...opt,
        optionId: finalId,
        correct: opt.correct ?? false,
        feedback: typeof opt.feedback === 'string' ? opt.feedback.trim() : '',
        selected: opt.selected ?? false,
        active: true,
        showIcon: false
      };
    });
  }

  // Resolve index via content matching to avoid race conditions between Service
  // and Input. We search the QuizService for the question that actually contains
  // these options, falling back to the input index.
  private resolveQuestionIndexByContent(comp: SharedOptionComponentLike): number {
    let qIndex = this.quizService.currentQuestionIndex ?? 0;
    const inputIndex = comp.resolveCurrentQuestionIndex();

    if (this.quizService.questions && comp.optionsToDisplay?.length > 0) {
      const firstOptId = comp.optionsToDisplay[0].optionId;
      const matchIdx = this.quizService.questions.findIndex((q: QuizQuestion) =>
        q.options?.some((o: Option) => o.optionId === firstOptId)
      );

      if (matchIdx !== -1) {
        comp.resolvedQuestionIndex = matchIdx;
        qIndex = matchIdx; // Found authentic index via content match
      } else {
        // No match found? Fallback to input index if valid
        if (Number.isFinite(inputIndex)) {
          comp.resolvedQuestionIndex = inputIndex;
          qIndex = inputIndex;
        }
      }
    }
    return qIndex;
  }

  // Rehydrate selection state from the Service (persistence) so options show as
  // selected (Green/Red) when navigating back.
  private rehydrateSavedSelections(comp: SharedOptionComponentLike, qIndex: number): void {
    const saved = this.selectedOptionService.getSelectedOptionsForQuestion(qIndex);
    if (!(saved?.length > 0)) return;

    // Match saved selections to options by optionId/text FIRST (stable),
    // falling back to displayIndex only when no id/text match is found.
    // Pure displayIndex matching caused false positives when stale data
    // from a different question had the same index.
    for (let idx = 0; idx < comp.optionsToDisplay.length; idx++) {
      const opt = comp.optionsToDisplay[idx];
      const optText = norm(opt.text);
      const optId = opt.optionId;
      const optIdReal = optId != null && optId !== -1 && String(optId) !== '-1';

      let matchedSaved: any = null;
      const isSaved = saved.some(s => {
        // Skip unselect traces that lack visual flags
        if ((s as any)?.selected === false && !(s as any)?.showIcon && !(s as any)?.highlight) {
          return false;
        }
        const sId = (s as any).optionId;
        const sIdReal = sId != null && sId !== -1 && String(sId) !== '-1';
        const sText = norm((s as any).text);
        // Match by optionId
        if (optIdReal && sIdReal && String(optId) === String(sId)) {
          matchedSaved = s;
          return true;
        }
        // Match by text
        if (optText && sText && optText === sText) {
          matchedSaved = s;
          return true;
        }
        // Fallback: displayIndex only when id/text didn't match
        // AND when text is unavailable on either side. If both sides
        // have text but it didn't match above, the position coincidence
        // is a false positive (e.g. options shuffled on refresh).
        const sIdx = (s as any).displayIndex ?? (s as any).index;
        if (sIdx !== idx) return false;
        // Position matches - only accept if we can't verify by text
        const sText2 = norm((s as any).text);
        if (optText && sText2 && optText !== sText2) return false;
        matchedSaved = s;
        return true;
      });

      if (isSaved) {
        // Honor saved `selected` flag: prev-clicked entries (selected:false
        // + highlight:true + showIcon:true) must render dark gray, not white.
        // Unconditionally setting opt.selected=true promoted them to the
        // currently-selected semantic.
        const savedSelected = (matchedSaved as any)?.selected;
        opt.selected = savedSelected === false ? false : true;
        opt.showIcon = true;
        (opt as any).highlight = true;
        if (opt.selected) {
          const effectiveId = (opt.optionId != null && opt.optionId !== -1) ? opt.optionId : idx;
          comp.selectedOptions.add(Number(effectiveId));
        }
      }
    }
  }

  // Determine question type based on options, but respect explicit input first.
  // Use authoritative question from service to ensure 'correct' flags are present.
  private applyAuthoritativeQuestionType(comp: SharedOptionComponentLike, qIndex: number): void {
    const authoritativeQuestion = this.quizService.questions[qIndex] || comp.currentQuestion();
    if (comp.type !== 'multiple' && authoritativeQuestion) {
      comp.type = comp.determineQuestionType(authoritativeQuestion);
    }
  }
}