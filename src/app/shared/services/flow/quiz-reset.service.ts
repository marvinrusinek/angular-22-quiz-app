import { Service, inject } from '@angular/core';

import { SK_CORRECT_ANSWERS_COUNT, SK_SAVED_QUESTION_INDEX, SK_SELECTED_OPTIONS_MAP, SK_SHUFFLED_QUESTIONS, SK_USER_ANSWERS } from '../../constants/session-keys';

import { ExplanationTextService } from '../features/explanation/explanation-text.service';
import { NextButtonStateService } from '../state/next-button-state.service';
import { OptionLockStateService } from '../state/option-lock-state.service';
import { QqcQuestionLoaderService } from '../features/qqc/qqc-question-loader.service';
import { QuestionTimingService } from '../features/timer/question-timing.service';
import { QuizDotStatusService } from './quiz-dot-status.service';
import { QuizPersistenceService } from '../state/quiz-persistence.service';
import { QuizService } from '../data/quiz.service';
import { QuizStateService } from '../state/quizstate.service';
import { QuizVisibilityRestoreService } from './quiz-visibility-restore.service';
import { ResetBackgroundService } from '../ui/reset-background.service';
import { ResetStateService } from '../state/reset-state.service';
import { SelectedOptionService } from '../state/selectedoption.service';
import { SelectionMessageService } from '../features/selection-message/selection-message.service';
import { TimerService } from '../features/timer/timer.service';
import { swallow } from '../../utils/error-logging';

/**
 * Orchestrates reset operations across multiple services.
 * Extracted from QuizComponent to reduce its size.
 */
@Service()
export class QuizResetService {
  // ── injects ─────────────────────────────────────────────────────
  private dotStatusService = inject(QuizDotStatusService);
  private explanationTextService = inject(ExplanationTextService);
  private nextButtonStateService = inject(NextButtonStateService);
  private optionLockState = inject(OptionLockStateService);
  private questionTimingService = inject(QuestionTimingService);
  private quizPersistence = inject(QuizPersistenceService);
  private quizQuestionLoaderService = inject(QqcQuestionLoaderService);
  private quizService = inject(QuizService);
  private quizStateService = inject(QuizStateService);
  private quizVisibilityRestoreService = inject(QuizVisibilityRestoreService);
  private resetBackgroundService = inject(ResetBackgroundService);
  private resetStateService = inject(ResetStateService);
  private selectedOptionService = inject(SelectedOptionService);
  private selectionMessageService = inject(SelectionMessageService);
  private timerService = inject(TimerService);

  // ── public methods ──────────────────────────────────────────────

  // ═══════════════════════════════════════════════════════════════
  // POST-RESTART STATE (after navigation completes)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Applies post-navigation restart state. Caller passes totalQuestions
   * and a callback to invoke after the second microtask (for ViewChild work).
   */
  applyPostRestartState(
    totalQuestions: number,
    postBindingCallback: () => void
  ): void {
    this.quizService.setCurrentQuestionIndex(0);
    this.quizService.updateBadgeText(1, totalQuestions);

    this.resetStateService.triggerResetFeedback();
    this.resetStateService.triggerResetState();
    this.quizService.setCurrentQuestionIndex(0);

    this.nextButtonStateService.setNextButtonState(false);
    this.quizStateService.setAnswerSelected(false);

    queueMicrotask(() => {
      this.quizStateService.setInteractionReady(true);
      // Reset only. The restart routes to question 1, which activates through
      // the normal question path and starts its own signed countdown; a local
      // start here would be a second, unauthorized timing authority racing it.
      requestAnimationFrame(() => this.timerService.resetTimer());
    });

    queueMicrotask(postBindingCallback);

    // Re-assert START message after all async reset triggers have settled.
    // Without this, question-loading code may overwrite the message with a
    // stale "Next button" value before the UI renders.
    setTimeout(() => {
      this.selectionMessageService.resetAll();
    }, 0);
  }


  // ═══════════════════════════════════════════════════════════════
  // RESET QUIZ STATE (service-level resets for quiz start)
  // ═══════════════════════════════════════════════════════════════

  resetQuizState(): void {
    this.quizService.resetQuestionPayload();
    this.quizQuestionLoaderService.resetUI();

    this.quizService.resetScore();
    this.quizService.questionCorrectness?.clear();
    this.quizService.selectedOptionsMap?.clear();
    this.selectedOptionService.selectedOptionsMap?.clear();

    try {
      localStorage.setItem(SK_CORRECT_ANSWERS_COUNT, '0');
      localStorage.removeItem('questionCorrectness');
      localStorage.removeItem(SK_SELECTED_OPTIONS_MAP);
      localStorage.removeItem(SK_USER_ANSWERS);
    } catch (err: unknown) { swallow('quiz-reset.service.ts', err); }

    localStorage.removeItem(SK_SAVED_QUESTION_INDEX);
  }

  // ═══════════════════════════════════════════════════════════════
  // RESET QUESTION STATE (between question transitions)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Resets service-level state between questions.
   * Returns flags the component must apply to its own properties.
   */
  resetQuestionServiceState(): void {
    this.selectedOptionService.lastClickedOption = null;
    this.selectedOptionService.lastClickedCorrectByQuestion.clear();

    this.nextButtonStateService.reset();

    this.resetBackgroundService.setShouldResetBackground(true);
    this.resetStateService.triggerResetFeedback();
    this.resetStateService.triggerResetState();

    this.selectedOptionService.clearOptions();

    if (!this.explanationTextService.isExplanationLocked()) {
      this.explanationTextService.resetExplanationState();
    }

    this.selectedOptionService.stopTimerEmitted = false;
  }

  // ═══════════════════════════════════════════════════════════════
  // CLEAR STALE PROGRESS AND DOT STATE FOR FRESH START
  // ═══════════════════════════════════════════════════════════════

  /**
   * Checks if a fresh start is warranted and clears stale state.
   * Returns true if state was cleared, false if not needed.
   */
  clearStaleProgressAndDotStateForFreshStart(
    currentQuestionIndex: number,
    quizId: string,
    totalQuestions: number
  ): boolean {
    if (currentQuestionIndex !== 0) return false;

    const hasExistingState =
      (this.quizService.questionCorrectness?.size ?? 0) > 0 ||
      (this.quizService.selectedOptionsMap?.size ?? 0) > 0 ||
      (this.selectedOptionService.selectedOptionsMap?.size ?? 0) > 0 ||
      this.selectedOptionService.hasRefreshBackup ||
      (this.selectedOptionService.clickConfirmedDotStatus?.size ?? 0) > 0;

    if (hasExistingState) return false;

    this.dotStatusService.dotStatusCache.clear();
    this.dotStatusService.pendingDotStatusOverrides.clear();
    this.dotStatusService.activeDotClickStatus.clear();
    this.quizPersistence.clearClickConfirmedDotStatus(totalQuestions);
    this.quizService.questionCorrectness?.clear();
    this.quizService.selectedOptionsMap?.clear();
    this.selectedOptionService.selectedOptionsMap?.clear();

    try {
      this.quizPersistence.clearAllPersistedDotStatus(quizId);
      localStorage.removeItem('quiz_progress_default');
      localStorage.removeItem('questionCorrectness');
      localStorage.removeItem(SK_SELECTED_OPTIONS_MAP);
      localStorage.removeItem(SK_USER_ANSWERS);
      sessionStorage.removeItem('quizProgress');
      sessionStorage.removeItem('quizProgressQuizId');
      sessionStorage.removeItem('answeredQuestionIndices');
    } catch (err: unknown) { swallow('quiz-reset.service.ts', err); }

    return true;
  }

  // ═══════════════════════════════════════════════════════════════
  // RESET FOR QUIZ SWITCH (route event quiz change)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Full quiz-switch reset orchestration including persistence cleanup.
   * Caller must reset its own component-local fields after calling this.
   */
  performQuizSwitchResets(routeQuizId: string): void {
    // Skip full reset if this is actually a page refresh (not a real quiz switch)
    if (this.selectedOptionService.hasRefreshBackup) return;
    this.resetForQuizSwitch(routeQuizId);
    this.quizPersistence.clearAllPersistedDotStatus(routeQuizId);
    this.dotStatusService.clearAllMaps();
    this.quizPersistence.clearClickConfirmedDotStatus(0);

    try {
      localStorage.setItem('lastQuizId', routeQuizId);
    } catch (err: unknown) { swallow('quiz-reset.service.ts', err); }
  }

  resetForQuizSwitch(routeQuizId: string): void {
    // Reset navigation service
    // (caller must handle quizNavigationService.resetForNewQuiz separately
    //  if needed, since that service is not injected here)

    this.quizService.resetAll();
    this.quizStateService.reset();
    this.explanationTextService.resetExplanationState();
    this.selectedOptionService.clearAllSelectionsForQuiz(routeQuizId);

    // Deadlines are keyed by question index, which means nothing across quizzes.
    this.questionTimingService.clearTiming();

    try {
      localStorage.removeItem(SK_SHUFFLED_QUESTIONS);
      localStorage.removeItem(SK_USER_ANSWERS);
      localStorage.removeItem(SK_SELECTED_OPTIONS_MAP);
      localStorage.removeItem('questionCorrectness');
      localStorage.removeItem('quiz_progress_default');
      localStorage.setItem(SK_SAVED_QUESTION_INDEX, '0');
      sessionStorage.clear();
    } catch (err: unknown) { swallow('quiz-reset.service.ts', err); }
  }

  // ═══════════════════════════════════════════════════════════════
  // RESTART QUIZ (full reset + service orchestration)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Performs all service-level resets for a quiz restart.
   * Returns navigation target and post-nav config for the component.
   */
  performRestartServiceResets(
    quizId: string,
    totalQuestions: number
  ): void {
    this.quizService.resetAll();
    this.quizService.resetScore();

    // A restart is a NEW attempt, not a redisplay: every answer, dot and
    // progress record is about to be discarded. The old signed deadlines go
    // with them, so question 1 is genuinely started again rather than resumed
    // against a window that has been counting down since the first run.
    this.questionTimingService.clearTiming();

    // Clear per-question option/question locks — otherwise a previously-
    // locked incorrect option/question (e.g. Q2 answered incorrectly before
    // restart) silently rejects clicks on the restarted quiz, breaking
    // highlight/selection on revisit.
    this.optionLockState.clearAll();

    // Drop any visibility-restore snapshot so a stale "explanation mode"
    // state from before the restart can't bleed back in on the next tab cycle.
    this.quizVisibilityRestoreService.resetSavedState();

    this.dotStatusService.clearAllMaps();
    this.quizPersistence.clearClickConfirmedDotStatus(totalQuestions);
    this.selectedOptionService.lastClickedCorrectByQuestion.clear();
    this.quizPersistence.clearAllPersistedDotStatus(quizId);

    this.quizService.shuffledQuestions = [];

    this.explanationTextService.setShouldDisplayExplanation(false, {
      force: true
    });
    this.explanationTextService.setIsExplanationTextDisplayed(false);

    if (this.explanationTextService._byIndex) {
      this.explanationTextService._byIndex.clear();
    }
    if (this.explanationTextService._gatesByIndex) {
      this.explanationTextService._gatesByIndex.clear();
    }

    this.explanationTextService._fetLocked = false;

    this.quizStateService.reset();

    try {
      this.quizQuestionLoaderService?.questionToDisplaySig.set('');
    } catch (err: unknown) { swallow('quiz-reset.service.ts', err); }

    this.quizStateService.setDisplayState({ mode: 'question', answered: false });
    this.quizStateService.setExplanationReady(false);

    this.selectedOptionService.clearSelectedOption();
    this.selectedOptionService.clearSelection();
    this.selectedOptionService.deselectOption();
    this.selectedOptionService.resetSelectionState();
    this.selectedOptionService.selectedOptionsMap.clear();
    this.selectedOptionService.setAnswered(false);
    this.quizStateService.setAnswerSelected(false);

    // Full per-quiz wipe: also clears rawSelectionsMap, _selectionHistory,
    // optionFeedbackState.feedbackByQuestion, optionSnapshotByQuestion, and
    // sessionStorage `sel_Q*` keys. Without this, an incorrectly-answered
    // Q2 leaves a feedback overlay that suppresses highlight on revisit
    // after Restart.
    try { this.selectedOptionService.clearState(); } catch (err: unknown) { swallow('quiz-reset.service.ts', err); }

    this.explanationTextService.resetExplanationState();
    this.explanationTextService.unlockExplanation();
    this.explanationTextService.setShouldDisplayExplanation(false);
    this.quizStateService.setDisplayState({ mode: 'question', answered: false });

    this.nextButtonStateService.setNextButtonState(false);

    // Clear stale selection message state from previous quiz run
    this.selectionMessageService.resetAll();
  }
}