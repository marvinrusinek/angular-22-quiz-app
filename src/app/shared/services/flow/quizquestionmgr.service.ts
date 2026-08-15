import { Service } from '@angular/core';
import { Observable, of } from 'rxjs';

import { Option } from '../../models/Option.model';
import { QuizQuestion } from '../../models/QuizQuestion.model';

import { resolveIsMultiAnswer } from '../../utils/question-type-authority';

@Service()
export class QuizQuestionManagerService {
  // ── public methods ──────────────────────────────────────────────
  getNumberOfCorrectAnswersText(
    numberOfCorrectAnswers: number | undefined,
    totalOptions: number | undefined,
  ): string {
    if ((numberOfCorrectAnswers ?? 0) === 0) return 'No correct answers';

    if (!totalOptions || totalOptions <= 0) {
      return numberOfCorrectAnswers === 1
        ? '(1 answer is correct)'
        : `(${numberOfCorrectAnswers} answers are correct)`;
    }

    const pluralSuffix =
      numberOfCorrectAnswers === 1 ? 'answer is' : 'answers are';
    return `(${numberOfCorrectAnswers} ${pluralSuffix} correct)`;
  }

  calculateNumberOfCorrectAnswers(options: Option[]): number {
    const validOptions = options ?? [];
    return validOptions.reduce(
      (count, option) => count + (option.correct ? 1 : 0), 0
    );
  }

  /**
   * INTERACTION MODE — is this question answered with one pick or several?
   *
   * Declared type first. This drives which component the dynamic loader
   * instantiates, so a wrong answer renders checkboxes for a single-answer
   * question (or radios for a multi-answer one) for that question's whole life.
   *
   * Deliberately SEPARATE from `isMultipleAnswerQuestion` below. That one is
   * still counted, because its only consumer gates the literal
   * "N answers are correct" banner — a correct-COUNT disclosure rather than a
   * type question, and one this stage has not yet reached. Sharing a single
   * resolver meant a type migration would silently re-gate the banner.
   *
   * Stays Observable so the cold-load caller's `firstValueFrom` timing is
   * unchanged; the underlying resolution is synchronous.
   */
  public isMultipleAnswerInteraction(question: QuizQuestion): Observable<boolean> {
    return of(this.isMultipleAnswerInteractionSync(question));
  }

  public isMultipleAnswerInteractionSync(question: QuizQuestion): boolean {
    // REMOVE THE COUNT IN /questions CONTENT CUTOVER — a declared type wins,
    // and the legacy count survives only for questions that carry none.
    return resolveIsMultiAnswer(
      question,
      this.isMultipleAnswerFromLegacyCount(question)
    );
  }

  /**
   * LEGACY COUNT — answer-key cardinality, no declared type consulted.
   *
   * BLOCKED BOUNDARY: the sole consumer is cqc-orchestrator's correct-count
   * banner gate. Migrating this to declared-first would change when the
   * "(N answers are correct)" text appears, which belongs to the banner slice
   * alongside the Class B survivors — not to a type-authority slice. Do not
   * point interaction-mode callers back at this.
   */
  public isMultipleAnswerQuestion(question: QuizQuestion): Observable<boolean> {
    return of(this.isMultipleAnswerFromLegacyCount(question));
  }

  isValidQuestionData(questionData: QuizQuestion): boolean {
    return !!questionData && !!questionData.explanation;
  }

  // ── private methods ─────────────────────────────────────────────
  private isMultipleAnswerFromLegacyCount(question: QuizQuestion): boolean {
    try {
      if (question && Array.isArray(question.options)) {
        const correctAnswersCount = question.options.filter(
          (option) => option.correct,
        ).length;
        return correctAnswersCount > 1;
      }
      return false;
    } catch {
      return false;
    }
  }
}