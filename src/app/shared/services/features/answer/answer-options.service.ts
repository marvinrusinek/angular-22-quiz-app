import { Service } from '@angular/core';

import { declaredIsMultiAnswer } from '../../../../shared/utils/question-type-authority';

import { Option } from '../../../../shared/models/Option.model';
import { QuizQuestion } from '../../../../shared/models/QuizQuestion.model';

import { isOptionCorrect } from '../../../../shared/utils/is-option-correct';

@Service()
export class AnswerOptionsService {
  getEffectiveOptionId(option: any, index: number): number {
    return option?.optionId != null && option.optionId !== -1
      ? option.optionId : index;
  }

  isCorrectOptionValue(option: any): boolean {
    return isOptionCorrect(option);
  }

  normalizeOptions(options: Option[]): Option[] {
    return (options ?? []).map((option, index) => ({
      ...option,
      optionId: option.optionId ?? index
    }));
  }

  resolveOptionsSource(
    optionsToDisplay: Option[],
    question: QuizQuestion
  ): Option[] {
    return optionsToDisplay?.length ? optionsToDisplay : question.options;
  }

  isMultipleAnswerQuestion(
    question: QuizQuestion,
    optionsSource: Option[],
    currentType: 'single' | 'multiple'
  ): boolean {
    // A DECLARED type decides on its own. This used to be one arm of an OR
    // alongside `correctCount > 1`, which let the local bank's flags promote a
    // declared single-answer question to multiple.
    const declared = declaredIsMultiAnswer(question);
    if (declared !== null) return declared;

    // REMOVE IN /questions CONTENT CUTOVER.
    const correctCount =
      optionsSource?.filter((option: any) =>
        isOptionCorrect(option)
      ).length ?? 0;

    return currentType === 'multiple' || correctCount > 1;
  }
}