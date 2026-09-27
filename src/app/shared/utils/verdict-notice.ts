import type { QuestionVerdictPhase } from '@shared/services/features/verdict/question-verdict.types';

export interface VerdictNotice {
  readonly message: string;
  /** True only when the failed check belongs to the question on screen. */
  readonly canRetry: boolean;
}

export const CURRENT_CHECK_FAILED_MESSAGE =
  "We couldn't verify your answer. Check your connection, then try again.";

export const EARLIER_CHECK_FAILED_MESSAGE =
  "An earlier answer couldn't be verified, so Results is unavailable. Go back to that question and retry.";

/**
 * What to tell the user about a failed (or timed-out) answer check.
 *
 * Pure so the decision is testable without a component. A failure on the
 * question on screen is retryable in place; a failure elsewhere in the quiz is
 * explained (it is why Results is hidden) but cannot be retried from here.
 * Null when nothing has failed.
 */
export function buildVerdictNotice(
  currentPhase: QuestionVerdictPhase | null | undefined,
  anyFailedInQuiz: boolean
): VerdictNotice | null {
  if (currentPhase === 'error') return { message: CURRENT_CHECK_FAILED_MESSAGE, canRetry: true };
  if (anyFailedInQuiz) return { message: EARLIER_CHECK_FAILED_MESSAGE, canRetry: false };
  return null;
}
