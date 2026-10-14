/**
 * A general, versioned store of RELIABLE raw topic performance.
 *
 * Why this exists separately from Interview History: eleven call sites read the
 * interview store (certificate qualification, Readiness, Topic Trends, the
 * Interview History UI, Interview Results' "latest attempt"). Writing topic-quiz
 * or practice attempts there would inflate certificate progress and skew
 * interview-only analytics. Interview History stays interview-only; this store
 * holds everything else that produces trustworthy raw counts.
 *
 * "Reliable" means RAW correct/answered counts. BestScoreService percentages are
 * deliberately NOT a source: a percentage cannot tell us how many questions were
 * answered, so it cannot satisfy the minimum-sample rule. Legacy users simply
 * begin accumulating history from their next completion — nothing is fabricated
 * from existing stored percentages.
 */

/** Where a topic-performance record came from. */
export type TopicPerformanceSource = 'topic-quiz' | 'weak-areas-practice';

/** Schema version. Bump only on a breaking shape change. */
export const TOPIC_PERFORMANCE_HISTORY_VERSION = 1 as const;

/** Retention cap — newest N records are kept (same policy shape as Interview History). */
export const TOPIC_PERFORMANCE_HISTORY_MAX = 200;

/**
 * One completed attempt's raw performance for ONE topic.
 *
 * `attemptId` is the dedup anchor: recording the same attempt twice (a Results
 * remount, a refresh, a revisit) is a durable no-op.
 */
export interface TopicPerformanceRecord {
  attemptId: string;
  source: TopicPerformanceSource;
  completedAt: string; // ISO 8601
  topicId: string; // stable quizId — never display text
  topicName: string;
  correct: number; // raw
  total: number; // raw answered/total
}

export interface TopicPerformanceHistoryState {
  version: typeof TOPIC_PERFORMANCE_HISTORY_VERSION;
  records: TopicPerformanceRecord[];
}

/**
 * Validate one untrusted persisted record. Returns a clean record or null —
 * never throws. Storage is user-modifiable and may hold legacy or partial data.
 */
export function validateTopicPerformanceRecord(raw: unknown): TopicPerformanceRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const attemptId = typeof r['attemptId'] === 'string' ? r['attemptId'] : '';
  const topicId = typeof r['topicId'] === 'string' ? r['topicId'] : '';
  const completedAt = typeof r['completedAt'] === 'string' ? r['completedAt'] : '';
  if (!attemptId || !topicId || !completedAt) return null;
  if (Number.isNaN(Date.parse(completedAt))) return null;

  const source = r['source'];
  if (source !== 'topic-quiz' && source !== 'weak-areas-practice') return null;

  const total = Number(r['total']);
  const correct = Number(r['correct']);
  if (!Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(correct) || correct < 0) return null;

  return {
    attemptId,
    source,
    completedAt,
    topicId,
    topicName: typeof r['topicName'] === 'string' && r['topicName'] ? r['topicName'] : topicId,
    // Clamp rather than reject: a stored correct > total is nonsense but the
    // rest of the record is still usable signal.
    correct: Math.min(correct, total),
    total
  };
}
