import { inject, Service } from '@angular/core';

import { SK_DOT_CONFIRMED } from '../../../constants/session-keys';

import { FeedbackConfig } from '../../../models/FeedbackConfig.model';
import { Option } from '../../../models/Option.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';

import { isOptionCorrect } from '../../../utils/is-option-correct';
import { swallow } from '../../../utils/error-logging';

import { ExplanationTextService } from '../explanation/explanation-text.service';
import { NextButtonStateService } from '../../state/next-button-state.service';
import { QuizDotStatusService } from '../../flow/quiz-dot-status.service';
import { QuizService } from '../../data/quiz.service';
import { QuizStateService } from '../../state/quizstate.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { SelectionMessageService } from '../selection-message/selection-message.service';
import { TimerService } from '../timer/timer.service';

/** The per-question reset state the component should apply. */
export interface ResetPerQuestionResult {
  hasSelections: boolean;
  i0: number;
  feedbackConfigs: Record<number | string, FeedbackConfig>;
  lastFeedbackOptionId: number;
  showFeedbackForOption: { [optionId: number]: boolean };
  questionFresh: boolean;
  timedOut: boolean;
  timerStoppedForQuestion: boolean;
  lastAllCorrect: boolean;
  lastLoggedIndex: number;
  lastLoggedQuestionIndex: number;
  displayMode: 'question' | 'explanation';
  displayExplanation: boolean;
  explanationToDisplay: string;
  explanationOwnerIdx: number;
}

/**
 * Manages per-question reset, state clearing, and click guard resets for QQC.
 * Extracted from QuizQuestionComponent to reduce its size.
 */
@Service()
export class QqcResetManagerService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly explanationTextService = inject(ExplanationTextService);
  private readonly nextButtonStateService = inject(NextButtonStateService);
  private readonly dotStatusService = inject(QuizDotStatusService);
  private readonly quizService = inject(QuizService);
  private readonly quizStateService = inject(QuizStateService);
  private readonly selectedOptionService = inject(SelectedOptionService);
  private readonly selectionMessageService = inject(SelectionMessageService);
  private readonly timerService = inject(TimerService);

  /**
   * Resets all per-question state for a given index.
   * Returns the state values the component should apply.
   */
  resetPerQuestionState(params: {
    index: number;
    normalizeIndex: (idx: number) => number;
    formattedByIndex: Map<number, string>;
    clearSharedOptionForceDisable: () => void;
    resolveFormatted: (idx: number, opts: any) => void;
  }): ResetPerQuestionResult {
    const i0 = params.normalizeIndex(params.index);
    const hasSelections = this.resolveHasSelections(i0);

    // Clear stale FET cache
    params.formattedByIndex.delete(i0);

    // Unlock & clear per-question selection/locks
    this.selectedOptionService.resetLocksForQuestion(i0);
    if (!hasSelections) {
      this.selectedOptionService.clearSelectionsForQuestion(i0);
    } else {
      this.selectedOptionService.republishFeedbackForQuestion(i0);
    }
    params.clearSharedOptionForceDisable();

    // Clear expiry guards. Skip when this question already has selections
    // (i.e., it was just answered) so the stoppedForQuestion bookkeeping
    // survives — otherwise restartForQuestion below would re-arm the timer.
    if (!hasSelections) {
      this.timerService.resetTimerFlagsFor?.(i0);
    }

    // Explanation & display mode
    if (hasSelections) {
      this.applyAnsweredResetState(i0);
    } else {
      this.applyFreshResetState(i0);
    }

    // Prewarm explanation cache
    params.resolveFormatted(i0, { useCache: true, setCache: true });

    // Timer reset/restart — must use restartForQuestion so that
    // hasExpiredForRun is cleared before resetTimer/startTimer.
    // Without this, the anti-thrash guards in resetTimer/startTimer
    // suppress the restart after Q1's timer has expired.
    // Skip for already-answered questions so the timer stays frozen
    // at the click-moment value instead of restarting to the full
    // start value.
    if (!hasSelections) {
      this.timerService.restartForQuestion(i0);
    }

    // Build showFeedbackForOption from existing selections
    let showFeedbackForOption: { [optionId: number]: boolean } = {};
    if (hasSelections) {
      const feedbackMap = this.selectedOptionService.getFeedbackForQuestion(i0);
      showFeedbackForOption = { ...feedbackMap };
    }

    return this.buildResetResult(hasSelections, i0, showFeedbackForOption);
  }

  // Treat the question as "has selections" if EITHER live selections are
  // present OR the scoring map already recorded it correct OR the dot was
  // confirmed (revisit on Previous: in-memory selections may be pruned but
  // questionCorrectness / SK_DOT_CONFIRMED persist across nav).
  private resolveHasSelections(i0: number): boolean {
    const existingSelections =
      this.selectedOptionService.getSelectedOptionsForQuestion(i0) ?? [];
    const questionCorrectnessMap: Map<number, boolean> | undefined =
      this.quizService?.questionCorrectness;
    const scoredCorrect = !!questionCorrectnessMap?.get?.(i0);
    let dotConfirmed = false;
    try {
      const dotStored = sessionStorage.getItem(SK_DOT_CONFIRMED + i0);
      dotConfirmed = dotStored === 'correct' || dotStored === 'wrong';
    } catch (err: unknown) { swallow('qqc-reset-manager.service.ts dot-confirmed read', err); }
    return existingSelections.length > 0 || scoredCorrect || dotConfirmed;
  }

  // Already-answered question: show the explanation and force the Next button
  // enabled (revisited answered questions must not leave Next stuck disabled).
  private applyAnsweredResetState(i0: number): void {
    this.explanationTextService.setShouldDisplayExplanation(true);
    this.quizStateService.setDisplayState({ mode: 'explanation', answered: true });
    this.quizStateService.setAnswered(true);
    this.quizStateService.setAnswerSelected(true);
    // Also flip SelectedOptionService.isAnsweredSig and force-enable the
    // Next button so revisited (already-answered) questions don't leave
    // Next stuck disabled. The reactive Next-button stream is driven by
    // selectedOptionService.isAnswered$, so flip that here; the
    // forceEnable buys 1500ms of held-enable to outlast any
    // navigation-end resets that fire after this point.
    try { this.selectedOptionService.setAnswered?.(true, true); } catch (err: unknown) { swallow('qqc-reset-manager.service.ts setAnswered', err); }
    try { this.nextButtonStateService.forceEnable?.(1500); } catch (err: unknown) { swallow('qqc-reset-manager.service.ts forceEnable', err); }
    // Re-apply after the next macrotask in case a downstream reset path
    // disables the button between now and the end of navigation.
    setTimeout(() => {
      try { this.selectedOptionService.setAnswered?.(true, true); } catch (err: unknown) { swallow('qqc-reset-manager.service.ts setAnswered (deferred)', err); }
      try { this.nextButtonStateService.forceEnable?.(1500); } catch (err: unknown) { swallow('qqc-reset-manager.service.ts forceEnable (deferred)', err); }
    }, 0);
  }

  // Fresh/unanswered question: clear explanation, reset to question mode, and
  // restore the prompt selection message.
  private applyFreshResetState(i0: number): void {
    this.explanationTextService.unlockExplanation?.();
    this.explanationTextService.resetExplanationText();
    this.explanationTextService.setShouldDisplayExplanation(false);
    this.quizStateService.setDisplayState({ mode: 'question', answered: false });
    this.quizStateService.setAnswered(false);
    this.quizStateService.setAnswerSelected(false);
    // A question that already timed out (but was never genuinely selected) is
    // NOT a fresh, never-visited question — it durably records
    // `timedOutFetForced` the moment it first expires. Pushing the "start the
    // quiz" / "please click an option" baseline here overwrote the correct
    // nav-derived "Please select an option to continue..." message with a
    // first-visit framing on every revisit (Previous, or returning to the tab).
    // Let selectionMessageSig's own nav-derived computation own the message for
    // an already-timed-out question instead.
    if (this.dotStatusService.timedOutFetForced.has(i0)) return;
    // Reset the selection message so the stale "Next button" / "Show Results"
    // message from a prior answered question doesn't persist on an unanswered one.
    const msg = i0 === 0
      ? 'Please start the quiz by selecting an option.'
      : 'Please click an option to continue.';
    this.selectionMessageService.pushMessage(msg, i0);
  }

  private buildResetResult(
    hasSelections: boolean,
    i0: number,
    showFeedbackForOption: { [optionId: number]: boolean }
  ): ResetPerQuestionResult {
    return {
      hasSelections,
      i0,
      feedbackConfigs: {},
      lastFeedbackOptionId: -1,
      showFeedbackForOption,
      questionFresh: true,
      timedOut: false,
      timerStoppedForQuestion: false,
      lastAllCorrect: false,
      lastLoggedIndex: -1,
      lastLoggedQuestionIndex: -1,
      displayMode: hasSelections ? 'explanation' : 'question',
      displayExplanation: hasSelections,
      explanationToDisplay: hasSelections ? '' : '',  // component keeps or clears
      explanationOwnerIdx: hasSelections ? -1 : -1
    };
  }

  /**
   * Resets feedback-related component state.
   */
  resetFeedback(): {
    correctMessage: string;
    showFeedback: boolean;
    selectedOption: null;
    showFeedbackForOption: { [optionId: number]: boolean };
  } {
    return {
      correctMessage: '',
      showFeedback: false,
      selectedOption: null,
      showFeedbackForOption: {}
    };
  }

  /**
   * Resets full component state including options and feedback.
   */
  resetState(): {
    selectedOption: null;
    options: Option[];
    areOptionsReadyToRender: boolean;
  } {
    this.selectedOptionService.clearOptions();

    return {
      selectedOption: null,
      options: [],
      areOptionsReadyToRender: false
    };
  }

  /**
   * Clears selection state for all options in a question.
   */
  clearSelection(
    correctAnswers: number[] | undefined,
    currentQuestion: QuizQuestion | null
  ): void {
    if (correctAnswers && correctAnswers.length === 1) {
      if (currentQuestion && currentQuestion.options) {
        for (const option of currentQuestion.options) {
          option.selected = false;
          option.styleClass = '';
        }
      }
    }
  }

  /**
   * Restores selections and icons for a question from the service state.
   *
   * Behavior on revisit (Previous):
   *   - If the question was answered with ALL correct options selected
   *     (perfect — no missing, no extras), restore the selected state + icon
   *     + highlight so the user sees their correct answer persisted.
   *   - Otherwise (incorrect, partial, or timer-expired with no selection):
   *     clear all option marks so nothing is highlighted/selected on revisit.
   */
  restoreSelectionsAndIcons(
    index: number,
    optionsToDisplay: Option[]
  ): Option[] {
    const selectedOptions =
      this.selectedOptionService.getSelectedOptionsForQuestion(index) ?? [];

    const wasPerfect = this.wasAnsweredPerfectly(optionsToDisplay, selectedOptions);

    if (!wasPerfect) {
      // No persisted marks for imperfect/none.
      return optionsToDisplay?.map(opt => ({
        ...opt,
        selected: false,
        showIcon: false,
        highlight: false
      })) ?? [];
    }

    return optionsToDisplay?.map(opt => {
      const match = selectedOptions.find(
        (sel) => sel.optionId === opt.optionId
      );
      const isSelectedAndCorrect =
        !!match && isOptionCorrect(opt);
      return {
        ...opt,
        selected: isSelectedAndCorrect,
        showIcon: isSelectedAndCorrect,
        highlight: isSelectedAndCorrect
      };
    }) ?? [];
  }

  /**
   * Returns true only when every correct option in `optionsToDisplay` is
   * present in `selectedOptions` AND no incorrect option was selected.
   */
  private wasAnsweredPerfectly(
    optionsToDisplay: Option[],
    selectedOptions: { optionId?: number | string }[]
  ): boolean {
    if (!Array.isArray(optionsToDisplay) || optionsToDisplay.length === 0) return false;
    if (!Array.isArray(selectedOptions) || selectedOptions.length === 0) return false;

    const correctIds = new Set<string>(
      optionsToDisplay.filter(isOptionCorrect).map(o => String(o.optionId))
    );
    if (correctIds.size === 0) return false;

    const selectedIds = new Set<string>(
      selectedOptions.map(s => String(s?.optionId))
    );

    // Every correct id must be selected
    for (const id of correctIds) {
      if (!selectedIds.has(id)) return false;
    }
    // And no incorrect id may be selected
    for (const id of selectedIds) {
      if (!correctIds.has(id)) return false;
    }
    return true;
  }

  /**
   * Returns reset values for click guard state.
   */
  hardResetClickGuards(): {
    clickGate: boolean;
    waitingForReady: boolean;
    deferredClick: undefined;
    lastLoggedQuestionIndex: number;
    lastLoggedIndex: number;
  } {
    return {
      clickGate: false,
      waitingForReady: false,
      deferredClick: undefined,
      lastLoggedQuestionIndex: -1,
      lastLoggedIndex: -1
    };
  }

  /**
   * Computes the reset state before navigation to a new question.
   * Returns an object describing what the component should apply.
   */
  computeResetQuestionStateBeforeNavigation(options?: {
    preserveVisualState?: boolean;
    preserveExplanation?: boolean;
  }): {
    preserveVisualState: boolean;
    preserveExplanation: boolean;
    displayState: { mode: 'question' | 'explanation'; answered: boolean };
    displayMode: 'question' | 'explanation';
    forceQuestionDisplay: boolean;
    readyForExplanationDisplay: boolean;
    isExplanationReady: boolean;
    isExplanationLocked: boolean;
    explanationLocked: boolean;
    explanationVisible: boolean;
    displayExplanation: boolean;
    shouldDisplayExplanation: boolean;
    isExplanationTextDisplayed: boolean;
    explanationToDisplay: string;
    questionToDisplay: string;
    shouldRenderOptions: boolean;
    feedbackText: string;
    currentQuestion: null;
    selectedOption: null;
    resetOptions: Option[];
  } {
    const preserveVisualState = options?.preserveVisualState ?? false;
    const preserveExplanation = options?.preserveExplanation ?? false;

    // Perform service-level resets when not preserving explanation
    if (!preserveExplanation) {
      this.explanationTextService.resetExplanationState();
      this.explanationTextService.setExplanationText('');
      this.explanationTextService.updateFormattedExplanation('');
      this.explanationTextService.setResetComplete(false);
      this.explanationTextService.unlockExplanation();
      this.explanationTextService.setShouldDisplayExplanation(false);
      this.explanationTextService.setIsExplanationTextDisplayed(false);
    }

    return {
      preserveVisualState,
      preserveExplanation,
      displayState: preserveExplanation
        ? { mode: 'explanation' as const, answered: true }
        : { mode: 'question' as const, answered: false },
      displayMode: preserveExplanation ? 'explanation' : 'question',
      forceQuestionDisplay: !preserveExplanation,
      readyForExplanationDisplay: preserveExplanation,
      isExplanationReady: preserveExplanation,
      isExplanationLocked: !preserveExplanation,
      explanationLocked: !preserveExplanation,
      explanationVisible: preserveExplanation,
      displayExplanation: preserveExplanation,
      shouldDisplayExplanation: preserveExplanation,
      isExplanationTextDisplayed: preserveExplanation,
      explanationToDisplay: preserveExplanation ? '' : '',
      questionToDisplay: preserveVisualState ? '' : '',
      shouldRenderOptions: preserveVisualState,
      feedbackText: preserveExplanation ? '' : '',
      currentQuestion: null,
      selectedOption: null,
      resetOptions: []
    };
  }

  /**
   * Handles the full post-reset shared option component cleanup.
   * Schedules the freezeOptionBindings and showFeedbackForOption reset.
   * Extracted from resetQuestionStateBeforeNavigation() in QuizQuestionComponent.
   */
  computeResetDelay(preserveVisualState?: boolean): number {
    return preserveVisualState ? 0 : 50;
  }
}
