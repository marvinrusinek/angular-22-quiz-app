import { inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { take } from 'rxjs/operators';

import { Option } from '@shared/models/Option.model';
import { QuizQuestion } from '@shared/models/QuizQuestion.model';

import { ExplanationTextService } from '@shared/services/features/explanation/explanation-text.service';
import { NextButtonStateService } from '@shared/services/state/next-button-state.service';
import { QqcStatePersistenceService } from '@shared/services/state/qqc-state-persistence.service';
import { QuizDotStatusService } from '@shared/services/flow/quiz-dot-status.service';
import { QuizService } from '@shared/services/data/quiz.service';
import { QuizStateService } from '@shared/services/state/quizstate.service';
import { SelectedOptionService } from '@shared/services/state/selectedoption.service';
import { TimerService } from '@shared/services/features/timer/timer.service';

import { delay } from '@shared/utils/delay';

/**
 * Manages navigation-related logic for QuizQuestionComponent:
 * - Visibility change handling (tab switch, background/foreground)
 * - Route parameter processing for question navigation
 * - Quiz state restoration after tab switches
 * - Display subscription lifecycle for page visibility
 *
 * Extracted from QuizQuestionComponent to reduce its size.
 */
@Service()
export class QqcNavigationHandlerService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly dotStatusService = inject(QuizDotStatusService);
  private readonly explanationTextService = inject(ExplanationTextService);
  private readonly nextButtonStateService = inject(NextButtonStateService);
  private readonly quizService = inject(QuizService);
  private readonly quizStateService = inject(QuizStateService);
  private readonly selectedOptionService = inject(SelectedOptionService);
  private readonly statePersistence = inject(QqcStatePersistenceService);
  private readonly timerService = inject(TimerService);

  // ── remaining variables ─────────────────────────────────────────
  /** Tracks whether the page was hidden (for FET purge logic) */
  private _wasHidden = false;

  /** Performance timestamp when the page was hidden */
  private _hiddenAt: number | null = null;

  /** Elapsed timer value captured when the page was hidden */
  private _elapsedAtHide: number | null = null;

  // ═══════════════════════════════════════════════════════════════
  // VISIBILITY STATE PERSISTENCE
  // ═══════════════════════════════════════════════════════════════

  /**
   * Persists the current FET display state when the page goes hidden.
   * Called on `visibilityState === 'hidden'`.
   */
  persistStateOnHide(params: {
    quizId: string;
    currentQuestionIndex: number;
    displayExplanation: boolean;
  }): void {
    const { quizId, currentQuestionIndex: idx, displayExplanation } = params;

    try {
      const qState = this.quizStateService.getQuestionState(quizId, idx)
        || this.quizStateService.createDefaultQuestionState();

      this.quizStateService.setQuestionState(quizId, idx, {
        isAnswered: qState.isAnswered ?? false,
        selectedOptions: qState.selectedOptions ?? [],
        isCorrect: qState.isCorrect,
        numberOfCorrectAnswers: qState.numberOfCorrectAnswers,
        explanationDisplayed: displayExplanation,
        explanationText: this.explanationTextService.latestExplanation ?? ''
      });
    } catch { }
  }

  /**
   * Resets explanation state before the page goes to the background.
   * Prevents stale FET from replaying on restore.
   */
  resetExplanationStateOnHide(): void {
    try {
      const ets = this.explanationTextService;
      ets.setShouldDisplayExplanation(false);
      ets.setIsExplanationTextDisplayed(false);
      ets.updateFormattedExplanation('');
      ets._activeIndex = -1;
      ets.latestExplanation = '';
    } catch { }
  }

  /**
   * Captures the elapsed timer value when the page goes hidden.
   */
  async captureElapsedOnHide(): Promise<void> {
    try {
      const snap = await firstValueFrom<number>(
        this.timerService.elapsedTime$.pipe(take(1))
      );
      this._elapsedAtHide = snap;
    } catch {
      this._elapsedAtHide = null;
    }

    this._hiddenAt = performance.now();
    this._wasHidden = true;
  }

  /**
   * Checks if the timer has expired while the page was hidden.
   * Returns the index to expire, or null if no expiration needed.
   */
  async checkFastPathExpiry(params: {
    currentQuestionIndex: number;
    displayExplanation: boolean;
    normalizeIndex: (idx: number) => number;
  }): Promise<{ shouldExpire: boolean; expiredIndex: number }> {
    const { currentQuestionIndex, displayExplanation, normalizeIndex } = params;

    try {
      const duration = this.timerService.timePerQuestion ?? 30;

      const elapsedLive = await firstValueFrom<number>(
        this.timerService.elapsedTime$.pipe(take(1))
      );

      let candidate = elapsedLive;
      if (this._hiddenAt != null && this._elapsedAtHide != null) {
        const hiddenDeltaSec = Math.floor((performance.now() - this._hiddenAt) / 1000);
        candidate = this._elapsedAtHide + hiddenDeltaSec;
      }

      if (candidate >= duration) {
        const i0 = normalizeIndex(currentQuestionIndex ?? 0);

        const alreadyShowing =
          displayExplanation ||
          (await firstValueFrom<boolean>(
            this.explanationTextService.shouldDisplayExplanation$.pipe(take(1))
          ));

        if (!alreadyShowing) {
          this._hiddenAt = null;
          this._elapsedAtHide = null;
          return { shouldExpire: true, expiredIndex: i0 };
        }
      }

      this._hiddenAt = null;
      this._elapsedAtHide = null;
    } catch {    }

    return { shouldExpire: false, expiredIndex: -1 };
  }

  // ═══════════════════════════════════════════════════════════════
  // STATE RESTORATION
  // ═══════════════════════════════════════════════════════════════

  /**
   * Restores core quiz state from persistence after a visibility change.
   * Returns the restored state for the component to apply.
   */
  restoreQuizState(params: {
    currentQuestionIndex: number;
    optionsToDisplay: Option[];
  }): {
    explanationText: string;
    displayMode: string;
    parsedOptions: Option[] | null;
    selectedOptions: any[];
    feedbackText: string;
    optionsToDisplay: Option[];
  } {
    try {
      const restored = this.statePersistence.restoreState(params.currentQuestionIndex);
      let optionsToDisplay = params.optionsToDisplay;

      // Restore options
      if (restored.parsedOptions) {
        const storageIndex =
          typeof params.currentQuestionIndex === 'number' && !Number.isNaN(params.currentQuestionIndex)
            ? params.currentQuestionIndex
            : 0;
        optionsToDisplay = this.quizService.quizOptions.assignOptionIds(restored.parsedOptions, storageIndex);
      }

      // Fallback: use last known options if still empty
      if (!optionsToDisplay || optionsToDisplay.length === 0) {
        const lastKnownOptions = this.quizService.getLastKnownOptions();
        if (lastKnownOptions && lastKnownOptions.length > 0) {
          optionsToDisplay = [...lastKnownOptions];
        }
      }

      // Restore selected options
      for (const option of restored.selectedOptions) {
        this.selectedOptionService.setSelectedOption(option);
      }

      // Mark that at least one full restore has occurred
      this.quizStateService.hasRestoredOnce = true;
      return {
        explanationText: restored.explanationText,
        displayMode: restored.displayMode,
        parsedOptions: restored.parsedOptions,
        selectedOptions: restored.selectedOptions,
        feedbackText: restored.feedbackText,
        optionsToDisplay
      };
    } catch {
      return {
        explanationText: '',
        displayMode: 'question',
        parsedOptions: null,
        selectedOptions: [],
        feedbackText: '',
        optionsToDisplay: params.optionsToDisplay
      };
    }
  }

  /**
   * Restores the FET display state after visibility change.
   * Returns whether explanation should be displayed.
   */
  restoreFetDisplayState(params: {
    quizId: string;
    currentQuestionIndex: number;
  }): { shouldShowExplanation: boolean; explanationText: string } {
    const { quizId, currentQuestionIndex: qIdx } = params;

    try {
      const qState = this.quizStateService.getQuestionState(quizId, qIdx);
      // Only restore FET display when THIS question's persisted state says
      // it was being displayed AND has its own explanation text. Falling
      // back to the global shouldDisplayExplanation$ flag or to
      // latestExplanation lets a previously-answered question's FET (e.g.
      // Q1) bleed onto an unanswered Q2 on tab return.
      const ownFetText = (typeof qState?.explanationText === 'string'
        ? qState.explanationText.trim() : '');
      const thisQHasOwnFet = qState?.explanationDisplayed === true
        && ownFetText.length > 0;

      // A durably timed-out question always shows its FET on tab return —
      // and counts as answered so the Next button stays enabled — even when
      // the persisted state didn't capture the explanation text. Mirrors the
      // heading FET re-assertion gated on the same durable timeout flag.
      const durablyTimedOut = this.dotStatusService?.timedOutFetForced?.has(qIdx) === true;
      const fallbackFetText = durablyTimedOut
        ? (ownFetText
            || this.explanationTextService.fetByIndex?.get(qIdx)?.trim()
            || (this.explanationTextService.formattedExplanations?.[qIdx]?.explanation ?? '').trim())
        : '';

      const showFet = thisQHasOwnFet || durablyTimedOut;
      const fetText = thisQHasOwnFet ? ownFetText : fallbackFetText;

      if (showFet) {
        this.explanationTextService.setShouldDisplayExplanation(true, { force: true });
        this.explanationTextService.setIsExplanationTextDisplayed(true, { force: true });
        if (fetText) {
          this.explanationTextService.setExplanationText(fetText, { force: true });
        }
        // A timed-out question is answered — re-assert so the Next-button
        // stream (driven by selectedOptionService.isAnswered$) stays enabled
        // on tab return, even with no options selected.
        if (durablyTimedOut) {
          try { this.selectedOptionService.setAnswered(true, true); } catch { }
          try { this.nextButtonStateService.setNextButtonState(true); } catch { }
        }
      } else {
        this.explanationTextService.setShouldDisplayExplanation(false, { force: true });
        this.explanationTextService.setIsExplanationTextDisplayed(false, { force: true });
      }

      return {
        shouldShowExplanation: showFet,
        explanationText: fetText
      };
    } catch {
      return { shouldShowExplanation: false, explanationText: '' };
    }
  }

  /**
   * Handles FET purge logic when user navigated to another question while hidden.
   */
  purgeFetIfNavigatedWhileHidden(currentQuestionIndex: number): void {
    if (this._wasHidden && 
      currentQuestionIndex !== this.explanationTextService._activeIndex
    ) {
      this.explanationTextService.purgeAndDefer(currentQuestionIndex);
    }

    this._wasHidden = false;
  }

  /**
   * Refreshes explanation state after the restore phase completes.
   */
  refreshExplanationStatePostRestore(currentQuestionIndex: number): void {
    try {
      const ets = this.explanationTextService;
      ets._activeIndex = currentQuestionIndex;
      ets.updateFormattedExplanation('');
      ets.latestExplanation = '';
      ets.setShouldDisplayExplanation(false);
      ets.setIsExplanationTextDisplayed(false);
    } catch { }
  }

  // ═══════════════════════════════════════════════════════════════
  // ROUTE HANDLING
  // ═══════════════════════════════════════════════════════════════

  /**
   * Parses a route parameter into a 0-based question index.
   * Returns the clamped, valid index.
   */
  parseRouteIndex(rawParam: string | null, totalQuestions: number): number {
    const parsedParam = Number(rawParam);
    let questionIndex = isNaN(parsedParam) ? 1 : parsedParam;

    if (questionIndex < 1 || questionIndex > totalQuestions) questionIndex = 1;

    return questionIndex - 1;  // convert to 0-based
  }

  /**
   * Handles page visibility state change (pause/resume).
   */
  handlePageVisibilityChange(
    isHidden: boolean,
    callbacks: {
      clearDisplaySubscriptions: () => void;
      prepareAndSetExplanationText: (index: number) => Promise<string>;
      currentQuestionIndex: number;
    }
  ): { isPaused: boolean } {
    if (isHidden) {
      callbacks.clearDisplaySubscriptions();
      return { isPaused: true };
    } else {
      callbacks.prepareAndSetExplanationText(callbacks.currentQuestionIndex);
      return { isPaused: false };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // FAST-PATH EXPIRY (VISIBLE PHASE)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Checks if the timer expired while the page was hidden and handles
   * the fast-path expiry flow. Returns whether the component should
   * short-circuit the rest of the onVisibilityChange handler.
   *
   * The component should call `onTimerExpiredFor(expiredIndex)` if
   * `shouldExpire` is true.
   */
  async handleFastPathExpiry(params: {
    currentQuestionIndex: number;
    displayExplanation: boolean;
    normalizeIndex: (idx: number) => number;
  }): Promise<{ shouldExpire: boolean; expiredIndex: number }> {
    return await this.checkFastPathExpiry(params);
  }

  // ═══════════════════════════════════════════════════════════════
  // FULL VISIBILITY RESTORE FLOW
  // ═══════════════════════════════════════════════════════════════

  /**
   * Orchestrates the full restore flow when the page becomes visible.
   * This combines purging stale FET, restoring quiz state, and
   * restoring FET display state into a single coordinated call.
   *
   * Returns the restore results for the component to apply to its
   * local state.
   */
  handleVisibilityRestore(params: {
    quizId: string;
    currentQuestionIndex: number;
    optionsToDisplay: any[];
  }): {
    restoredState: {
      explanationText: string;
      displayMode: string;
      parsedOptions: any[] | null;
      selectedOptions: any[];
      feedbackText: string;
      optionsToDisplay: any[];
    };
    fetState: {
      shouldShowExplanation: boolean;
      explanationText: string;
    };
  } {
    const { quizId, currentQuestionIndex, optionsToDisplay } = params;

    // 1. Purge stale FET if user navigated while hidden
    this.purgeFetIfNavigatedWhileHidden(currentQuestionIndex);

    // 2. Restore core quiz state
    const restoredState = this.restoreQuizState({
      currentQuestionIndex,
      optionsToDisplay
    });

    // 3. Restore FET display state
    const fetState = this.restoreFetDisplayState({
      quizId,
      currentQuestionIndex
    });

    return { restoredState, fetState };
  }

  // ═══════════════════════════════════════════════════════════════
  // DISPLAY STATE GUARD
  // ═══════════════════════════════════════════════════════════════

  /**
   * Guard wrapper for display state changes.
   * Suppresses any update while restoration lock is active or within the debounce window.
   * Returns true if the update was allowed, false if suppressed.
   */
  guardDisplayStateUpdate(params: {
    state: { mode: 'question' | 'explanation'; answered: boolean };
    visibilityRestoreInProgress: boolean;
    suppressDisplayStateUntil: number;
  }): boolean {
    if (params.visibilityRestoreInProgress || 
      performance.now() < params.suppressDisplayStateUntil
    ) return false;  // suppressed
    
    return true;  // allowed
  }

  /**
   * Computes the display subscription cleanup state when page becomes hidden.
   * Returns the reset values for explanation display.
   * Extracted from clearDisplaySubscriptions().
   */
  computeDisplaySubscriptionCleanup(): {
    explanationToDisplay: string;
    showExplanation: boolean;
  } {
    return {
      explanationToDisplay: '',
      showExplanation: false
    };
  }

  /**
   * Determines the action to take when page visibility changes.
   * Returns whether to pause or resume, and triggers explanation refresh if resuming.
   * Extracted from handlePageVisibilityChange().
   */
  computeVisibilityAction(isHidden: boolean): {
    isPaused: boolean;
    shouldClearSubscriptions: boolean;
    shouldRefreshExplanation: boolean;
  } {
    if (isHidden) {
      return {
        isPaused: true,
        shouldClearSubscriptions: true,
        shouldRefreshExplanation: false
      };
    } else {
      return {
        isPaused: false,
        shouldClearSubscriptions: false,
        shouldRefreshExplanation: true
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // FULL VISIBLE RESTORE BODY
  // ═══════════════════════════════════════════════════════════════

  /**
   * Performs the full restore flow when the page becomes visible.
   * Repopulates options if needed, restores feedback and selection state,
   * generates feedback text, and applies FET display state.
   *
   * Returns the fully resolved restore result for the component to apply
   * any remaining UI state (e.g. emitters, change detection).
   *
   * Extracted from onVisibilityChange visible-restore block (lines 938–1031).
   */
  async performFullVisibilityRestore(params: {
    quizId: string;
    currentQuestionIndex: number;
    optionsToDisplay: Option[];
    currentQuestion: QuizQuestion | null;
    generateFeedbackText: (question: QuizQuestion) => Promise<string>;
    applyOptionFeedback: (option: Option) => void;
    restoreFeedbackState: () => void;
  }): Promise<{
    currentExplanationText: string;
    displayMode: string;
    optionsToDisplay: Option[];
    feedbackText: string;
    shouldShowExplanation: boolean;
  }> {
    // 1. Delegate core restore logic to handleVisibilityRestore
    const { restoredState, fetState } = this.handleVisibilityRestore({
      quizId: params.quizId,
      currentQuestionIndex: params.currentQuestionIndex,
      optionsToDisplay: params.optionsToDisplay
    });

    // Apply restored state
    let optionsToDisplay = restoredState.optionsToDisplay;
    let feedbackText = restoredState.feedbackText;

    // Mark that restoration has occurred
    this.quizStateService.hasRestoredOnce = true;

    // Ensure options are ready (fallback if restore returned empty)
    if (!Array.isArray(optionsToDisplay) || optionsToDisplay.length === 0) {
      if (params.currentQuestion && Array.isArray(params.currentQuestion.options)) {
        optionsToDisplay = params.currentQuestion.options.map((option, index) => ({
          ...option,
          optionId: option.optionId ?? index,
          correct: option.correct ?? false
        }));
      } else {
        return {
          currentExplanationText: restoredState.explanationText,
          displayMode: restoredState.displayMode,
          optionsToDisplay,
          feedbackText,
          shouldShowExplanation: false
        };
      }
    }

    // Restore feedback and selection
    if (params.currentQuestion) {
      params.restoreFeedbackState();

      setTimeout(() => {
        const prevOpt = optionsToDisplay.find(o => o.selected);
        if (prevOpt) {
          params.applyOptionFeedback(prevOpt);
        }
      }, 50);

      try {
        feedbackText = await params.generateFeedbackText(params.currentQuestion);
      } catch { }
    }

    // Debounce before applying FET state (ensures no race)
    await delay(60);

    return {
      currentExplanationText: restoredState.explanationText,
      displayMode: restoredState.displayMode,
      optionsToDisplay,
      feedbackText,
      shouldShowExplanation: fetState.shouldShowExplanation
    };
  }
}