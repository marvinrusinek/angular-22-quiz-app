import { Service, WritableSignal } from '@angular/core';
import { Observable, of } from 'rxjs';
import { catchError, map, tap } from 'rxjs/operators';

import { QuestionType } from '../../models/question-type.enum';

import { Option } from '../../models/Option.model';
import { QuizQuestion } from '../../models/QuizQuestion.model';

import { isOptionCorrect } from '../../utils/is-option-correct';
import { norm } from '../../utils/text-norm';

@Service()
export class QuizOptionsService {
  sanitizeOptions(options: Option[]): Option[] {
    if (!Array.isArray(options)) return [];

    return options.map((opt, idx) => {
      const safeId =
        Number.isInteger(opt?.optionId) && (opt?.optionId as number) >= 0
          ? (opt.optionId as number) : idx + 1;

      const safeText = (opt?.text ?? '').trim() || `Option ${idx + 1}`;
      const normalizedHighlight =
        typeof opt?.highlight === 'boolean' ? opt.highlight : !!opt?.highlight;
      const normalizedActive =
        typeof opt?.active === 'boolean' ? opt.active : true;

      const sanitized: Option = {
        ...opt,
        optionId: safeId,
        text: safeText,
        // PRESERVE ABSENCE — `false` claims the option is wrong; absence says
        // nobody has said. Correctness belongs to the verdict.
        ...(opt?.correct === undefined ? {} : { correct: isOptionCorrect(opt) }),
        value: typeof opt?.value === 'number' ? opt.value : safeId,
        answer: opt?.answer ?? undefined,
        selected: opt?.selected === true,
        active: normalizedActive,
        highlight: normalizedHighlight,
        showIcon: opt?.showIcon === true,
        showFeedback:
          typeof opt?.showFeedback === 'boolean' ? opt.showFeedback : false,
        feedback: (opt?.feedback ?? 'No feedback available').trim(),
        styleClass: opt?.styleClass ?? ''
      };

      if (typeof opt?.displayOrder === 'number') {
        sanitized.displayOrder = opt.displayOrder;
      }

      return sanitized;
    });
  }

  cloneOptions(options: Option[] = []): Option[] {
    return options.map((option) => ({ ...option }));
  }

  getOptions(
    index: number,
    getQuestionByIndex: (idx: number) => Observable<QuizQuestion | null>,
    currentOptionsSig: WritableSignal<Option[]>
  ): Observable<Option[]> {
    return getQuestionByIndex(index).pipe(
      map((question) => {
        if (!question || !Array.isArray(question.options) || question.options.length === 0) {
          return [];
        }

        const deepClone = (obj: any) => JSON.parse(JSON.stringify(obj));
        const normalized = this.cloneOptions(this.sanitizeOptions(question.options));

        return normalized.map(opt => deepClone(opt));
      }),
      tap(options => { currentOptionsSig.set(options); }),
      catchError(() => {
        return of([]);
      })
    );
  }

  getCurrentOptions(
    questionIndex: number,
    getQuestionByIndex: (idx: number) => Observable<QuizQuestion | null>
  ): Observable<Option[]> {
    if (!Number.isInteger(questionIndex) || questionIndex < 0) return of([]);

    return getQuestionByIndex(questionIndex).pipe(
      map((question) => {
        if (!question || !Array.isArray(question.options) || question.options.length === 0) {
          return [];
        }

        const deepClone =
          typeof structuredClone === 'function'
            ? structuredClone : (obj: any) => JSON.parse(JSON.stringify(obj));

        const sanitized = question.options.map((opt, index) => ({
          ...deepClone(opt),
          optionId: typeof opt.optionId === 'number' ? opt.optionId : index,
          correct: opt.correct ?? false,
          feedback:
            opt.feedback ??
            `Generated feedback for Q${questionIndex} Option ${index}`
        }));
        return sanitized;
      }),
      catchError(() => {
        return of([]);
      })
    );
  }

  getSafeOptionId(option: any, index: number): number | undefined {
    if (option && typeof option.optionId === 'number') return option.optionId;
    
    return index;
  }

  assignOptionIds(options: Option[], questionIndex: number): Option[] {
    if (!Array.isArray(options)) return [];

    return options.map((option, localIdx) => {
      const existingId = Number(option.optionId);
      if (option.optionId !== undefined && !isNaN(existingId)) {
        return {
          ...option,
          optionId: existingId,
          selected: false,
          highlight: false,
          showIcon: false
        };
      }

      const uniqueId = Number(
        `${questionIndex + 1}${(localIdx + 1).toString().padStart(2, '0')}`
      );
      return {
        ...option,
        optionId: uniqueId,
        selected: false,
        highlight: false,
        showIcon: false
      };
    });
  }

  normalizeOptionDisplayOrder(options: Option[] = []): Option[] {
    if (!Array.isArray(options)) return [];

    return options.map((option, index) => ({
      ...option,
      displayOrder: index
    }));
  }

  assignOptionActiveStates(
    options: Option[],
    correctOptionSelected: boolean
  ): Option[] {
    if (!Array.isArray(options) || options.length === 0) return [];

    return options.map((opt) => ({
      ...opt,
      active: correctOptionSelected ? opt.correct : true,
      feedback: correctOptionSelected && !opt.correct ? 'x' : undefined,
      showIcon: correctOptionSelected
        ? opt.correct || opt.showIcon 
        : opt.showIcon
    }));
  }

  mergeOptionsWithCanonical(
    question: QuizQuestion,
    incoming: Option[] = []
  ): Option[] {
    const canonical = Array.isArray(question?.options) ? question.options : [];

    const toNumericId = (value: unknown, fallback: number): number => {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };

    if (!canonical.length) {
      return this.normalizeOptionDisplayOrder(incoming ?? []).map(
        (option, index) => ({
          ...option,
          optionId: toNumericId(option.optionId, index + 1),
          displayOrder: index,
          correct: (option.correct as any) === true || (option.correct as any) === 'true',
          selected: option.selected === true,
          highlight: option.highlight ?? false,
          showIcon: option.showIcon ?? false
        })
      );
    }

    const textKey = (value: string | null | undefined) =>
      norm(value);

    const incomingList = Array.isArray(incoming) ? incoming : [];
    const incomingById = new Map<number, Option>();

    for (const option of incomingList) {
      const id = toNumericId(option?.optionId, NaN);
      if (Number.isFinite(id)) incomingById.set(id, option);
    }

    return canonical.map((option, index) => {
      const id = toNumericId(option?.optionId, index + 1);
      const match =
        incomingById.get(id) ||
        incomingList.find(
          (candidate) => textKey(candidate?.text) === textKey(option?.text)
        );

      const merged: Option = {
        ...option,
        optionId: id,
        displayOrder: index,
        // PRESERVE ABSENCE — see sanitizeOptions above. The canonical option is
        // merged for identity and display state, not to invent correctness.
        ...(option.correct === undefined && (match as any)?.correct === undefined
          ? {} : { correct: isOptionCorrect(option) }),
        selected: match?.selected === true || option.selected === true,
        highlight: match?.highlight ?? option.highlight ?? false,
        showIcon: match?.showIcon ?? option.showIcon ?? false
      };

      if (match && 'active' in match) {
        (merged as any).active = (match as any).active;
      }

      return merged;
    });
  }

  buildCorrectAnswerCountLabel(
    question: QuizQuestion,
    options: Option[]
  ): string {
    if (!question) return '';

    const isMultipleAnswer =
      question.type === QuestionType.MultipleAnswer ||
      options.filter((option) => option.correct).length > 1;
    if (!isMultipleAnswer) return '';

    const correctCount = options.filter((option) => option.correct).length;
    if (!correctCount) return '';

    return correctCount === 1
      ? '1 correct answer'
      : `${correctCount} correct answers`;
  }

  getCorrectOptionsForCurrentQuestion(question: QuizQuestion): Option[] {
    if (!question) return [];
    if (!Array.isArray(question.options)) return [];

    return question.options.filter((option) => option.correct);
  }

  getCorrectAnswers(question: QuizQuestion): number[] {
    if (!question || !Array.isArray(question.options) || question.options.length === 0) {
      return [];
    }

    const correctAnswers = question.options
      .filter((option) => option.correct && option.optionId !== undefined)
      .map((option) => option.optionId as number);

    if (correctAnswers.length === 0) {
      console.warn(
        '[QuizOptions] No correct answers found for question',
        question?.questionText
      );
    }

    return correctAnswers;
  }

  getTotalCorrectAnswers(currentQuestion: QuizQuestion): number {
    if (currentQuestion && currentQuestion.options) {
      return currentQuestion.options.filter((option) => option.correct).length;
    }
    return 0;
  }

  calculateCorrectAnswers(questions: QuizQuestion[]): Map<string, number[]> {
    const correctAnswers = new Map<string, number[]>();

    for (const question of questions) {
      if (question?.options) {
        const correctOptionNumbers = question.options.flatMap((opt, idx) =>
          opt.correct ? [idx + 1] : []
        );

        correctAnswers.set(question.questionText, correctOptionNumbers);
      }
    }

    return correctAnswers;
  }

  async determineCorrectAnswer(
    question: QuizQuestion,
    answers: Option[]
  ): Promise<boolean[]> {
    return (answers ?? []).map((answer) => {
      if (!answer) return false;

      const found = question.options.find(
        (option) =>
          option === answer ||
          (option.optionId !== undefined && answer.optionId !== undefined && String(option.optionId) === String(answer.optionId)) ||
          (option.text && answer.text && norm(option.text) === norm(answer.text))
      );
      return isOptionCorrect(found);
    });
  }
}
