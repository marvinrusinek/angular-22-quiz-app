import { inject, Service } from '@angular/core';

import { QuestionType } from '../../../../shared/models/question-type.enum';

import { SK_DOT_CONFIRMED, SK_MULTI_PERFECT } from '../../../../shared/constants/session-keys';
import { writeSessionString } from '../../../../shared/utils/session-storage';
import { swallow } from '../../../../shared/utils/error-logging';

import { Option } from '../../../../shared/models/Option.model';
import { OptionClickedPayload } from '../../../../shared/models/OptionClickedPayload.model';
import { QuizQuestion } from '../../../../shared/models/QuizQuestion.model';
import { SelectedOption } from '../../../../shared/models/SelectedOption.model';

import { AnswerOptionsService } from './answer-options.service';
import { QuizService } from '../../../../shared/services/data/quiz.service';
import { QuizStateService } from '../../../../shared/services/state/quizstate.service';
import { SelectedOptionService } from '../../../../shared/services/state/selectedoption.service';

@Service()
export class AnswerSelectionService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly answerOptionsService = inject(AnswerOptionsService);
  private readonly quizService = inject(QuizService);
  private readonly quizStateService = inject(QuizStateService);
  private readonly selectedOptionService = inject(SelectedOptionService);

  buildEnrichedSelectedOption(
    payload: OptionClickedPayload,
    activeQuestionIndex: number,
    optionsToDisplay: Option[]
  ): SelectedOption {
    const rawOption = payload.option;
    const wasChecked = payload.checked ?? true;

    const targetKey = this.answerOptionsService.getEffectiveOptionId(
      rawOption,
      payload.index
    );

    const canonical =
      optionsToDisplay?.find((option: Option, index: number) =>
        this.answerOptionsService.getEffectiveOptionId(option, index) === targetKey
      ) ?? rawOption;

    return {
      ...canonical,
      optionId: targetKey,
      text: canonical.text,
      correct: this.answerOptionsService.isCorrectOptionValue(canonical),
      questionIndex: activeQuestionIndex,
      displayIndex: payload.index,
      selected: wasChecked,
      highlight: wasChecked,
      showIcon: wasChecked
    } as any;
  }

  updateSelectedOptionsArray(
    selectedOptions: SelectedOption[],
    enrichedOption: SelectedOption,
    type: 'single' | 'multiple'
  ): SelectedOption[] {
    if (type === 'single') return [enrichedOption];

    const nextSelections = [...(selectedOptions ?? [])];

    const existingIndex = nextSelections.findIndex((option: any) => {
      const optionIndex = option.displayIndex ?? option.index;

      return (
        this.answerOptionsService.getEffectiveOptionId(option, optionIndex) ===
        enrichedOption.optionId
      );
    });

    if (enrichedOption.selected) {
      if (existingIndex === -1) {
        nextSelections.push(enrichedOption);
      } else {
        nextSelections[existingIndex] = enrichedOption;
      }

      return nextSelections;
    }

    if (existingIndex !== -1) nextSelections.splice(existingIndex, 1);

    return nextSelections;
  }

  syncSelectedOptionService(
    activeQuestionIndex: number,
    enrichedOption: SelectedOption,
    isMultiAnswer: boolean
  ): void {
    this.selectedOptionService.currentQuestionType = !isMultiAnswer
      ? QuestionType.SingleAnswer : QuestionType.MultipleAnswer;

    if (!isMultiAnswer) {
      this.selectedOptionService.setSelectedOptionsForQuestion(
        activeQuestionIndex,
        [enrichedOption]
      );

      return;
    }

    this.selectedOptionService.addOption(activeQuestionIndex, enrichedOption);
  }

  updateQuestionCompletionState(
    questionIndex: number | null,
    question: QuizQuestion
  ): boolean {
    if (questionIndex == null) return false;

    const allSelected =
      this.selectedOptionService.getSelectedOptionsForQuestion(questionIndex);

    return this.selectedOptionService.isQuestionComplete(question, allSelected);
  }

  updateScoringAndAnswerSelectedState(
    activeQuestionIndex: number,
    optionsSource: Option[],
    selectedOptions: SelectedOption[],
    isMultiAnswer: boolean,
    complete: boolean
  ): void {
    if (isMultiAnswer && selectedOptions?.length > 0) {
      const totalCorrectInQuestion =
        optionsSource.filter(option =>
          this.answerOptionsService.isCorrectOptionValue(option)
        ).length;

      const correctSelectedCount =
        selectedOptions.filter(option =>
          this.answerOptionsService.isCorrectOptionValue(option)
        ).length;

      if (
        correctSelectedCount === totalCorrectInQuestion &&
        totalCorrectInQuestion > 0
      ) {
        // NO SCORE HERE, for the same reason as completion below: the gate
        // counts correct options from the local answer key, so crediting from
        // it would let the bank decide the score. The point is applied by
        // QuizScoringService.creditResolvedQuestion when the authorized
        // verdict lands.
        //
        // NO COMPLETION HERE. The gate counts correct options via
        // `isCorrectOptionValue` — the local answer key — and this runs on the
        // click, before /check answers. Completion is established from the
        // authorized verdict in
        // SelectedOptionService.applyAuthorizedMultiCompletion.
        //
        // RESOLVED and the durable session mirror stay: the first needs no
        // correctness, and the second is what a revisit rehydrates from.
        this.quizService.markQuestionResolved(activeQuestionIndex);
        writeSessionString(SK_MULTI_PERFECT + activeQuestionIndex, 'true');
        this.quizStateService.setAnswerSelected(true);
        return;
      }

      this.quizStateService.setAnswerSelected(complete);
      return;
    }

    this.quizStateService.setAnswerSelected(complete);
  }

  updateDotStatus(
    activeQuestionIndex: number,
    enrichedOption: SelectedOption
  ): void {
    if (enrichedOption.selected !== true || activeQuestionIndex == null) return;

    const dotStatus = enrichedOption.correct ? 'correct' : 'wrong';

    this.selectedOptionService.clickConfirmedDotStatus.set(
      activeQuestionIndex,
      dotStatus
    );

    this.selectedOptionService.lastClickedCorrectByQuestion.set(
      activeQuestionIndex,
      !!enrichedOption.correct
    );

    try {
      sessionStorage.setItem(SK_DOT_CONFIRMED + activeQuestionIndex, dotStatus);
    } catch (err: unknown) { swallow('answer-selection.service.ts dot-confirmed persist', err); }
  }
}