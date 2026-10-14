/**
 * Pure, testable helpers for Interview Review — per-option display state,
 * summary counts and label joining.
 *
 * The backend now decides correctness: the review DTO carries
 * `selectedOptionIds` and `correctOptionIds`, and per-question status comes
 * from the server-derived `isCorrect`/`isAnswered`. The helpers that used to
 * read `option.correct` and re-score locally (getReviewQuestionStatus,
 * getReviewQuestionType, getCorrectAnswerLabels) were removed with that
 * migration — nothing in the Interview path evaluates answers client-side.
 */
import { ReviewStatus } from './interview-review-filters';

/** State of a single option within a reviewed question. */
export type InterviewReviewOptionState =
  | 'correct-selected' // the user picked it, and it is correct
  | 'incorrect-selected' // the user picked it, but it is wrong
  | 'correct-missed' // correct, but the user did NOT pick it
  | 'neutral'; // a distractor the user (correctly) left unpicked

/** Per-option state from its correctness + whether it was selected. */
export function getReviewOptionState(
  correct: boolean,
  selected: boolean
): InterviewReviewOptionState {
  if (correct && selected) return 'correct-selected';
  if (!correct && selected) return 'incorrect-selected';
  if (correct && !selected) return 'correct-missed';
  return 'neutral';
}

/** Short text label for an option state (empty for neutral distractors). */
export function getReviewOptionLabel(state: InterviewReviewOptionState): string {
  switch (state) {
    case 'correct-selected':
      return $localize`Your answer · Correct`;
    case 'incorrect-selected':
      return $localize`Your answer · Incorrect`;
    case 'correct-missed':
      return $localize`Correct answer`;
    default:
      return '';
  }
}

/** Grammatical list join: "A", "A and B", "A, B and C". */
export function joinWithAnd(labels: readonly string[]): string {
  const list = labels.filter((l) => l.length > 0);
  if (list.length === 0) return '';
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** Tally review statuses. Counts sum to `total`. */
export function countReviewStatuses(statuses: readonly ReviewStatus[]): {
  correct: number;
  incorrect: number;
  unanswered: number;
  total: number;
} {
  return {
    correct: statuses.filter((s) => s === 'correct').length,
    incorrect: statuses.filter((s) => s === 'incorrect').length,
    unanswered: statuses.filter((s) => s === 'unanswered').length,
    total: statuses.length
  };
}
