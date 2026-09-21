import { AggregatedTopic, aggregateTopicPercentages } from './interview-topic-history';
import { InterviewAttemptHistoryEntry } from '../models/interview-history.model';

/**
 * Weak Areas Practice — the SINGLE definition of "which topics is the user
 * weakest in".
 *
 * Accuracy is NOT recalculated here: it comes from aggregateTopicPercentages(),
 * the same neutral helper Interview Readiness and Topic Trends already use, so
 * this feature can never disagree with Performance Trends about a topic's score.
 * That helper sums RAW correct/total across attempts rather than averaging
 * pre-rounded percentages, so one tiny sample can't make a topic look strong.
 *
 * DATA NOTE: topic-level correct/total comes from two stores of RAW counts —
 * Interview History and topicPerformanceHistory:v1, which holds topic-quiz and
 * Weak Areas Practice records (WeakAreasService merges both into one attempt
 * list). BestScoreService is deliberately NOT a source: it keeps only a per-quiz
 * best PERCENTAGE, which cannot say how many questions were answered and so
 * cannot satisfy the "at least N answered" rule.
 */

/** Accuracy at or above this is NOT weak. Exactly 80 is excluded. */
export const WEAK_AREA_THRESHOLD = 80;

/** A topic needs at least this many ANSWERED questions before it is classified. */
export const WEAK_AREA_MIN_ANSWERED = 3;

/** At most this many weak topics are ever returned. */
export const WEAK_AREA_MAX_TOPICS = 3;

export interface WeakTopic extends AggregatedTopic {
  /** total - correct, across all counted attempts. */
  incorrect: number;
  /** ISO timestamp of the most recent attempt that included this topic. */
  lastActivityAt: string;
}

/**
 * The attempt shape this calculation needs. Interview attempts satisfy it, and
 * so do practice attempts — both are aggregated through the same helper so a
 * single accuracy definition covers both sources.
 */
export type TopicAttemptLike = Pick<
  InterviewAttemptHistoryEntry,
  'completedAt' | 'topicPerformance'
>;

/**
 * Rank eligible topics weakest-first.
 *
 * Eligibility (a topic must be ATTEMPTED to be judged):
 *   - it appears in at least one attempt's topicPerformance, and
 *   - its summed `total` is >= WEAK_AREA_MIN_ANSWERED, and
 *   - its accuracy is strictly below WEAK_AREA_THRESHOLD.
 * An unattempted topic is absent from the data entirely, so it can never be
 * classified as weak.
 *
 * Ordering, applied in order:
 *   1. lowest accuracy
 *   2. highest incorrect count  (a 50% topic with 20 wrong outranks one with 2)
 *   3. most recent activity     (break remaining ties toward what they just did)
 *   4. topicId                  (final, so the result is fully deterministic)
 */
export function calculateWeakTopics(
  attempts: readonly TopicAttemptLike[],
  options: {
    threshold?: number;
    minAnswered?: number;
    max?: number;
  } = {}
): WeakTopic[] {
  const threshold = options.threshold ?? WEAK_AREA_THRESHOLD;
  const minAnswered = options.minAnswered ?? WEAK_AREA_MIN_ANSWERED;
  const max = options.max ?? WEAK_AREA_MAX_TOPICS;

  const safe = Array.isArray(attempts) ? attempts.filter(isUsableAttempt) : [];
  if (safe.length === 0) return [];

  // Reuse the shared aggregation rather than re-deriving accuracy.
  const aggregated = aggregateTopicPercentages(safe as InterviewAttemptHistoryEntry[]);

  // Most recent activity per topic, for tie-break 3.
  const lastSeen = new Map<string, string>();
  for (const attempt of safe) {
    for (const topic of attempt.topicPerformance) {
      if (!(topic.total > 0)) continue;
      const current = lastSeen.get(topic.topicId);
      if (!current || attempt.completedAt > current) {
        lastSeen.set(topic.topicId, attempt.completedAt);
      }
    }
  }

  return aggregated
    .filter((t) => t.total >= minAnswered && t.percentage < threshold)
    .map<WeakTopic>((t) => ({
      ...t,
      incorrect: Math.max(0, t.total - t.correct),
      lastActivityAt: lastSeen.get(t.topicId) ?? ''
    }))
    .sort(
      (a, b) =>
        a.percentage - b.percentage ||
        b.incorrect - a.incorrect ||
        b.lastActivityAt.localeCompare(a.lastActivityAt) ||
        a.topicId.localeCompare(b.topicId)
    )
    .slice(0, max);
}

/**
 * Defensive shape check. Storage is user-modifiable and may hold legacy or
 * malformed records, so a bad entry is skipped rather than throwing or
 * poisoning the aggregate.
 */
function isUsableAttempt(attempt: unknown): attempt is TopicAttemptLike {
  if (!attempt || typeof attempt !== 'object') return false;
  const a = attempt as Partial<TopicAttemptLike>;
  if (typeof a.completedAt !== 'string') return false;
  if (!Array.isArray(a.topicPerformance)) return false;
  return a.topicPerformance.every(
    (t) =>
      !!t &&
      typeof t.topicId === 'string' &&
      t.topicId.length > 0 &&
      Number.isFinite(t.correct) &&
      Number.isFinite(t.total)
  );
}
