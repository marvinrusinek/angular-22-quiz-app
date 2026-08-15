import { inject, Service } from '@angular/core';

import { QuestionType } from '../../../models/question-type.enum';

import { Option } from '../../../models/Option.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';
import { SelectedOption } from '../../../models/SelectedOption.model';

import { ExplanationTextService } from '../explanation/explanation-text.service';
import { FeedbackService } from '../feedback/feedback.service';
import { QuizService } from '../../data/quiz.service';
import { QuizStateService } from '../../state/quizstate.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { SelectionMessageService } from '../selection-message/selection-message.service';
import { TimerService } from '../timer/timer.service';
import { isOptionCorrect } from '../../../utils/is-option-correct';
import { resolveIsMultiAnswer } from '../../../utils/question-type-authority';

/**
 * Manages option selection logic, state transitions, and correctness evaluation for QQC.
 * Extracted from QuizQuestionComponent to reduce its size.
 */
@Service()
export class QqcOptionSelectionService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly explanationTextService = inject(ExplanationTextService);
  private readonly feedbackService = inject(FeedbackService);
  private readonly quizService = inject(QuizService);
  private readonly quizStateService = inject(QuizStateService);
  private readonly selectedOptionService = inject(SelectedOptionService);
  private readonly selectionMessageService = inject(SelectionMessageService);
  private readonly timerService = inject(TimerService);

  /**
   * Handles option add/remove based on checked state.
   */
  updateOptionSelection(
    event: { option: SelectedOption; checked: boolean; index?: number },
    option: SelectedOption,
    currentQuestionIndex: number
  ): void {
    if (!option) return;  // option is undefined, cannot update

    if (option.optionId === undefined) {
      // option.optionId is undefined, assigning fallback
      option.optionId = event.index ?? -1;
    }

    // Always stamp displayIndex so the persist/dedup layer can key by it.
    if (typeof event.index === 'number' && Number.isFinite(event.index)) {
      option.displayIndex = event.index;
      (option as any).index = event.index;
    }

    if (event.checked) {
      this.selectedOptionService.addOption(currentQuestionIndex, option);
    } else {
      this.selectedOptionService.removeOption(
        currentQuestionIndex,
        option.optionId
      );
    }
  }

  /**
   * Resolves a stable option ID from the option or fallback index.
   */
  resolveStableOptionId(option: Option | null | undefined, fallbackIndex: number): number {
    if (option == null) return fallbackIndex;

    if (typeof option.optionId === 'number' && Number.isFinite(option.optionId)) {
      return option.optionId;
    }

    if (option.optionId != null) {
      const parsed = Number(option.optionId);
      if (Number.isFinite(parsed)) return parsed;
    }

    if (typeof (option as any).value === 'number' && Number.isFinite((option as any).value)) {
      return (option as any).value;
    }

    return fallbackIndex;
  }

  /**
   * Marks a question as answered in the quiz state.
   */
  markQuestionAsAnswered(
    quizId: string,
    questionIndex: number,
    lastAllCorrect: boolean
  ): void {
    const questionState = this.quizStateService.getQuestionState(quizId, questionIndex);

    if (questionState) {
      questionState.isAnswered = true;
      questionState.explanationDisplayed = lastAllCorrect;

      this.quizStateService.setQuestionState(quizId, questionIndex, questionState);
    } else {
      // Question state not found for this question index
    }

    if (!this.quizStateService.isAnsweredSig()) {
      this.quizStateService.setAnswerSelected(true);
    }
  }

  /**
   * Handles timer stop logic based on whether the answer is correct.
   */
  async stopTimerIfApplicable(
    isMultipleAnswer: boolean,
    option: SelectedOption,
    currentQuestion: QuizQuestion | null,
    currentQuestionIndex: number,
    selectedIndices: Set<number>
  ): Promise<void> {
    let stopTimer = false;

    try {
      if (isMultipleAnswer) {
        if (!currentQuestion || !Array.isArray(currentQuestion.options)) return;

        const allCorrectSelected = this.selectedOptionService.areAllCorrectAnswersSelected(
          currentQuestion,
          selectedIndices
        );
        stopTimer = allCorrectSelected;
      } else {
        stopTimer = option.correct ?? false;
      }

      this.timerService.allowAuthoritativeStop();
      if (stopTimer) {
        const stopped = await this.timerService.attemptStopTimerForQuestion({
          questionIndex: currentQuestionIndex
        });

        if (stopped) {
          this.timerService.isTimerRunning = false;
        }
      }
    } catch (err: unknown) {
      console.error('QqcOptionSelectionService.stopTimerOnCorrectAnswer timer logic failed:', err);
    }
  }

  /**
   * Checks if the answer is correct and stops the timer if so.
   */
  async checkAndHandleCorrectAnswer(currentQuestionIndex: number): Promise<void> {
    const isCorrect = await this.quizService.checkIfAnsweredCorrectly();
    if (isCorrect) {
      this.timerService.attemptStopTimerForQuestion({
        questionIndex: currentQuestionIndex,
        onStop: () => { }
      });
    }
  }

  /**
   * Resets state for transitioning to a new question.
   */
  resetStateForNewQuestion(): {
    showFeedbackForOption: { [optionId: number]: boolean };
    showFeedback: boolean;
    correctMessage: string;
    selectedOption: null;
    isOptionSelected: boolean;
  } {
    this.selectedOptionService.clearOptions();
    this.selectedOptionService.clearSelectedOption();
    this.selectedOptionService.setOptionSelected(false);

    return {
      showFeedbackForOption: {},
      showFeedback: false,
      correctMessage: '',
      selectedOption: null,
      isOptionSelected: false
    };
  }

  /**
   * Handles option click toggle logic: assigns option IDs, adds/removes
   * selected options, updates answered state, and attempts timer stop.
   * Returns the updated selection state.
   * Extracted from handleOptionClicked().
   */
  handleOptionClicked(params: {
    currentQuestion: QuizQuestion;
    optionIndex: number;
    currentQuestionIndex: number;
  }): {
    selectedOptions: Option[];
    isOptionSelected: boolean;
    timerStopped: boolean;
  } | null {
    const { currentQuestion, optionIndex, currentQuestionIndex } = params;

    try {
      if (!currentQuestion || !Array.isArray(currentQuestion.options)) {
        return null;
      }

      // Ensure optionId is assigned to all options in the current question
      currentQuestion.options = this.quizService.quizOptions.assignOptionIds(
        currentQuestion.options, currentQuestionIndex
      );

      // Get selected options, but only include those with a valid optionId
      const selectedOptions: Option[] = this.selectedOptionService
        .getSelectedOptionIndices(currentQuestionIndex)
        .map((index: number) => currentQuestion.options[index])
        .filter((option) => option && option.optionId !== undefined);

      // Check if the option is already selected
      const isOptionSelected = selectedOptions.some(
        (option: Option) => option.optionId === optionIndex
      );

      // Add or remove the option based on its current state
      if (!isOptionSelected) {
        this.selectedOptionService.addSelectedOptionIndex(
          currentQuestionIndex,
          optionIndex
        );
      } else {
        this.selectedOptionService.removeSelectedOptionIndex(
          currentQuestionIndex,
          optionIndex
        );
      }

      // Check if all correct answers are selected
      // Update answered state
      this.selectedOptionService.updateAnsweredState(
        currentQuestion.options,
        currentQuestionIndex
      );

      // Handle multiple-answer logic
      const timerStopped = this.timerService.attemptStopTimerForQuestion({
        questionIndex: currentQuestionIndex
      });

      return {
        selectedOptions,
        isOptionSelected: !isOptionSelected,  // toggled
        timerStopped: !!timerStopped
      };
    } catch (err: unknown) {
      console.error('QqcOptionSelectionService.handleOptionClicked option click handling failed:', err);
      return null;
    }
  }

  /**
   * Sets correct message via the feedback service.
   */
  setCorrectMessage(optionsToDisplay: Option[], _question: QuizQuestion): string {
    const correctAnswers = optionsToDisplay.filter((opt) => opt.correct);
    return this.feedbackService.setCorrectMessage(
      correctAnswers,
      { options: optionsToDisplay } as any as QuizQuestion
    );
  }

  /**
   * Performs the full selectOption flow: resolves IDs, persists selection,
   * builds snapshot, fetches explanation, and returns state for the component.
   */
  async performSelectOption(params: {
    currentQuestion: QuizQuestion;
    option: SelectedOption;
    optionIndex: number;
    currentQuestionIndex: number;
    isMultipleAnswer: boolean;
    optionsToDisplay: Option[];
    selectedOptionsCount: number;
    getExplanationText: (idx: number) => Promise<string>;
  }): Promise<{
    selectedOption: SelectedOption;
    resolvedOptionId: number;
    showFeedbackForOption: Record<number, boolean>;
    isOptionSelected: boolean;
    isAnswered: boolean;
    explanationText: string;
    correctMessage: string;
  } | null> {
    const {
      currentQuestion, option, optionIndex, currentQuestionIndex,
      isMultipleAnswer, optionsToDisplay, selectedOptionsCount, getExplanationText
    } = params;

    if (optionIndex < 0) return null;  // invalid optionIndex

    const resolvedOptionId = this.resolveStableOptionId(option, optionIndex);

    const selectedOption: SelectedOption = {
      ...option,
      optionId: resolvedOptionId,
      questionIndex: currentQuestionIndex
    };

    const showFeedbackForOption: Record<number, boolean> = { [resolvedOptionId]: true };
    this.selectedOptionService.setSelectedOption(
      selectedOption, currentQuestionIndex, undefined, isMultipleAnswer
    );

    // Build a snapshot that mirrors what the user sees (UI order + flags)
    const qIdx = this.quizService.getCurrentQuestionIndex();
    const canonical = (this.quizService.questions?.[qIdx]?.options ?? []).map((o: Option) => ({ ...o }));
    const ui = (optionsToDisplay ?? []).map((o: Option) => ({ ...o }));
    const snapshot: Option[] =
      this.selectedOptionService.overlaySelectedByIdentity?.(canonical, ui) ?? ui ?? canonical;

    await this.selectedOptionService.selectOption(
      resolvedOptionId,
      selectedOption.questionIndex!,
      selectedOption.text ?? (selectedOption as any).value ?? '',
      isMultipleAnswer,
      snapshot
    );

    // Multi-answer guard: don't emit FET-related state for partially-answered
    // multi-answer questions. Check RAW question data for correct count.
    const rawQ = this.quizService?.questions?.[currentQuestionIndex] ?? currentQuestion;
    const rawOpts: any[] = rawQ?.options ?? [];
    const maCorrectCount = rawOpts.filter(
      (o: any) => isOptionCorrect(o)
    ).length;
    // TYPE ONLY — whether this question is answered with one pick or several.
    // The count is the fallback, not the authority: a declared single-answer
    // question the bank happened to flag twice used to be treated as multi and
    // never emitted its explanation from this path at all.
    //
    // Nothing about COMPLETION or CORRECTNESS is decided here — this path does
    // not consult either, and this change does not add such a gate. The
    // explanation TEXT below is fetched and returned regardless.
    //
    // `quizService.questions` is a getter returning shuffledQuestions while
    // shuffle is active, and `currentQuestionIndex` is a display index, so this
    // lands on the question on screen; `currentQuestion` is the object passed
    // straight in. REMOVE THE COUNT IN /questions CONTENT CUTOVER.
    const isMultiQ = resolveIsMultiAnswer(rawQ, maCorrectCount > 1);

    if (!isMultiQ) {
      this.explanationTextService.setIsExplanationTextDisplayed(true);
    }
    this.quizService.setCurrentQuestion(currentQuestion);

    this.selectedOptionService.updateSelectedOptions(
      currentQuestionIndex,
      resolvedOptionId,
      'add'
    );

    // Get explanation text
    const explanationText =
      (await getExplanationText(currentQuestionIndex)) ||
      'No explanation available';

    // Only emit explanation text to reactive pipeline for single-answer
    // or fully-resolved multi-answer questions.
    if (!isMultiQ) {
      this.explanationTextService.setExplanationText(explanationText);
    }

    if (currentQuestion && !isMultiQ) {
      this.explanationTextService.updateExplanationText(currentQuestion);
    }

    // Correct message
    const correctMessage = this.setCorrectMessage(optionsToDisplay, currentQuestion);

    return {
      selectedOption,
      resolvedOptionId,
      showFeedbackForOption,
      isOptionSelected: true,
      isAnswered: selectedOptionsCount > 0,
      explanationText,
      correctMessage
    };
  }

  /**
   * Handles the full option selection flow: resolves option ID, toggles selection,
   * processes selection, updates state, applies feedback, regenerates FET,
   * and updates quiz state.
   * Returns the updated state for the component to apply.
   * Extracted from handleOptionSelection().
   */
  async handleFullOptionSelection(params: {
    option: SelectedOption;
    optionIndex: number;
    currentQuestion: QuizQuestion;
    currentQuestionIndex: number;
    quizId: string;
    lastAllCorrect: boolean;
    optionsToDisplay: Option[];
    handleOptionClickedFn: (question: QuizQuestion, index: number) => Promise<void>;
    updateExplanationTextFn: (index: number) => Promise<string>;
  }): Promise<{
    selectedOption: SelectedOption;
    showFeedback: boolean;
    showFeedbackForOption: { [optionId: number]: boolean };
    selectedOptionIndex: number;
    explanationText: string;
    isFeedbackApplied: boolean;
  } | null> {
    const { option, optionIndex, currentQuestion, currentQuestionIndex, quizId } = params;

    // Ensure that the option and optionIndex are valid
    if (!option || optionIndex < 0) return null;  // invalid option/optionIndex

    // Ensure the question index is valid
    if (typeof currentQuestionIndex !== 'number' || currentQuestionIndex < 0) {
      // Invalid question index
      return null;
    }

    try {
      const resolvedOptionId = this.resolveStableOptionId(option, optionIndex);
      option.optionId = resolvedOptionId;

      // Toggle option selection state
      option.selected = !option.selected;

      // Process the selected option and update states (trigger selection logic)
      await params.handleOptionClickedFn(currentQuestion, optionIndex);

      // Check if this specific option is now selected
      const isOptionSelected = this.selectedOptionService.isSelectedOption(option);

      // Only update explanation display flag if not locked
      if (!(this.explanationTextService as any).isExplanationLocked?.()) {
        // Only trigger explanation if selected and correct, otherwise ensure it's hidden
        this.explanationTextService.setShouldDisplayExplanation(
          isOptionSelected && params.lastAllCorrect
        );
      }

      // Update selected option service
      this.selectedOptionService.setAnsweredState(true);
      this.selectedOptionService.updateSelectedOptions(currentQuestionIndex, resolvedOptionId, 'add');

      // Immediate state synchronization
      const selectedOption: SelectedOption = { ...option, correct: option.correct };
      const showFeedbackForOption: { [optionId: number]: boolean } = {};
      showFeedbackForOption[option.optionId!] = true;

      const selectedOptionIndex = params.optionsToDisplay.findIndex(
        (opt) => opt.optionId === option.optionId
      );

      // Re-generate FET immediately on every click to ensure cache is fresh and prefix is correct
      const explanationText = await params.updateExplanationTextFn(currentQuestionIndex);
      // Update the answers and check if the selection is correct
      this.quizService.updateAnswersForOption(option);
      await this.checkAndHandleCorrectAnswer(currentQuestionIndex);

      const totalCorrectAnswers = this.quizService.quizOptions.getTotalCorrectAnswers(currentQuestion);

      // Update the question state in the QuizStateService
      this.quizStateService.updateQuestionState(
        quizId,
        currentQuestionIndex,
        {
          selectedOptions: [option],
          isCorrect: option.correct ?? false,
        },
        totalCorrectAnswers
      );

      // Trigger explanation evaluation immediately
      this.explanationTextService.triggerExplanationEvaluation();

      return {
        selectedOption,
        showFeedback: true,
        showFeedbackForOption,
        selectedOptionIndex,
        explanationText,
        isFeedbackApplied: true
      };
    } catch (err: unknown) {
      console.error('QqcOptionSelectionService.selectOptionAndApplyFeedback option selection failed:', err);
      return null;
    }
  }

  /**
   * Fetches and processes the current question: resets state, loads question data,
   * builds display data, and checks answered state.
   * Extracted from fetchAndProcessCurrentQuestion().
   */
  async fetchAndProcessCurrentQuestion(params: {
    currentQuestionIndex: number;
    isAnyOptionSelectedFn: (index: number) => Promise<boolean>;
    shouldUpdateMessageOnAnswerFn: (isAnswered: boolean) => Promise<boolean>;
  }): Promise<{
    currentQuestion: QuizQuestion;
    optionsToDisplay: Option[];
    data: {
      questionText: string;
      explanationText?: string;
      correctAnswersText: string;
      options: Option[];
    };
  } | null> {
    try {
      // Reset state before fetching new question
      this.resetStateForNewQuestion();

      const currentQuestion = this.quizService.questions[params.currentQuestionIndex];
      if (!currentQuestion) return null;

      const optionsToDisplay = [...(currentQuestion.options || [])];

      // Set display data
      const data = {
        questionText: currentQuestion.questionText,
        explanationText: currentQuestion.explanation,
        correctAnswersText: this.quizService.getCorrectAnswersAsString(),
        options: optionsToDisplay
      };

      // Determine if the current question is answered
      const isAnswered = await params.isAnyOptionSelectedFn(params.currentQuestionIndex);

      // Update the selection message based on the current state
      await params.shouldUpdateMessageOnAnswerFn(isAnswered);

      return { currentQuestion, optionsToDisplay, data };
    } catch (err: unknown) {
      console.error('QqcOptionSelectionService.fetchAndProcessCurrentQuestion question fetch failed:', err);
      return null;
    }
  }

  /**
   * Updates the question state in QuizStateService after an option is selected.
   * Extracted from updateQuestionState().
   */
  updateQuestionState(params: {
    quizId: string;
    currentQuestionIndex: number;
    lastAllCorrect: boolean;
    option: SelectedOption;
    explanationToDisplay: string;
    correctAnswersLength: number;
  }): void {
    try {
      this.quizStateService.updateQuestionState(
        params.quizId,
        params.currentQuestionIndex,
        {
          explanationDisplayed: params.lastAllCorrect,
          selectedOptions: [params.option],
          explanationText: params.explanationToDisplay
        },
        params.correctAnswersLength
      );
    } catch (err: unknown) {
      console.error('QqcOptionSelectionService.updateQuestionState state update failed:', err);
    }
  }

  /**
   * Handles the full process-selected-option flow: processes feedback,
   * updates question state, handles correct answers, and updates feedback.
   * Extracted from processSelectedOption().
   */
  async processSelectedOption(params: {
    option: SelectedOption;
    index: number;
    checked: boolean;
    currentQuestionIndex: number;
    quizId: string;
    lastAllCorrect: boolean;
    explanationToDisplay: string;
    correctAnswersLength: number;
    handleOptionProcessingAndFeedback: (option: SelectedOption, index: number, checked: boolean) => Promise<void>;
    getCorrectAnswers: () => Promise<number[]>;
  }): Promise<{
    correctAnswers: number[];
  }> {
    await params.handleOptionProcessingAndFeedback(params.option, params.index, params.checked);

    this.updateQuestionState({
      quizId: params.quizId,
      currentQuestionIndex: params.currentQuestionIndex,
      lastAllCorrect: params.lastAllCorrect,
      option: params.option,
      explanationToDisplay: params.explanationToDisplay,
      correctAnswersLength: params.correctAnswersLength
    });

    const correctAnswers = await params.getCorrectAnswers();

    return {
      correctAnswers: correctAnswers ?? []
    };
  }

  /**
   * Handles correctness check and timer stop after option selection.
   * Extracted from handleCorrectnessAndTimer().
   */
  async handleCorrectnessAndTimer(params: {
    currentQuestionIndex: number;
  }): Promise<boolean> {
    const isCorrect = await this.quizService.checkIfAnsweredCorrectly();
    if (isCorrect) {
      this.timerService.attemptStopTimerForQuestion({
        questionIndex: params.currentQuestionIndex
      });
    }
    return isCorrect;
  }

  /**
   * Performs the unselectOption reset: clears selections, feedback, and explanation text.
   * Extracted from unselectOption().
   */
  unselectOption(currentQuestionIndex: number): {
    selectedOptions: any[];
    optionChecked: {};
    showFeedbackForOption: {};
    showFeedback: false;
    selectedOption: null;
  } {
    this.selectedOptionService.clearSelectionsForQuestion(currentQuestionIndex);
    return {
      selectedOptions: [],
      optionChecked: {},
      showFeedbackForOption: {},
      showFeedback: false,
      selectedOption: null
    };
  }

  /**
   * Handles selection message update: notifies service of mutation and recomputes message.
   * Extracted from handleSelectionMessageUpdate().
   */
  handleSelectionMessageUpdate(params: {
    optionsToDisplay: Option[];
    currentQuestionOptions: Option[] | undefined;
    isAnswered: boolean;
  }): void {
    // Wait a microtask so any selection mutations and state evals have landed
    queueMicrotask(() => {
      // Then wait a frame to ensure the rendered list reflects the latest flags
      requestAnimationFrame(async () => {
        const optionsNow = (params.optionsToDisplay?.length
          ? params.optionsToDisplay
          : params.currentQuestionOptions) as Option[] || [];

        // Notify the service that selection just changed (starts hold-off window)
        this.selectionMessageService.notifySelectionMutated(optionsNow);

        // Upgrade: always recompute based on answered state
        await this.selectionMessageService.setSelectionMessage(params.isAnswered);
      });
    });
  }

  /**
   * Computes the emitPassiveNow logic: determines question type from options and begins write.
   * Extracted from emitPassiveNow().
   */
  emitPassiveNow(_params: {
    index: number;
    normalizeIndex: (idx: number) => number;
    optionsToDisplay: Option[];
    currentQuestionType: QuestionType | undefined;
  }): void {
    // Body intentionally empty: the previous implementation only seeded
    // the SelectionMessageService.beginWrite() write-fence (now removed
    // as dead). Keeping the method as a no-op stub avoids ripping out
    // the entire emitPassiveNow delegation chain (component ->
    // componentOrchestrator -> orchSelection -> here) in this commit.
  }

  /**
   * Handles core selection state transitions after an option click:
   * transitions from question to explanation mode on first selection,
   * persists the selected option, and evaluates next button state.
   * Extracted from handleCoreSelection() in QuizQuestionComponent.
   */
  handleCoreSelectionState(params: {
    option: SelectedOption;
    questionIndex: number;
    currentQuestionIndex: number;
    questionType: QuestionType | undefined;
    forceQuestionDisplay: boolean;
    lastAllCorrect: boolean;
  }): {
    isAnswered: boolean;
    forceQuestionDisplay: boolean;
    displayStateAnswered: boolean;
    displayStateMode: 'question' | 'explanation';
  } {
    const isMultiSelect = params.questionType === QuestionType.MultipleAnswer;
    let forceQuestionDisplay = params.forceQuestionDisplay;
    let isAnswered = false;
    let displayStateAnswered = false;
    let displayStateMode: 'question' | 'explanation' = 'question';

    // Transition from question to explanation mode on first selection
    if (forceQuestionDisplay) {
      isAnswered = true;
      forceQuestionDisplay = false;
      displayStateAnswered = true;
      displayStateMode = 'explanation';
    }

    if (params.currentQuestionIndex === params.questionIndex) {
      this.setAnsweredAndDisplayState(params.lastAllCorrect);
    }

    if (params.option) {
      this.selectedOptionService.setSelectedOption(
        params.option, params.questionIndex, undefined, isMultiSelect
      );
    }

    this.selectedOptionService.evaluateNextButtonStateForQuestion(
      params.questionIndex,
      params.questionType === QuestionType.MultipleAnswer
    );

    return { isAnswered, forceQuestionDisplay, displayStateAnswered, displayStateMode };
  }

  /**
   * Performs post-click tasks: marks question as answered, sets global state,
   * and builds the selection payload.
   * Returns the SelectedOption payload for emission.
   * Extracted from postClickTasks() in QuizQuestionComponent.
   */
  performPostClickTasks(params: {
    opt: SelectedOption;
    idx: number;
    questionIndex: number;
    quizId: string;
    lastAllCorrect: boolean;
    currentQuestionIndex: number;
  }): { sel: SelectedOption; shouldUpdateGlobalState: boolean } {
    const lockedIndex = params.questionIndex ?? params.currentQuestionIndex;
    this.markQuestionAsAnswered(params.quizId, lockedIndex, params.lastAllCorrect);

    const sel: SelectedOption = {
      ...params.opt,
      questionIndex: lockedIndex
    };

    const shouldUpdateGlobalState = params.currentQuestionIndex === lockedIndex;
    if (shouldUpdateGlobalState) this.selectedOptionService.setAnswered(true);

    return { sel, shouldUpdateGlobalState };
  }

  /**
   * Handles the setAnsweredAndDisplayState logic: sets answered state in services.
   * Returns the display state to apply.
   * Extracted from setAnsweredAndDisplayState().
   */
  setAnsweredAndDisplayState(lastAllCorrect: boolean): {
    mode: 'question' | 'explanation';
    answered: boolean;
  } {
    this.selectedOptionService.setAnswered(true);
    this.quizStateService.setAnswered(true);
    const displayState = {
      mode: (lastAllCorrect ? 'explanation' : 'question') as 'question' | 'explanation',
      answered: true
    };
    this.quizStateService.setDisplayState(displayState);
    return displayState;
  }

  /**
   * Orchestrates the full finalizeSelection flow: fetches current question,
   * selects option, processes explanation, handles option selection,
   * updates question state, emits answered, checks correctness/timer.
   * Returns state for the component to apply.
   * Extracted from finalizeSelection() in QuizQuestionComponent.
   */
  async performFinalizeSelection(params: {
    option: SelectedOption;
    index: number;
    wasPreviouslySelected: boolean;
    currentQuestionIndex: number;
    quizId: string;
    lastAllCorrect: boolean;
    fetchAndProcessCurrentQuestion: () => Promise<QuizQuestion | null>;
    selectOption: (q: QuizQuestion, opt: SelectedOption, idx: number) => Promise<void>;
    processCurrentQuestion: (q: QuizQuestion) => Promise<{ shouldDisplay: boolean }>;
    handleOptionSelection: (opt: SelectedOption, idx: number, q: QuizQuestion) => Promise<void>;
  }): Promise<{
    shouldDisplay: boolean;
  } | null> {
    const currentQuestion = await params.fetchAndProcessCurrentQuestion();
    if (!currentQuestion) return null;

    // Select the option and update the state
    await params.selectOption(currentQuestion, params.option, params.index);

    const explanationResult = await params.processCurrentQuestion(currentQuestion);
    await params.handleOptionSelection(params.option, params.index, currentQuestion);
    this.quizStateService.updateQuestionStateForExplanation(
      params.quizId,
      params.currentQuestionIndex
    );

    await this.handleCorrectnessAndTimer({
      currentQuestionIndex: params.currentQuestionIndex,
    });

    return {
      shouldDisplay: explanationResult.shouldDisplay
    };
  }

  /**
   * Handles the post-selection transition: registers click or reconciles deselection,
   * and updates selection message.
   * Extracted from performInitialSelectionFlow() in QuizQuestionComponent.
   */
  handleSelectionTransitionAndMessage(params: {
    prevSelected: boolean;
    nowSelected: boolean;
    transition: {
      becameSelected: boolean;
      becameDeselected: boolean;
      optId: number;
      wasCorrect: boolean;
    };
    currentQuestionIndex: number;
    optionsToDisplay: Option[];
    currentQuestionOptions: Option[] | undefined;
    isAnswered: boolean;
  }): void {
    if (params.transition.becameDeselected) {
      const optsNow = (params.optionsToDisplay?.length ? params.optionsToDisplay : params.currentQuestionOptions) as Option[] || [];
      this.selectionMessageService['reconcileObservedWithCurrentSelection']?.(params.currentQuestionIndex, optsNow);
    }

    this.handleSelectionMessageUpdate({
      optionsToDisplay: params.optionsToDisplay,
      currentQuestionOptions: params.currentQuestionOptions,
      isAnswered: params.isAnswered
    });
  }
}