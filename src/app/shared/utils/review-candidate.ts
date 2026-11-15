import {
  Quiz,
  ReviewRecommendation,
  TopicPerformanceRecord
} from '@shared/models';

/**
 * Which COMPLETED quiz most deserves a review, judged by the score of its
 * LATEST valid topic-quiz attempt. Pure: no storage, no signals.
 *
 * Rules (no score is ever invented or borrowed):
 *  - Only quizzes in the current catalog that are completed are considered.
 *  - Only records with source 'topic-quiz' count. Weak Areas Practice records
 *    are a mixed 10-question sample, not an attempt at the quiz.
 *  - A record is valid when its quiz id matches, `total > 0`,
 *    `0 <= correct <= total` (finite numbers) and `completedAt` parses.
 *  - The latest valid record per quiz wins (a retake replaces an earlier
 *    attempt, even a better one). Best scores are never used.
 *  - A completed quiz with no valid record is skipped; if none has one,
 *    the result is null.
 *  - Lowest correct / total wins. Ties go to the attempt made longest ago,
 *    then the title, then the quiz id, so the result is deterministic.
 */
interface Candidate {
  quiz: Quiz;
  ratio: number;
  at: number;
  correct: number;
  total: number;
}

function validRecordTime(
  record: Readonly<TopicPerformanceRecord>
): number | null {
  if (record.source !== 'topic-quiz') return null;
  const { correct, total } = record;
  if (!Number.isFinite(correct) || !Number.isFinite(total)) return null;
  if (!(total > 0) || correct < 0 || correct > total) return null;
  const at = Date.parse(record.completedAt);
  return Number.isNaN(at) ? null : at;
}

export function selectReviewCandidate(
  quizzes: readonly Quiz[] | null | undefined,
  completedIds: ReadonlySet<string>,
  records: readonly Readonly<TopicPerformanceRecord>[] | null | undefined
): ReviewRecommendation | null {
  const byId = new Map<string, Quiz>();
  for (const quiz of quizzes ?? []) {
    if (quiz?.quizId && completedIds.has(quiz.quizId)) {
      byId.set(quiz.quizId, quiz);
    }
  }
  if (byId.size === 0) return null;

  // Latest valid record per quiz. On identical timestamps the later record in
  // the (oldest to newest) history wins.
  const latest = new Map<string, Candidate>();
  for (const record of records ?? []) {
    const quiz = byId.get(record?.topicId);
    if (!quiz) continue;
    const at = validRecordTime(record);
    if (at === null) continue;
    const current = latest.get(quiz.quizId);
    if (current && current.at > at) continue;
    latest.set(quiz.quizId, {
      quiz,
      ratio: record.correct / record.total,
      at,
      correct: record.correct,
      total: record.total
    });
  }

  const ranked = [...latest.values()].sort(
    (a, b) =>
      a.ratio - b.ratio ||
      a.at - b.at ||
      titleOf(a.quiz).localeCompare(titleOf(b.quiz)) ||
      a.quiz.quizId.localeCompare(b.quiz.quizId)
  );
  const pick = ranked[0];
  if (!pick) return null;

  return {
    quizId: pick.quiz.quizId,
    title: titleOf(pick.quiz),
    difficulty: pick.quiz.difficulty ?? '',
    latestPercent: Math.round(pick.ratio * 100),
    completedAt: new Date(pick.at).toISOString()
  };
}

function titleOf(quiz: Quiz): string {
  return quiz.milestone || quiz.quizId;
}
