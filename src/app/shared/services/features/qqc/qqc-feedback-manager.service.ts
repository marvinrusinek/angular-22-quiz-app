import { inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { QuestionType } from '@shared/models/question-type.enum';

import { FeedbackConfig } from '@shared/models/FeedbackConfig.model';
import { FeedbackProps } from '@shared/models/FeedbackProps.model';
import { Option } from '@shared/models/Option.model';
import { OptionBindings } from '@shared/models/OptionBindings.model';
import { QuizQuestion } from '@shared/models/QuizQuestion.model';
import { SelectedOption } from '@shared/models/SelectedOption.model';

import { ExplanationTextService } from '@shared/services/features/explanation/explanation-text.service';
import { FeedbackService } from '@shared/services/features/feedback/feedback.service';
import { QuizQuestionManagerService } from '@shared/services/flow/quizquestionmgr.service';
import { QuestionVerdictService } from '@shared/services/features/verdict/question-verdict.service';
import { QuizService } from '@shared/services/data/quiz.service';
import { SelectedOptionService } from '@shared/services/state/selectedoption.service';
import { SelectionMessageService } from '@shared/services/features/selection-message/selection-message.service';
import { isOptionCorrect } from '@shared/utils/is-option-correct';
import { norm } from '@shared/utils/text-norm';

/**
 * Manages feedback display, option highlighting, and disable logic for QQC.
 * Extracted from QuizQuestionComponent to reduce its size.
 */
@Service()
export class QqcFeedbackManagerService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly explanationTextService = inject(ExplanationTextService);
  private readonly feedbackService = inject(FeedbackService);
  private readonly quizQuestionManagerService = inject(QuizQuestionManagerService);
  private readonly quizService = inject(QuizService);
  private readonly verdicts = inject(QuestionVerdictService);
  private readonly selectedOptionService = inject(SelectedOptionService);
  private readonly selectionMessageService = inject(SelectionMessageService);

  /**
   * Restores feedback state for all options based on correctness.
   */
  restoreFeedbackState(
    currentQuestion: QuizQuestion | null,
    optionsToDisplay: Option[],
    correctMessage: string
  ): Option[] {
    if (!currentQuestion || !optionsToDisplay.length) return optionsToDisplay;

    try {
      return optionsToDisplay.map((option) => ({
        ...option,
        active: true,
        feedback: option.feedback || this.generateFeedbackForOption(option, correctMessage),
        showIcon: option.correct || option.showIcon,
        selected: option.selected ?? false
      }));
    } catch {
      return optionsToDisplay;
    }
  }

  /**
   * Generates feedback text for a single option.
   */
  generateFeedbackForOption(option: Option, correctMessage: string): string {
    if (option.correct) {
      return correctMessage || 'Correct answer!';
    } else {
      return option.feedback || 'No feedback available.';
    }
  }

  /**
   * Updates highlight state for all options based on whether all correct answers are selected.
   */
  async updateOptionHighlightState(
    currentQuestion: QuizQuestion | null,
    selectedIndices: Set<number>
  ): Promise<void> {
    if (!currentQuestion || !Array.isArray(currentQuestion.options)) return;

    const allCorrectSelected = this.selectedOptionService.areAllCorrectAnswersSelected(
      currentQuestion,
      selectedIndices
    );

    for (const opt of currentQuestion.options) {
      opt.highlight = !this.isCorrectOption(currentQuestion, opt) && allCorrectSelected;
    }
  }

  /**
   * Is this option correct, for FEEDBACK purposes?
   *
   * Correctness comes from QuestionVerdictService, not from `option.correct`.
   * Read-only: safe to call from highlight/deactivate paths, which run during
   * state derivation. Selection submission stays with the 9A writer seam.
   *
   * Order matches the per-option highlight helper:
   *   1. the user selected it -> their own verdict
   *   2. resolved | expired   -> authorized full reveal
   *   3. anything else        -> false
   *
   * Case 3 is the security invariant, and it now covers idle/checking/error as
   * well as incomplete. It used to fall through to `isOptionCorrect(option)`
   * because the timeout reveal was unmigrated and something had to paint it;
   * 10F moved that onto the expired verdict, so the last caller that needed the
   * fallback is gone.
   *
   * "No verdict yet" is not "not correct" — it is "not known", and the only
   * honest render for it is no correctness at all. Guessing from the local bank
   * would work right up until the bank leaves the bundle, then fail silently.
   */
  private isCorrectOption(question: QuizQuestion | null, option: Option): boolean {
    const quizId = (this.quizService as any)?.quizId as string | undefined;
    const questionText = question?.questionText;
    const optionText = option?.text;

    if (quizId && questionText && optionText) {
      const own = this.verdicts.verdictForOption(quizId, questionText, optionText);
      if (own !== null) return own;

      const state = this.verdicts.verdictFor(quizId, questionText);
      if (state.phase === 'resolved' || state.phase === 'expired') {
        const target = norm(optionText);
        return state.correctOptionTexts.some((text) => norm(text) === target);
      }
    }

    // No authorized verdict for this option — reveal nothing.
    return false;
  }

  /**
   * Deactivates incorrect options after all correct answers are selected.
   */
  deactivateIncorrectOptions(
    allCorrectSelected: boolean,
    currentQuestion: QuizQuestion | null,
    selectedIndices: Set<number>
  ): Option[] | null {
    if (!allCorrectSelected) return null;

    if (currentQuestion?.options?.length) {
      for (const opt of currentQuestion.options) {
        // Terminal path only (guarded by allCorrectSelected above), so the
        // verdict is resolved and the full reveal is authorized.
        if (!this.isCorrectOption(currentQuestion, opt)) {
          opt.selected = false;
          opt.highlight = true;
          opt.active = false;
        } else {
          opt.active = true;
        }
      }

      const updatedOptions = [...currentQuestion.options];
      this.updateOptionHighlightState(currentQuestion, selectedIndices);
      return updatedOptions;
    } else {
      return null;
    }
  }

  /**
   * Disables incorrect options by marking them inactive.
   */
  disableIncorrectOptions(optionsToDisplay: Option[]): Option[] {
    if (!optionsToDisplay || optionsToDisplay.length === 0) {
      return optionsToDisplay;
    }

    return optionsToDisplay.map((option) => ({
      ...option,
      active: option.correct,
      feedback: option.correct ? undefined : 'x',
      showIcon: true
    }));
  }

  /**
   * Updates highlighting, selected state, and feedback icons for options after a click.
   */
  updateOptionHighlighting(
    optionsToDisplay: Option[],
    selectedKeys: Set<string | number>,
    currentQuestionIndex: number,
    questionType: QuestionType | undefined
  ): Option[] {
    if (!optionsToDisplay) return optionsToDisplay;

    for (let idx = 0; idx < optionsToDisplay.length; idx++) {
      const opt = optionsToDisplay[idx];
      const stableId = this.selectionMessageService.stableKey(opt, idx);
      const isSelected = selectedKeys.has(stableId);

      opt.selected = isSelected;

      const qIdx = currentQuestionIndex ?? 0;
      const selections = this.selectedOptionService.getSelectedOptionsForQuestion(qIdx) ?? [];
      const isMulti = questionType === QuestionType.MultipleAnswer;
      const isLastSelection = isSelected && selections.length > 0 &&
        (selections[selections.length - 1].optionId === opt.optionId || (selections[selections.length - 1] as any).index === idx);

      let shouldHighlight = isSelected;
      if (isMulti && opt.correct) shouldHighlight = isLastSelection;

      if (opt.correct) {
        opt.styleClass = shouldHighlight ? 'highlight-correct' : '';
        opt.showIcon = isSelected;
      } else {
        opt.styleClass = shouldHighlight ? 'highlight-incorrect' : '';
        opt.showIcon = isSelected;
      }
    }

    return optionsToDisplay;
  }

  /**
   * Reveals feedback for all options (used on timeout/completion).
   */
  revealFeedbackForAllOptions(
    canonicalOpts: Option[],
    feedbackConfigs: Record<number | string, FeedbackConfig>,
    showFeedbackForOption: { [optionId: number]: boolean }
  ): {
    feedbackConfigs: Record<number | string, FeedbackConfig>;
    showFeedbackForOption: { [optionId: number]: boolean };
  } {
    for (let i = 0; i < canonicalOpts.length; i++) {
      const o = canonicalOpts[i];

      const rawKey = o.optionId ?? this.selectionMessageService.stableKey(o, i);
      const key = Number(rawKey);

      if (!Number.isFinite(key)) {
        const sk = String(rawKey);
        feedbackConfigs[sk] = {
          ...(feedbackConfigs[sk] ?? {}),
          showFeedback: true,
          icon: o.correct ? 'check_circle' : 'cancel',
          isCorrect: !!o.correct
        };
        (showFeedbackForOption as any)[sk] = true;
        continue;
      }

      feedbackConfigs[key] = {
        ...(feedbackConfigs[key] ?? {}),
        showFeedback: true,
        icon: o.correct ? 'check_circle' : 'cancel',
        isCorrect: !!o.correct
      };
      showFeedbackForOption[key] = true;
    }

    return { feedbackConfigs, showFeedbackForOption };
  }

  /**
   * Marks the binding as selected and rebuilds selectedKeys from the service map.
   */
  markBindingSelected(
    opt: Option,
    currentQuestionIndex: number,
    optionBindings: OptionBindings[]
  ): OptionBindings | null {
    const currentSelected =
      this.selectedOptionService.selectedOptionsMap.get(currentQuestionIndex) ?? [];
    const selectedKeys = new Set(currentSelected.map(o => o.optionId));

    const b = optionBindings.find(x => x.option.optionId === opt.optionId);
    if (!b) return null;

    b.isSelected = selectedKeys.has(opt.optionId!);
    b.showFeedback = true;

    return b;
  }

  /**
   * Builds feedback config for a specific option row.
   */
  buildFeedbackConfigForOption(
    opt: Option,
    optionBindings: OptionBindings[],
    currentQuestion: QuizQuestion,
    existingConfigs: Record<number | string, FeedbackConfig>
  ): FeedbackProps {
    return {
      ...existingConfigs[opt.optionId!],
      showFeedback: true,
      selectedOption: opt,
      options: optionBindings.map((b) => b.option),
      question: currentQuestion,
      feedback: opt.feedback ?? '',
      idx:
        optionBindings.find((b) => b.option.optionId === opt.optionId)
          ?.index ?? 0,
      correctMessage: ''
    } as FeedbackProps;
  }

  /**
   * Resets the feedback-related state for a new question.
   */
  resetFeedbackForOption(optionId: number): { [optionId: number]: boolean } {
    return { [optionId]: true };
  }

  /**
   * Processes feedback update for a selected option.
   * Returns the updated showFeedbackForOption map and the selected option index, or null if skipped.
   */
  updateFeedback(params: {
    option: SelectedOption;
    isUserClickInProgress: boolean;
    showFeedback: boolean;
    selectedOption: SelectedOption | null;
    optionsToDisplay: Option[];
    currentQuestionIndex: number;
    isMultipleAnswer: boolean;
  }): {
    showFeedbackForOption: { [optionId: number]: boolean };
    selectedIndex: number;
  } | null {
    if (!params.isUserClickInProgress) return null;

    // Reset feedback for this option
    const showFeedbackForOption = this.resetFeedbackForOption(params.option.optionId!);
    showFeedbackForOption[params.option.optionId!] =
      params.showFeedback && params.selectedOption === params.option;

    // Find the index of the selected option
    const selectedIndex = params.optionsToDisplay.findIndex(
      (opt) => opt.optionId === params.option.optionId
    );

    // Update service state
    this.selectedOptionService.setOptionSelected(true);
    this.selectedOptionService.setSelectedOption(
      params.option,
      params.currentQuestionIndex,
      undefined,
      params.isMultipleAnswer
    );
    this.selectedOptionService.setAnsweredState(true);

    return { showFeedbackForOption, selectedIndex };
  }

  /**
   * Applies feedback to a selected option within the options list.
   * Returns updated optionsToDisplay and showFeedbackForOption, or null if invalid.
   */
  applyOptionFeedback(
    selectedOption: Option,
    optionsToDisplay: Option[],
    showFeedbackForOption: { [optionId: number]: boolean }
  ): {
    optionsToDisplay: Option[];
    showFeedbackForOption: { [optionId: number]: boolean };
    selectedOptionIndex: number;
  } | null {
    if (!selectedOption) return null;

    showFeedbackForOption = showFeedbackForOption || {};
    showFeedbackForOption[selectedOption.optionId!] = true;

    const selectedOptionIndex = optionsToDisplay.findIndex(
      (opt) => opt.optionId === selectedOption.optionId
    );
    if (selectedOptionIndex === -1) return null;

    // Apply feedback to only the clicked option, keeping others unchanged
    const updatedOptions = optionsToDisplay.map((option) => ({
      ...option,
      feedback:
        option.optionId === selectedOption.optionId
          ? option.correct
            ? 'âœ… This is a correct answer!'
            : 'âŒ Incorrect answer!'
          : option.feedback,
      showIcon: option.optionId === selectedOption.optionId,
      selected: option.optionId === selectedOption.optionId
    }));

    return {
      optionsToDisplay: updatedOptions,
      showFeedbackForOption,
      selectedOptionIndex
    };
  }

  /**
   * Processes option selection and generates feedback after a click.
   * Handles calling the parent handler, setting feedback state, and
   * generating explanation + correct message.
   *
   * Returns the computed state for the component to apply.
   * Extracted from QuizQuestionComponent.handleOptionProcessingAndFeedback().
   */
  async handleOptionProcessingAndFeedback(params: {
    option: SelectedOption;
    index: number;
    checked: boolean;
    currentQuestionIndex: number;
    lastAllCorrect: boolean;
    optionsToDisplay: Option[];
    callParentOnOptionClicked: (event: { option: SelectedOption; index: number; checked: boolean }) => Promise<void>;
    fetchAndSetExplanationText: (idx: number) => Promise<void>;
  }): Promise<{
    selectedOptions: SelectedOption[];
    selectedOption: SelectedOption;
    showFeedback: boolean;
    showFeedbackForOption: { [optionId: number]: boolean };
    isAnswered: boolean;
    explanationToDisplay: string;
    correctMessage: string;
    shouldDisplayExplanation: boolean;
    displayExplanation: boolean;
  } | null> {
    try {
      const event = { option: params.option, index: params.index, checked: params.checked };
      await params.callParentOnOptionClicked(event);

      const selectedOptions: SelectedOption[] = [
        { ...params.option, questionIndex: params.currentQuestionIndex }
      ];
      const selectedOption = { ...params.option };
      const showFeedbackForOption: { [optionId: number]: boolean } = {};
      showFeedbackForOption[params.option.optionId!] = true;

      let explanationToDisplay = '';
      let shouldDisplayExplanation = false;
      let displayExplanation = false;

      if (params.lastAllCorrect) {
        await params.fetchAndSetExplanationText(params.currentQuestionIndex);
        shouldDisplayExplanation = true;
        displayExplanation = true;
      }

      const questionData: any = await firstValueFrom(
        this.quizService.getQuestionByIndex(params.currentQuestionIndex)
      );

      let correctMessage = '';
      if (this.quizQuestionManagerService.isValidQuestionData(questionData!)) {
        if (params.lastAllCorrect) {
          const rawExpl = questionData!.explanation ?? 'No explanation available';
          explanationToDisplay = rawExpl;
          this.explanationTextService.updateFormattedExplanation(rawExpl);
        }

        correctMessage = this.feedbackService.setCorrectMessage(
          params.optionsToDisplay,
          questionData as QuizQuestion
        );
      } else {
        return null;
      }

      return {
        selectedOptions,
        selectedOption,
        showFeedback: true,
        showFeedbackForOption,
        isAnswered: true,
        explanationToDisplay,
        correctMessage,
        shouldDisplayExplanation,
        displayExplanation
      };
    } catch {
      return null;
    }
  }

  /**
   * Generates feedback text for a question using the feedback service.
   * Returns the feedback string, or a fallback/error message.
   * Extracted from QuizQuestionComponent.generateFeedbackText().
   */
  generateFeedbackText(
    question: QuizQuestion,
    optionsToDisplay: Option[]
  ): string {
    try {
      // Validate the question and its options
      if (!question || !question.options || question.options.length === 0) {
        return 'No feedback available for the current question.';
      }

      // Validate optionsToDisplay
      if (!optionsToDisplay || optionsToDisplay.length === 0) {
        return 'No options available to generate feedback.';
      }

      // Extract correct options from the question
      const correctOptions = question.options.filter((option) => option.correct);
      if (correctOptions.length === 0) {
        return 'No correct answers defined for this question.';
      }

      // Generate feedback using the feedback service
      const feedbackText = this.feedbackService.setCorrectMessage(
        optionsToDisplay,
        question
      );

      return feedbackText || 'No feedback generated for the current question.';
    } catch {
      return 'An error occurred while generating feedback. Please try again.';
    }
  }

  /**
   * Validates and prepares feedback application for a selected option.
   * Returns the selectedOptionIndex and whether explanation evaluation should trigger.
   * Extracted from applyFeedbackIfNeeded().
   */
  applyFeedbackIfNeeded(params: {
    option: SelectedOption;
    optionsToDisplay: Option[];
    showFeedbackForOption: { [optionId: number]: boolean };
  }): {
    showFeedbackForOption: { [optionId: number]: boolean };
    selectedOptionIndex: number;
    foundOption: Option | null;
    shouldTriggerExplanation: boolean;
  } | null {
    const { option, optionsToDisplay } = params;
    if (!option) return null;

    // Ensure UI-related states are initialized
    const showFeedbackForOption = params.showFeedbackForOption || {};
    showFeedbackForOption[option.optionId!] = true;

    // Find index of the selected option safely
    const selectedOptionIndex = optionsToDisplay.findIndex(
      (opt) => opt.optionId === option.optionId
    );
    if (selectedOptionIndex === -1) return null;

    const foundOption = optionsToDisplay[selectedOptionIndex];

    // Explanation evaluation check
    const ready = !!this.explanationTextService.latestExplanation?.trim();
    const show = this.explanationTextService.shouldDisplayExplanationSig();

    return {
      showFeedbackForOption,
      selectedOptionIndex,
      foundOption,
      shouldTriggerExplanation: ready && show
    };
  }

  /**
   * Processes initial selection flow: handles selection message registration
   * for click-based selection/deselection transitions.
   * Returns the message update flags.
   * Extracted from performInitialSelectionFlow().
   */
  /**
   * Computes the correct answers banner text for a question.
   * Returns the banner text and the number of correct options.
   * Extracted from loadQuestion().
   */
  computeCorrectAnswersBanner(params: {
    currentQuestion: QuizQuestion | null;
    currentQuestionIndex: number;
  }): { bannerText: string; numCorrect: number } {
    try {
      const q = params.currentQuestion;
      if (q?.options?.length) {
        const numCorrect = q.options.filter(o => o.correct).length;
        const totalOpts = q.options.length;
        const msg = this.quizQuestionManagerService.getNumberOfCorrectAnswersText(numCorrect, totalOpts);

        if (numCorrect > 1) {
          return { bannerText: msg, numCorrect };
        } else {
          return { bannerText: '', numCorrect };
        }
      }
    } catch (err: unknown) {
      console.error('QqcFeedbackManagerService.computeCorrectBanner banner computation failed:', err);
    }

    return { bannerText: '', numCorrect: 0 };
  }

  computeSelectionTransition(params: {
    prevSelected: boolean;
    nowSelected: boolean;
    option: SelectedOption;
    currentQuestionIndex: number;
  }): {
    becameSelected: boolean;
    becameDeselected: boolean;
    wasCorrect: boolean;
    optId: number;
  } {
    const { prevSelected, nowSelected, option } = params;
    const becameSelected = !prevSelected && nowSelected;
    const becameDeselected = prevSelected && !nowSelected;
    const optId = Number(option.optionId);

    // Use fields that actually exist on your model
    const wasCorrect =
      isOptionCorrect(option) ||
      (typeof option.feedback === 'string' && /correct/i.test(option.feedback));

    return { becameSelected, becameDeselected, wasCorrect, optId };
  }
}