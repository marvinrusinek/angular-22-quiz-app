import { inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { PROMISE_RACE_TIMEOUT_MS } from '../../../constants/timing';

import { QuestionType } from '../../../models/question-type.enum';

import { FormattedExplanation } from '../../../models/FormattedExplanation.model';
import { QuestionState } from '../../../models/QuestionState.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';

import { ExplanationTextService } from '../explanation/explanation-text.service';
import { QqcExplanationDisplayService } from './qqc-explanation-display.service';
import { QqcExplanationManagerService } from './qqc-explanation-manager.service';
import { QuizQuestionManagerService } from '../../flow/quizquestionmgr.service';
import { QuizService } from '../../data/quiz.service';
import { QuizStateService } from '../../state/quizstate.service';

/**
 * Orchestrates explanation flow lifecycle for QQC.
 * Consolidates scattered explanation orchestration methods from QuizQuestionComponent.
 *
 * This service handles async pipelines, reset sequences, and state restoration
 * for explanation text. The component retains EventEmitter emissions, cdRef calls,
 * and subject mutations.
 */
@Service()
export class QqcExplanationFlowService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly explanationDisplay = inject(QqcExplanationDisplayService);
  private readonly explanationManager = inject(QqcExplanationManagerService);
  private readonly explanationTextService = inject(ExplanationTextService);
  private readonly quizQuestionManagerService = inject(QuizQuestionManagerService);
  private readonly quizService = inject(QuizService);
  private readonly quizStateService = inject(QuizStateService);

  /**
   * Full async pipeline: fetches question data, resolves formatted
   * explanation, returns the text to display.
   * Extracted from prepareAndSetExplanationText().
   */
  async prepareExplanationText(questionIndex: number): Promise<string> {
    if (typeof document !== 'undefined' && document.hidden) {
      return 'Explanation text not available when document is hidden.';
    }

    try {
      const questionData = await firstValueFrom(
        this.quizService.getQuestionByIndex(questionIndex)
      );

      if (this.quizQuestionManagerService.isValidQuestionData(questionData!)) {
        const formattedExplanationObservable =
          this.explanationTextService.getFormattedExplanation(questionIndex);

        try {
          const formattedExplanation = await Promise.race([
            firstValueFrom(formattedExplanationObservable),
            new Promise<string>((_, reject) =>
              setTimeout(() => reject(new Error('Timeout')), PROMISE_RACE_TIMEOUT_MS)
            )
          ]);

          if (formattedExplanation) {
            return formattedExplanation;
          } else {
            const processedExplanation = await this.explanationManager.processExplanationText(
              questionData!,
              questionIndex
            );

            if (processedExplanation) {
              this.explanationTextService.updateFormattedExplanation(
                processedExplanation.explanation
              );
              return processedExplanation.explanation;
            } else {
              return 'No explanation available...';
            }
          }
        } catch {
          // Timeout while fetching formatted explanation
          return 'Explanation text unavailable at the moment.';
        }
      } else {
        // questionData is invalid
        return 'No explanation available.';
      }
    } catch {
      // Error in fetching explanation text
      return 'Error fetching explanation.';
    }
  }

  /**
   * Computes the reset sequence for explanation state.
   * Returns the values to apply, or blocked: true if lock prevents reset.
   * The component applies the result to its own state and emits events.
   * Extracted from resetExplanation().
   */
  computeResetExplanation(params: {
    force: boolean;
    questionIndex: number;
  }): {
    blocked: boolean;
    displayExplanation?: false;
    explanationToDisplay?: '';
    displayState?: { mode: 'question'; answered: false };
  } {
    const locked = this.explanationTextService.isExplanationLocked?.() ?? false;
    if (!params.force && locked) return { blocked: true };

    return {
      blocked: false,
      displayExplanation: false,
      explanationToDisplay: '',
      displayState: { mode: 'question', answered: false }
    };
  }

  /**
   * Computes the restore state for explanation after a reset
   * (e.g., returning to an already-answered question).
   * Returns the values the component should apply.
   * Extracted from restoreExplanationAfterReset().
   */
  computeRestoreAfterReset(args: {
    questionIndex: number;
    explanationText: string;
    questionState?: QuestionState;
    quizId: string | null | undefined;
    quizServiceQuizId: string | null;
    currentQuizId: string | null;
  }): {
    shouldSkip: false;
    explanationText: string;
    displayMode: 'explanation';
    displayState: { mode: 'explanation'; answered: true };
    forceQuestionDisplay: false;
    readyForExplanationDisplay: true;
    isExplanationReady: true;
    isExplanationLocked: false;
    explanationLocked: true;
    explanationVisible: true;
    displayExplanation: true;
    shouldDisplayExplanation: true;
    isExplanationTextDisplayed: true;
    resolvedQuizId: string | null;
  } | { shouldSkip: true } {
    const normalized = (args.explanationText ?? '').trim();
    if (!normalized) return { shouldSkip: true };

    // Apply service-level state
    this.explanationTextService.setExplanationText(normalized);
    this.explanationTextService.setShouldDisplayExplanation(true);
    this.explanationTextService.setIsExplanationTextDisplayed(true);
    this.explanationTextService.setResetComplete(true);
    this.explanationTextService.lockExplanation();

    const resolvedQuizId =
      [args.quizId, args.currentQuizId, args.quizServiceQuizId]
        .find((id) => typeof id === 'string' && id.trim().length > 0) ?? null;

    if (resolvedQuizId && args.questionState) {
      args.questionState.isAnswered = true;
      args.questionState.explanationDisplayed = true;
      this.quizStateService.setQuestionState(resolvedQuizId, args.questionIndex, args.questionState);
    }

    return {
      shouldSkip: false,
      explanationText: normalized,
      displayMode: 'explanation',
      displayState: { mode: 'explanation', answered: true },
      forceQuestionDisplay: false,
      readyForExplanationDisplay: true,
      isExplanationReady: true,
      isExplanationLocked: false,
      explanationLocked: true,
      explanationVisible: true,
      displayExplanation: true,
      shouldDisplayExplanation: true,
      isExplanationTextDisplayed: true,
      resolvedQuizId
    };
  }

  /**
   * Validates and adjusts question index for explanation UI update.
   * Returns null if update should be skipped.
   * Extracted from updateExplanationUI().
   */
  validateForExplanationUI(params: {
    questionsArray: QuizQuestion[];
    questionIndex: number;
  }): {
    adjustedIndex: number;
    currentQuestion: QuizQuestion;
  } | null {
    if (!params.questionsArray || params.questionsArray.length === 0) {
      return null;
    }

    const adjustedIndex = Math.max(
      0,
      Math.min(params.questionIndex, params.questionsArray.length - 1)
    );
    const currentQuestion = params.questionsArray[adjustedIndex];

    if (!currentQuestion) return null;  // question not found at adjusted index

    return { adjustedIndex, currentQuestion };
  }

  /**
   * Processes the current question: fetches explanation text, sets it in the service,
   * and updates quiz state. Returns the explanation text and total correct answers.
   * Extracted from processCurrentQuestion().
   */
  async processCurrentQuestion(params: {
    currentQuestion: QuizQuestion;
    currentQuestionIndex: number;
    quizId: string;
    lastAllCorrect: boolean;
    getExplanationText: (index: number) => Promise<string>;
  }): Promise<{
    explanationText: string;
    shouldDisplay: boolean;
  }> {
    try {
      // Await the explanation text to ensure it resolves to a string
      const explanationText: string = await params.getExplanationText(
        params.currentQuestionIndex
      );

      const totalCorrectAnswers =
        this.quizService.quizOptions.getTotalCorrectAnswers(params.currentQuestion);

      // Update the quiz state with the latest question information
      this.quizStateService.updateQuestionState(
        params.quizId,
        params.currentQuestionIndex,
        { isAnswered: true },
        totalCorrectAnswers
      );

      return {
        explanationText,
        shouldDisplay: params.lastAllCorrect
      };
    } catch {
      // Error processing current question

      // Error fallback — no action needed

      return {
        explanationText: 'Unable to load explanation.',
        shouldDisplay: false
      };
    }
  }

  /**
   * Returns the error message for explanation fetch failure.
   * Extracted from handleExplanationError().
   */
  getExplanationErrorText(): string {
    return 'Error fetching explanation. Please try again.';
  }

  /**
   * Processes a formatted explanation result and determines whether
   * to update the display.
   * Extracted from handleFormattedExplanation().
   */
  processFormattedExplanation(
    formattedExplanation: FormattedExplanation,
    isAnswered: boolean,
    shouldDisplayExplanation: boolean
  ): {
    explanationToDisplay: string;
    shouldEmit: boolean;
  } {
    return this.explanationDisplay.handleFormattedExplanation(
      formattedExplanation,
      isAnswered,
      shouldDisplayExplanation
    );
  }

  /**
   * Computes the explanation text and state for multi-answer submission.
   * Returns formatted text, correct answer info, and display flags.
   * Extracted from onSubmitMultiple().
   */
  computeSubmitMultipleExplanation(params: {
    currentQuestionIndex: number;
  }): {
    formatted: string;
    correctIdxs: number[];
    questionType: QuestionType | undefined;
    correctAnswersText: string;
    totalOpts: number;
  } | null {
    const idx = params.currentQuestionIndex;
    const q = this.quizService.questions?.[idx];
    if (!q) return null;

    const correctIdxs = this.explanationTextService.getCorrectOptionIndices(q);

    // NOTHING TO SAY YET IS NOT A SENTENCE.
    //
    // This fabricated `'Explanation not provided'` when the question carried no
    // explanation, and the caller then applied and displayed it. Since S4 an
    // API-sourced question never carries one — the explanation names the
    // correct options, so only `/check` may release it — so the placeholder
    // stood in for an answer nobody had authorized yet.
    //
    // Returning null is the shape this method already uses for "nothing to
    // compute" (see the `!q` guard above), and `runOnSubmitMultiple` bails on it
    // without writing anything. The authorized explanation still reaches the
    // heading through the formatter, which composes it once the verdict is
    // terminal — so this only removes the fabrication, never the real text.
    const rawExpl = (q.explanation ?? '').trim();
    if (!rawExpl) return null;

    const formatted = this.explanationTextService.formatExplanation(q, correctIdxs, rawExpl).trim();

    let correctAnswersText = '';
    const totalOpts = q.options?.length ?? 0;

    if (q.type === QuestionType.MultipleAnswer) {
      const numCorrect = correctIdxs.length;
      correctAnswersText = this.quizQuestionManagerService.getNumberOfCorrectAnswersText(
        numCorrect,
        totalOpts
      );
    }

    return {
      formatted,
      correctIdxs,
      questionType: q.type,
      correctAnswersText,
      totalOpts
    };
  }

  /**
   * Applies the submit-multiple explanation state to the explanation text service.
   * Extracted from onSubmitMultiple().
   */
  async applySubmitMultipleExplanation(params: {
    currentQuestionIndex: number;
    formatted: string;
    correctAnswersText: string;
    questionType: QuestionType | undefined;
  }): Promise<void> {
    const idx = params.currentQuestionIndex;

    try {
      this.explanationTextService._activeIndex = idx;
      this.explanationTextService.resetForIndex(idx);
      await new Promise(res => requestAnimationFrame(() => setTimeout(res, 60)));

      this.explanationTextService.openExclusive(idx, params.formatted);

      if (params.questionType === QuestionType.MultipleAnswer) {
        this.quizService.updateCorrectAnswersText(params.correctAnswersText);
        requestAnimationFrame(() => {
          try {
            this.quizService.updateCorrectAnswersText(params.correctAnswersText);
          } catch { }
        });
      } else {
        this.quizService.updateCorrectAnswersText('');
      }
    } catch { }
  }

  /**
   * Orchestrates fetching and setting explanation text for a question.
   * Manages the full flow: reset → ensure loaded → fetch → set.
   * Extracted from fetchAndSetExplanationText().
   */
  async fetchAndSetExplanationText(params: {
    questionIndex: number;
    questionsArray: QuizQuestion[];
    quizId: string | null | undefined;
    isAnswered: boolean;
    shouldDisplayExplanation: boolean;
    ensureQuestionsLoaded: () => Promise<boolean>;
    ensureQuestionIsFullyLoaded: (index: number) => Promise<void>;
    prepareExplanationText: (index: number) => Promise<string>;
    isAnyOptionSelected: (index: number) => Promise<boolean>;
  }): Promise<{
    explanationToDisplay: string;
    success: boolean;
  }> {
    try {
      const questionsLoaded = await params.ensureQuestionsLoaded();

      if (!questionsLoaded || !params.questionsArray || params.questionsArray.length === 0) {
        // Failed to load questions or questions array is empty
        return { explanationToDisplay: '', success: false };
      }

      if (!params.questionsArray[params.questionIndex]) {
        // Questions array is not properly populated or invalid index
        return { explanationToDisplay: '', success: false };
      }

      await params.ensureQuestionIsFullyLoaded(params.questionIndex);

      const explanationText = await params.prepareExplanationText(params.questionIndex);

      if (await params.isAnyOptionSelected(params.questionIndex)) {
        return {
          explanationToDisplay: explanationText || 'No explanation available',
          success: true,
        };
      } else {
        return { explanationToDisplay: '', success: false };
      }
    } catch {
      // Error fetching explanation for question
      return {
        explanationToDisplay: this.getExplanationErrorText(),
        success: false
      };
    }
  }

  /**
   * Updates the explanation UI for a given question index.
   * Validates the question data and returns the adjustment info.
   * Extracted from updateExplanationUI() (validation + question resolution).
   */
  resolveQuestionForExplanationUI(params: {
    questionsArray: QuizQuestion[];
    questionIndex: number;
  }): {
    adjustedIndex: number;
    currentQuestion: QuizQuestion;
  } | null {
    return this.validateForExplanationUI(params);
  }

  /**
   * Handles explanation display logic: fetches and sets explanation if answered,
   * otherwise clears it.
   * Extracted from handleExplanationDisplay().
   */
  async handleExplanationDisplay(params: {
    isAnswered: boolean;
    currentQuestionIndex: number;
    fetchAndSetExplanationText: (idx: number) => Promise<void>;
    updateExplanationDisplay: (shouldDisplay: boolean) => Promise<void>;
  }): Promise<void> {
    if (params.isAnswered) {
      await params.fetchAndSetExplanationText(params.currentQuestionIndex);
      await params.updateExplanationDisplay(true);
    } else {
      await params.updateExplanationDisplay(false);
    }
  }

  /**
   * Handles updateExplanationIfAnswered: checks if question is answered,
   * fetches formatted explanation, and returns the explanation text + display data.
   * Extracted from updateExplanationIfAnswered().
   */
  async updateExplanationIfAnswered(params: {
    index: number;
    question: QuizQuestion;
    shouldDisplayExplanation: boolean;
    isAnyOptionSelected: (idx: number) => Promise<boolean>;
    getFormattedExplanation: (q: QuizQuestion, idx: number) => Promise<{ questionIndex: number; explanation: string }>;
  }): Promise<{
    shouldUpdate: boolean;
    explanationText: string;
  }> {
    if (await params.isAnyOptionSelected(params.index) && params.shouldDisplayExplanation) {
      const formatted = await params.getFormattedExplanation(params.question, params.index);
      const explanationText = formatted?.explanation
        || this.explanationTextService.prepareExplanationText(params.question);
      return { shouldUpdate: true, explanationText };
    } else {
      return { shouldUpdate: false, explanationText: '' };
    }
  }

  /**
   * Computes and emits formatted explanation text for a multi-answer question
   * when all correct options are selected (FET trigger).
   * Returns the formatted text and display flag, or null on failure.
   * Extracted from onOptionClicked() multi-answer FET trigger block.
   */
  async triggerMultiAnswerFet(params: {
    lockedIndex: number;
    question: QuizQuestion | null | undefined;
  }): Promise<{
    formatted: string;
    shouldDisplay: boolean;
  } | null> {
    try {
      const svc: any = this.explanationTextService;
      svc._activeIndex = params.lockedIndex;
      svc.readyForExplanation = true;
      svc._fetLocked = true;

      // Generate FET text SYNCHRONOUSLY — no delay. The FET must be
      // cached before the displayText$ pipeline fires (next microtask),
      // otherwise the FET-OVER-QUESTION-TEXT guard finds nothing and
      // writes question text instead.
      // SHUFFLED FIX: params.lockedIndex is a DISPLAY index. In shuffled
      // mode, quizService.questions[] is original order — use
      // getQuestionsInDisplayOrder() to get the correct displayed question.
      const canonicalQ = this.quizService?.getQuestionsInDisplayOrder?.()?.[params.lockedIndex]
        ?? this.quizService?.questions?.[params.lockedIndex]
        ?? params.question;
      const raw = (canonicalQ?.explanation ?? '').trim();
      const correctIdxs = svc.getCorrectOptionIndices(canonicalQ);
      const formatted = svc.formatExplanation(canonicalQ, correctIdxs, raw).trim();

      // Store in FET caches FIRST so the CQC's FET-OVER-QUESTION-TEXT
      // guard can find it when displayText$ emits question text.
      try {
        if (svc.fetByIndex && typeof svc.fetByIndex.set === 'function') {
          svc.fetByIndex.set(params.lockedIndex, formatted);
        }
        if (svc.formattedExplanations) {
          svc.formattedExplanations[params.lockedIndex] = {
            explanation: formatted,
            idx: params.lockedIndex
          };
        }
      } catch { /* ignore */ }

      // Bypass the ETS pristine gates by calling displayState directly.
      // The caller (orchestrator) already verified all correct answers are
      // selected via fetGatePassed — the ETS gates can falsely block for
      // shuffled quizzes because selectedOptionsMap/live-option flags may
      // not yet reflect the current click at the moment the gate runs.
      svc.displayState?.setShouldDisplayExplanation?.(true);
      svc.displayState?.setExplanationText?.(formatted);
      svc.displayState?.setIsExplanationTextDisplayed?.(true);
      return { formatted, shouldDisplay: true };
    } catch {
      return null;
    }
  }

  /**
   * Performs the full resetExplanation flow: resets explanation text via service,
   * computes whether reset is blocked, and applies service-level state changes.
   * Returns state for the component to apply.
   * Extracted from resetExplanation() in QuizQuestionComponent.
   */
  performResetExplanation(params: {
    force: boolean;
    questionIndex: number;
  }): {
    blocked: boolean;
    displayExplanation: boolean;
    explanationToDisplay: string;
  } {
    this.explanationTextService.resetExplanationText();

    const result = this.computeResetExplanation({
      force: params.force,
      questionIndex: params.questionIndex
    });

    if (result.blocked) {
      return { blocked: true, displayExplanation: false, explanationToDisplay: '' };
    }

    this.explanationTextService.setShouldDisplayExplanation(false);
    this.quizStateService.setDisplayState(result.displayState!);
    this.quizStateService.setAnswerSelected(false);
    this.explanationTextService.setResetComplete?.(true);

    return {
      blocked: false,
      displayExplanation: false,
      explanationToDisplay: ''
    };
  }

  /**
   * Handles the updateExplanationUI flow: validates the question, schedules
   * the delayed explanation update if the question is answered.
   * Returns the validated data, or null if validation fails.
   * Extracted from updateExplanationUI() in QuizQuestionComponent.
   */
  performUpdateExplanationUI(params: {
    questionsArray: QuizQuestion[];
    questionIndex: number;
  }): { adjustedIndex: number; currentQuestion: QuizQuestion } | null {
    return this.validateForExplanationUI(params);
  }

  /**
   * Performs the full fetchAndSetExplanationText flow:
   * ensures questions are loaded, ensures the target question is fully loaded,
   * then prepares and returns the explanation text.
   * Extracted from fetchAndSetExplanationText() in QuizQuestionComponent.
   */
  async performFetchAndSetExplanation(params: {
    questionIndex: number;
    questionsArray: QuizQuestion[];
    quizId: string | null | undefined;
    isAnswered: boolean;
    shouldDisplayExplanation: boolean;
    ensureQuestionsLoaded: () => Promise<boolean>;
    ensureQuestionIsFullyLoaded: (idx: number) => Promise<any>;
    prepareExplanationText: (idx: number) => Promise<string>;
    isAnyOptionSelected: (idx: number) => Promise<boolean>;
  }): Promise<{
    success: boolean;
    explanationToDisplay: string;
  }> {
    const { questionIndex, isAnswered, shouldDisplayExplanation } = params;

    try {
      await params.ensureQuestionsLoaded();
      await params.ensureQuestionIsFullyLoaded(questionIndex);

      const explanationToDisplay = await params.prepareExplanationText(questionIndex);

      // Only mark as answered if the option was already selected
      const optionSelected = await params.isAnyOptionSelected(questionIndex);

      if (!optionSelected || (!isAnswered && !shouldDisplayExplanation)) {
        return { success: true, explanationToDisplay };
      }

      return { success: true, explanationToDisplay };
    } catch {
      // Error in performFetchAndSetExplanation
      return {
        success: false,
        explanationToDisplay: this.getExplanationErrorText()
      };
    }
  }
}
