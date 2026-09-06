import type { CodeSnippet, QuestionType } from '../quiz/quiz.types';

/**
 * The FROZEN interview result.
 *
 * This exact object is serialized into `interview_sessions.result_json` at
 * finalization and returned verbatim thereafter. It is never recomputed, and
 * every later read parses and revalidates it rather than trusting storage.
 *
 * It is safe to serialize under SUBMITTED_REVIEW: `correctOptionIds` and
 * `explanation` are authorized post-submission, while per-option `isCorrect`
 * is deliberately absent — correctness is expressed as an id list only.
 */

export interface FrozenReviewOption {
  readonly optionId: number;
  readonly text: string;
}

export interface FrozenReviewQuestion {
  readonly questionId: string;
  readonly sourceQuizId: string;
  readonly questionText: string;
  readonly type: QuestionType;
  readonly options: readonly FrozenReviewOption[];
  readonly selectedOptionIds: readonly number[];
  readonly correctOptionIds: readonly number[];
  readonly explanation: string;
  /** The user's own Mark-for-Review note, frozen at submission. Never scored. */
  readonly flagged: boolean;
  /** Question CONTENT, frozen at submission. Absent on most questions. */
  readonly codeSnippet?: CodeSnippet;
}

export interface FrozenTopicBucket {
  readonly topicId: string;
  readonly title: string;
  readonly correct: number;
  readonly incorrect: number;
  readonly unanswered: number;
  readonly total: number;
  readonly percentage: number;
}

export interface FrozenResultConfig {
  readonly mode: 'preset' | 'custom';
  readonly presetId?: string;
  readonly difficulty?: string;
  readonly topicIds: readonly string[];
  readonly questionCount: number;
}

export interface FrozenInterviewResult {
  readonly sessionId: string;
  readonly status: 'submitted';
  /** Epoch ms in storage; the DTO converts to ISO. */
  readonly submittedAt: number;
  readonly submittedByExpiry: boolean;
  readonly total: number;
  readonly answered: number;
  readonly unanswered: number;
  readonly correct: number;
  readonly incorrect: number;
  readonly percentage: number;
  readonly durationSeconds: number;
  readonly timeUsedSeconds: number;
  readonly timeRemainingSeconds: number;
  readonly config: FrozenResultConfig;
  readonly performance: { readonly byTopic: readonly FrozenTopicBucket[] };
  readonly review: readonly FrozenReviewQuestion[];
}

export class FrozenResultError extends Error {
  public override readonly name = 'FrozenResultError';
}

/** Invariants asserted before writing, and again on every read. */
export function assertResultInvariants(result: FrozenInterviewResult): void {
  const fail = (message: string): never => {
    throw new FrozenResultError(message);
  };

  if (result.status !== 'submitted') fail('result status must be submitted');
  if (!Number.isInteger(result.total) || result.total < 0) fail('invalid total');

  if (result.correct + result.incorrect + result.unanswered !== result.total) {
    fail('correct + incorrect + unanswered must equal total');
  }
  if (result.answered !== result.correct + result.incorrect) {
    fail('answered must equal correct + incorrect');
  }
  if (result.answered + result.unanswered !== result.total) {
    fail('answered + unanswered must equal total');
  }
  if (result.percentage < 0 || result.percentage > 100) fail('percentage out of range');

  if (result.timeUsedSeconds < 0 || result.timeUsedSeconds > result.durationSeconds) {
    fail('timeUsedSeconds out of range');
  }
  if (result.review.length !== result.total) fail('review length must equal total');

  for (const bucket of result.performance.byTopic) {
    if (bucket.correct + bucket.incorrect + bucket.unanswered !== bucket.total) {
      fail(`topic bucket "${bucket.topicId}" totals do not add up`);
    }
  }

  const bucketTotal = result.performance.byTopic.reduce((sum, b) => sum + b.total, 0);
  if (bucketTotal !== result.total) fail('topic buckets must cover every question');
}

/**
 * Parse a stored result. Storage is not trusted merely because this process
 * wrote it — a malformed row fails loudly rather than being regenerated, which
 * would silently rescore a historical attempt.
 */
export function parseFrozenResult(raw: unknown, sessionId: string): FrozenInterviewResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new FrozenResultError(`Session ${sessionId} has an unreadable stored result`);
  }

  const candidate = raw as FrozenInterviewResult;
  if (
    typeof candidate.sessionId !== 'string' ||
    !Array.isArray(candidate.review) ||
    typeof candidate.performance !== 'object' ||
    candidate.performance === null ||
    !Array.isArray(candidate.performance.byTopic)
  ) {
    throw new FrozenResultError(`Session ${sessionId} has a malformed stored result`);
  }

  assertResultInvariants(candidate);
  return candidate;
}
