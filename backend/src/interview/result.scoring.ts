import type { SessionQuestionSnapshot } from './session.types';

/**
 * Interview scoring — backend port of Angular's `computeInterviewResult`
 * (src/app/shared/utils/interview-scoring.ts).
 *
 * PURE: it takes the FROZEN session snapshot plus the persisted answers and
 * returns a complete result. It never reads the quiz bank, so a historical
 * result can never drift when quiz.json changes.
 *
 * PORTED EXACTLY:
 *   - correctness is EXACT SET EQUALITY (isAnswerCorrect); an empty selection
 *     is incorrect, a missing correct option is incorrect, and one extra
 *     incorrect option is incorrect. No partial credit anywhere.
 *   - `incorrect = answered - correct`, NOT `total - correct`
 *   - `percentage = round(correct / total * 100)`, over TOTAL not answered
 *   - per-topic buckets are grouped by the question's `sourceQuizId`, with
 *     `percentage = round(correct / total * 100)` per bucket
 *
 * DELIBERATE DIFFERENCES:
 *   1. Angular resolves a topic TITLE via `getQuizData()` at scoring time — the
 *      mutable bank. Here the title is resolved once at finalization and frozen
 *      into result_json, so a renamed topic cannot retroactively relabel a
 *      completed attempt.
 *   2. `focusChanges` is not scored here. It comes from Assessment Integrity
 *      Mode, which observes the BROWSER (focus loss) and has no server-side
 *      equivalent. It is informational only and never affected the score.
 *   3. There is no by-difficulty breakdown, because the current result model
 *      has none — only `perTopic`.
 */

export interface ScoredTopicBucket {
  readonly topicId: string;
  readonly title: string;
  readonly correct: number;
  readonly incorrect: number;
  readonly unanswered: number;
  readonly total: number;
  readonly percentage: number;
}

export interface ScoredReviewQuestion {
  readonly questionId: string;
  readonly sourceQuizId: string;
  readonly questionText: string;
  readonly type: SessionQuestionSnapshot['type'];
  readonly options: readonly { readonly optionId: number; readonly text: string }[];
  readonly selectedOptionIds: readonly number[];
  readonly correctOptionIds: readonly number[];
  readonly explanation: string;
  /** The user's own Mark-for-Review note. Never affects scoring. */
  readonly flagged: boolean;
}

export interface ScoredInterview {
  readonly total: number;
  readonly answered: number;
  readonly unanswered: number;
  readonly correct: number;
  readonly incorrect: number;
  readonly percentage: number;
  readonly byTopic: readonly ScoredTopicBucket[];
  readonly review: readonly ScoredReviewQuestion[];
}

function setsEqual(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/**
 * EXACT SET EQUALITY, matching `isAnswerCorrect`. Applies uniformly to single,
 * trueFalse and multiple — there is no per-type branch, because a single-answer
 * question simply has a one-element correct set.
 */
export function isSelectionCorrect(
  correctOptionIds: readonly number[],
  selectedOptionIds: readonly number[]
): boolean {
  const selected = new Set(selectedOptionIds);
  if (selected.size === 0) return false;   // unanswered is never correct
  return setsEqual(selected, new Set(correctOptionIds));
}

export function scoreInterview(params: {
  questions: readonly SessionQuestionSnapshot[];
  /** questionPosition → persisted selection. Missing/empty means unanswered. */
  answersByPosition: ReadonlyMap<number, readonly number[]>;
  /** Resolved ONCE at finalization and frozen into the result. */
  topicTitleFor: (topicId: string) => string;
}): ScoredInterview {
  const { questions, answersByPosition, topicTitleFor } = params;

  const ordered = [...questions].sort((a, b) => a.position - b.position);

  let correct = 0;
  let answered = 0;

  const buckets = new Map<string, { correct: number; incorrect: number; unanswered: number; total: number }>();
  const review: ScoredReviewQuestion[] = [];

  for (const question of ordered) {
    const options = [...question.options].sort((a, b) => a.displayOrder - b.displayOrder);
    const correctOptionIds = options.filter((o) => o.isCorrect).map((o) => o.optionId);
    const selectedOptionIds = [...(answersByPosition.get(question.position) ?? [])];

    const isAnswered = selectedOptionIds.length > 0;
    const isCorrect = isSelectionCorrect(correctOptionIds, selectedOptionIds);

    if (isAnswered) answered++;
    if (isCorrect) correct++;

    const bucket = buckets.get(question.sourceQuizId)
      ?? { correct: 0, incorrect: 0, unanswered: 0, total: 0 };
    bucket.total++;
    if (!isAnswered) bucket.unanswered++;
    else if (isCorrect) bucket.correct++;
    else bucket.incorrect++;
    buckets.set(question.sourceQuizId, bucket);

    review.push({
      questionId: question.questionId,
      sourceQuizId: question.sourceQuizId,
      questionText: question.questionText,
      type: question.type,
      // Frozen display order preserved for both review and options.
      options: options.map((option) => ({ optionId: option.optionId, text: option.text })),
      selectedOptionIds,
      correctOptionIds,
      explanation: question.explanation,
      flagged: question.flagged
    });
  }

  const total = ordered.length;

  const byTopic: ScoredTopicBucket[] = [...buckets.entries()].map(([topicId, bucket]) => ({
    topicId,
    title: topicTitleFor(topicId),
    correct: bucket.correct,
    incorrect: bucket.incorrect,
    unanswered: bucket.unanswered,
    total: bucket.total,
    percentage: bucket.total > 0 ? Math.round((bucket.correct / bucket.total) * 100) : 0
  }));

  return {
    total,
    answered,
    unanswered: total - answered,
    correct,
    incorrect: answered - correct,
    percentage: total > 0 ? Math.round((correct / total) * 100) : 0,
    byTopic,
    review
  };
}

/**
 * Time used, matching the Angular timer exactly:
 *   remaining = max(0, ceil((expiresAt - now) / 1000))
 *   timeUsed  = max(0, durationSeconds - remaining)
 *
 * `now` is clamped to `expiresAt` first, so a submission after the deadline
 * reports the FULL duration rather than more than the assessment allowed.
 */
export function computeTimeUsedSeconds(params: {
  now: number;
  expiresAt: number;
  durationSeconds: number;
}): { timeUsedSeconds: number; timeRemainingSeconds: number } {
  const effectiveNow = Math.min(params.now, params.expiresAt);
  const timeRemainingSeconds = Math.max(0, Math.ceil((params.expiresAt - effectiveNow) / 1000));
  const timeUsedSeconds = Math.max(
    0,
    Math.min(params.durationSeconds, params.durationSeconds - timeRemainingSeconds)
  );
  return { timeUsedSeconds, timeRemainingSeconds };
}
