import { inject, Service } from '@angular/core';

import { Option } from '../../models/Option.model';
import { QuizQuestion } from '../../models/QuizQuestion.model';

import { QuizOptionsService } from './quiz-options.service';

/**
 * Resolves a question's answer options and derives the shape of an answer
 * (how many correct options it has, whether it is multi-answer).
 *
 * The pristine SCORING verification this service used to carry is gone — see
 * the note where `verifyScoreAgainstPristine` stood. Nothing here decides
 * score any more.
 */
@Service()
export class QuizAnswerEvaluationService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly optionsService = inject(QuizOptionsService);

  // ── public methods ──────────────────────────────────────────────
  /**
   * Resolves user answer IDs to full Option objects from the question's options.
   * Returns the matched options array.
   */
  resolveAnswerOptions(
    answerIds: number[],
    question: QuizQuestion,
    questionIndex: number,
    shouldShuffle: boolean
  ): Option[] {
    if (!question || !Array.isArray(question.options)) {
      return answerIds.map(id => ({ optionId: id } as Option));
    }

    return answerIds
      .map((id) => {
        let match = question.options.find((o: Option) => o.optionId == id);

        if (!match) {
          const qPrefix = (questionIndex + 1).toString();
          const strId = id.toString();
          if (strId.length > qPrefix.length && strId.startsWith(qPrefix)) {
            const suffix = parseInt(strId.substring(qPrefix.length), 10);
            const optIdx = suffix - 1;
            if (question.options[optIdx]) match = question.options[optIdx];
          }
        }

        if (!match) {
          const answerId = id;
          match = question.options.find((o: Option) =>
            (o.text && String(o.optionId) === String(answerId)) ||
            (o.text && String(o.value) === String(answerId))
          );
        }

        if (!match && !shouldShuffle) {
          if (typeof id === 'number' && id >= 0 && question.options[id]) {
            match = question.options[id];
          }
        }

        return match;
      })
      .filter((o): o is Option => !!o);
  }

  /**
   * Evaluates whether the user answered correctly for a given question.
   * Returns { isCorrect, numberOfCorrectAnswers, multipleAnswer, resolvedAnswers }.
   */
  async evaluateCorrectness(
    _qIndex: number,
    currentQuestion: QuizQuestion,
    userAnswerIds: number[]
  ): Promise<{
    isCorrect: boolean;
    numberOfCorrectAnswers: number;
    multipleAnswer: boolean;
    resolvedAnswers: Option[];
    answerIds: number[];
  }> {
    const numberOfCorrectAnswers = currentQuestion.options.filter(
      (option) => !!option.correct && String(option.correct) !== 'false'
    ).length;
    const multipleAnswer = numberOfCorrectAnswers > 1;

    const resolvedAnswers = userAnswerIds
      .map((id) => {
        const found = currentQuestion.options.find((o: Option) =>
          String(o.optionId) === String(id)
        );
        if (found) return found;

        if (typeof id === 'number') {
          if (id >= 0 && id < currentQuestion.options.length) {
            return currentQuestion.options[id];
          }
          if (id > 100) {
            const optIdx = (id % 100) - 1;
            if (optIdx >= 0 && optIdx < currentQuestion.options.length) {
              return currentQuestion.options[optIdx];
            }
          }
        }
        return { optionId: id } as Option;
      })
      .filter((o): o is Option => !!o);

    if (!resolvedAnswers || resolvedAnswers.length === 0) {
      return { isCorrect: false, numberOfCorrectAnswers, multipleAnswer, resolvedAnswers, answerIds: [] };
    }

    const correctnessArray =
      await this.optionsService.determineCorrectAnswer(currentQuestion, resolvedAnswers);
    const allSelectedAreCorrect = correctnessArray.every((v) => v === true);
    const isCorrect =
      allSelectedAreCorrect && correctnessArray.length === numberOfCorrectAnswers;
    const answerIds =
      resolvedAnswers.map((a) => a.optionId).filter((id): id is number => id !== undefined);

    return { isCorrect, numberOfCorrectAnswers, multipleAnswer, resolvedAnswers, answerIds };
  }

  // `verifyScoreAgainstPristine()` is GONE.
  //
  // It cross-checked a caller-supplied `isCorrect` against the pristine bank
  // before allowing a score to land — an answer-key gate guarding an
  // answer-key claim. Its only caller was QuizService.scoreDirectly(), which
  // is also gone now that Topic Quiz credit comes solely from
  // QuizScoringService.creditResolvedQuestion on authorized verdict arrival.

}
