import { Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { Option, QuizQuestion, SelectedOption } from '@shared/models';

import type { QuizQuestionComponent } from '../../../../components/question/quiz-question/quiz-question.component';

import { delay } from '@shared/utils/delay';

type Host = QuizQuestionComponent;

/**
 * Orchestrates QQC option selection, feedback, and post-click flows.
 * Extracted from QqcComponentOrchestratorService.
 */
@Service()
export class QqcOrchSelectionService {

  async runHandleOptionSelection(
    host: Host,
    option: SelectedOption,
    optionIndex: number,
    currentQuestion: QuizQuestion
  ): Promise<void> {
    const result = await host.optionSelection.handleFullOptionSelection({
      option,
      optionIndex,
      currentQuestion,
      currentQuestionIndex: host.currentQuestionIndex(),
      quizId: host.quizId()!,
      lastAllCorrect: host._lastAllCorrect,
      optionsToDisplay: host.optionsToDisplay(),
      handleOptionClickedFn: async (q: QuizQuestion, idx: number) => {
        const r = host.optionSelection.handleOptionClicked({
          currentQuestion: q,
          optionIndex: idx,
          currentQuestionIndex: host.currentQuestionIndex()
        });
        if (r) host.cdRef.markForCheck();
      },
      updateExplanationTextFn: (idx: number) => host.updateExplanationText(idx)
    });
    if (!result) return;
    host.selectedOption = result.selectedOption;
    host.showFeedback.set(result.showFeedback);
    host.showFeedbackForOption = result.showFeedbackForOption;
    host.selectedOptionIndex = result.selectedOptionIndex;
    host.explanationText.set(result.explanationText);
    host.applyFeedbackIfNeeded(option);
    host.optionSelection.setAnsweredAndDisplayState(host._lastAllCorrect);
  }

  async runIsAnyOptionSelected(host: Host, questionIndex: number): Promise<boolean> {
    const rs = host.optionSelection.resetStateForNewQuestion();
    host.showFeedbackForOption = rs.showFeedbackForOption;
    host.showFeedback.set(rs.showFeedback);
    host.correctMessage.set(rs.correctMessage);
    host.selectedOption = rs.selectedOption;
    host.isOptionSelected.set(rs.isOptionSelected);
    host.emitExplanationChange('', false);
    try {
      return await firstValueFrom(host.quizService.isAnswered(questionIndex));
    } catch {
      return false;
    }
  }

  async runOnSubmitMultiple(host: Host): Promise<void> {
    const idx = host.currentQuestionIndex() ?? host.quizService.getCurrentQuestionIndex() ?? 0;
    const computed = host.explanationFlow.computeSubmitMultipleExplanation({ currentQuestionIndex: idx });
    if (!computed) return;
    await host.explanationFlow.applySubmitMultipleExplanation({
      currentQuestionIndex: idx,
      formatted: computed.formatted,
      correctAnswersText: computed.correctAnswersText,
      questionType: computed.questionType
    });
    host.displayMode.set('explanation');
    host.isAnswered.set(true);
    host.displayExplanation.set(true);
    host.explanationToDisplay.set(computed.formatted);
    host.explanationToDisplayChange?.emit(computed.formatted);
  }

  async runPostClickTasks(
    host: Host,
    opt: SelectedOption,
    idx: number,
    _checked: boolean,
    wasPreviouslySelected: boolean,
    questionIndex?: number
  ): Promise<void> {
    const lockedIndex = questionIndex ?? host.currentQuestionIndex();
    const { sel, shouldUpdateGlobalState } = host.optionSelection.performPostClickTasks({
      opt,
      idx,
      questionIndex: lockedIndex,
      quizId: host.quizId()!,
      lastAllCorrect: host._lastAllCorrect,
      currentQuestionIndex: host.currentQuestionIndex()
    });
    await host.finalizeSelection(opt, idx, wasPreviouslySelected);
    host.optionSelected.emit(sel);
    host.events.emit({ type: 'optionSelected', payload: sel });
    if (shouldUpdateGlobalState) host.nextButtonStateService.setNextButtonState(true);
    host.cdRef.markForCheck();
  }

  async runPerformInitialSelectionFlow(
    host: Host, 
    event: any, 
    option: SelectedOption
  ): Promise<void> {
    const prevSelected = !!option.selected;
    host.optionSelection.updateOptionSelection(event, option, host.currentQuestionIndex());
    await host.handleOptionSelection(option, event.index, host.currentQuestion()!);
    host.applyFeedbackIfNeeded(option);
    const nowSelected = !!option.selected;
    const transition = host.feedbackManager.computeSelectionTransition({
      prevSelected,
      nowSelected,
      option,
      currentQuestionIndex: host.currentQuestionIndex()
    });
    host.optionSelection.handleSelectionTransitionAndMessage({
      prevSelected,
      nowSelected,
      transition,
      currentQuestionIndex: host.currentQuestionIndex(),
      optionsToDisplay: host.optionsToDisplay(),
      currentQuestionOptions: host.currentQuestion()?.options,
      isAnswered: host.isAnswered()
    });
  }

  async runApplyFeedbackIfNeeded(host: Host, option: SelectedOption): Promise<void> {
    if (!host.optionsToDisplay()?.length) host.populateOptionsToDisplay();
    const result = host.feedbackManager.applyFeedbackIfNeeded({
      option,
      optionsToDisplay: host.optionsToDisplay(),
      showFeedbackForOption: host.showFeedbackForOption
    });
    if (!result) return;
    host.showFeedbackForOption = result.showFeedbackForOption;
    host.selectedOptionIndex = result.selectedOptionIndex;
    if (result.shouldTriggerExplanation) {
      host.explanationTextService.triggerExplanationEvaluation();
    }
    host.cdRef.markForCheck();
  }

  async runApplyOptionFeedback(host: Host, selectedOption: Option): Promise<void> {
    if (!host.optionsToDisplay()?.length) host.populateOptionsToDisplay();
    const result = host.feedbackManager.applyOptionFeedback(
      selectedOption,
      host.optionsToDisplay(),
      host.showFeedbackForOption
    );
    if (!result) return;
    host.optionsToDisplay.set(result.optionsToDisplay);
    host.showFeedbackForOption = result.showFeedbackForOption;
    host.selectedOptionIndex = result.selectedOptionIndex;
    host.feedbackApplied.emit(selectedOption.optionId ?? -1);
    await delay(50);
    host.cdRef.markForCheck();
  }

  async runFinalizeSelection(
    host: Host,
    option: SelectedOption,
    index: number,
    wasPreviouslySelected: boolean
  ): Promise<void> {
    const result = await host.optionSelection.performFinalizeSelection({
      option,
      index,
      wasPreviouslySelected,
      currentQuestionIndex: host.currentQuestionIndex(),
      quizId: host.quizId()!,
      lastAllCorrect: host._lastAllCorrect,
      fetchAndProcessCurrentQuestion: () => host.fetchAndProcessCurrentQuestion(),
      selectOption: (q: QuizQuestion, opt: SelectedOption, idx: number) => host.selectOption(q, opt, idx),
      processCurrentQuestion: (q: QuizQuestion) =>
        host.explanationFlow.processCurrentQuestion({
          currentQuestion: q,
          currentQuestionIndex: host.currentQuestionIndex(),
          quizId: host.quizId()!,
          lastAllCorrect: host._lastAllCorrect,
          getExplanationText: (idx: number) => host.explanationManager.getExplanationText(idx)
        }),
      handleOptionSelection: (opt: SelectedOption, idx: number, q: QuizQuestion) =>
        host.handleOptionSelection(opt, idx, q)
    });
    if (!result) return;
    host.updateExplanationDisplay(result.shouldDisplay);
    const cq = host.currentQuestion();
    if (cq) host.questionAnswered.emit(cq);
    host.timerEffect.stopTimerIfAllCorrectSelected({
      currentQuestionIndex: host.currentQuestionIndex(),
      questions: host.questions(),
      optionsToDisplay: host.optionsToDisplay()
    });
  }

  async runFetchAndProcessCurrentQuestion(host: Host): Promise<QuizQuestion | null> {
    const result = await host.optionSelection.fetchAndProcessCurrentQuestion({
      currentQuestionIndex: host.currentQuestionIndex(),
      isAnyOptionSelectedFn: (idx: number) => host.isAnyOptionSelected(idx),
      shouldUpdateMessageOnAnswerFn: async (isAnswered: boolean) =>
        host.selectionMessage() !==
        host.selectionMessageService.determineSelectionMessage(
          host.currentQuestionIndex(),
          host.totalQuestions(),
          isAnswered
        ),
    });
    if (!result) return null;
    host.currentQuestion.set(result.currentQuestion);
    host.optionsToDisplay.set(result.optionsToDisplay);
    host.data.set(result.data);
    return result.currentQuestion;
  }

  async runSelectOption(
    host: Host,
    currentQuestion: QuizQuestion,
    option: SelectedOption,
    optionIndex: number
  ): Promise<void> {
    const result = await host.optionSelection.performSelectOption({
      currentQuestion,
      option,
      optionIndex,
      currentQuestionIndex: host.currentQuestionIndex(),
      isMultipleAnswer: host.isMultipleAnswer,
      optionsToDisplay: host.optionsToDisplay(),
      selectedOptionsCount: host.selectedOptions.length,
      getExplanationText: (idx: number) => host.explanationManager.getExplanationText(idx)
    });
    if (!result) return;
    host.showFeedbackForOption = result.showFeedbackForOption;
    host.selectedOption = result.selectedOption;
    host.isOptionSelected.set(result.isOptionSelected);
    host.isAnswered.set(result.isAnswered);
    host.isAnswerSelectedChange.emit(host.isAnswered());
    host.optionSelected.emit(result.selectedOption);
    host.events.emit({ type: 'optionSelected', payload: result.selectedOption });
    host.selectionChanged.emit({ question: currentQuestion, selectedOptions: host.selectedOptions });
  }

  runUnselectOption(host: Host): void {
    const result = host.optionSelection.unselectOption(host.currentQuestionIndex());
    host.selectedOptions = result.selectedOptions;
    host.optionChecked = result.optionChecked;
    host.showFeedbackForOption = result.showFeedbackForOption;
    host.showFeedback.set(result.showFeedback);
    host.selectedOption = result.selectedOption;
  }

  async runOnSubmit(host: Host): Promise<void> {
    if (!host.initializer.validateFormForSubmission(host.questionForm)) return;
    const selectedOption = host.questionForm.get('selectedOption')?.value;
    await host.initializer.processAnswer(
      { selectedOption,
        currentQuestion: host.currentQuestion()!,
        currentQuestionIndex: host.currentQuestionIndex(),
        answers: host.answers
      });
    const cq2 = host.currentQuestion();
    if (cq2) host.questionAnswered.emit(cq2);
  }

  runEmitPassiveNow(host: Host, index: number): void {
    host.optionSelection.emitPassiveNow({
      index,
      normalizeIndex: (idx: number) => host.normalizeIndex(idx),
      optionsToDisplay: host.optionsToDisplay(),
      currentQuestionType: host.currentQuestion()?.type
    });
  }
}