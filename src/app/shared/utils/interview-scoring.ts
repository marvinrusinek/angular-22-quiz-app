/**
 * Exact-set answer checking for LOCALLY-SCORED modes.
 *
 * Interview Mode no longer scores anything in the browser — the backend owns
 * correctness, and `computeInterviewResult` was removed with the legacy
 * pipeline in Stage 9F. What remains is the shared exact-set rule used by
 * Weak Areas Practice (via practice-scoring.ts), which is deliberately still a
 * client-side mode over the local quiz bank.
 *
 * The filename is kept only to avoid churning its importers.
 */
import { QuizQuestion } from '@shared/models/QuizQuestion.model';

function setsEqual(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}

// A question is correct only when the selected optionIds EXACTLY match the set
// of correct optionIds (a partial multi-answer is incorrect; unanswered is
// incorrect). Shared by scoring and the per-question Review.
export function isAnswerCorrect(question: QuizQuestion, selectedIds: number[]): boolean {
  const selected = new Set((selectedIds ?? []).filter((id) => id != null));
  if (selected.size === 0) return false;
  const correctIds = new Set(
    (question.options ?? [])
      .filter((o) => o.correct === true)
      .map((o) => o.optionId)
      .filter((id): id is number => id != null)
  );
  return setsEqual(selected, correctIds);
}
