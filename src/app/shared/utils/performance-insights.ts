import {
  AttemptTally,
  InsightSource,
  PerformanceComparison,
  PerformanceInsights,
  PerformanceWindow,
  SourceSummary,
  TopicPerformanceInsight
} from '@shared/models/performance-insights.model';
import { INTERVIEW_HISTORY_MAX, InterviewAttemptHistoryEntry } from '@shared/models/interview-history.model';
import {
  TOPIC_PERFORMANCE_HISTORY_MAX,
  TopicPerformanceRecord
} from '@shared/models/topic-performance-history.model';
import {
  calculateWeakTopics,
  TopicAttemptLike,
  WEAK_AREA_MAX_TOPICS,
  WEAK_AREA_MIN_ANSWERED,
  WeakTopic
} from './weak-areas';

/**
 * Performance Insights — PURE, deterministic derivation. No Angular, no storage,
 * no clock, no randomness: the same input always yields the same output.
 *
 * WHAT IT IS NOT
 *   - There is NO combined accuracy across sources. Topic Quiz, Interview and
 *     Practice measure different things (see performance-insights.model.ts), and
 *     averaging them would produce a number that means nothing.
 *   - There is no skill score, no label ("improving", "good"), no prediction.
 *     Comparisons are arithmetic on percentages the user can see and check.
 *
 * WHERE THE NUMBERS COME FROM
 *   - Accuracy is always sum(correct) / sum(total) — question-weighted, never an
 *     average of per-attempt percentages.
 *   - Topic figures reuse the Weak Areas path (calculateWeakTopics →
 *     aggregateTopicPercentages). There is no second aggregation to drift.
 */

/** Recent/previous windows never exceed this many attempts each. Matches Interview Readiness. */
export const COMPARISON_MAX_WINDOW = 5;

/** Each window needs at least this many attempts, or a 1-attempt "trend" is just noise. */
export const COMPARISON_MIN_WINDOW = 2;

/** How many topics "Strongest" lists. */
export const STRONGEST_MAX_TOPICS = WEAK_AREA_MAX_TOPICS;

/** A record's fields that grouping needs. Structural, so any store shape fits. */
export type TopicRecordLike = Pick<
  TopicPerformanceRecord,
  'attemptId' | 'source' | 'completedAt' | 'correct' | 'total'
>;

export type InterviewAttemptLike = Pick<
  InterviewAttemptHistoryEntry,
  'id' | 'completedAt' | 'score' | 'totalQuestions'
>;

export interface PerformanceInsightsInput {
  /** Raw topic-performance records, INCLUDING `source`. */
  readonly topicRecords: readonly TopicRecordLike[];
  /** Interview history — one entry is one attempt. */
  readonly interviewAttempts: readonly InterviewAttemptLike[];
  /** The exact merged dataset Weak Areas judges (interview + topic records). */
  readonly attempts: readonly TopicAttemptLike[];
  /** WeakAreasService's answer, passed through untouched. */
  readonly needsReview: readonly WeakTopic[];
}

// ── accuracy ────────────────────────────────────────────────────────

/**
 * Whole-percent accuracy, clamped to 0–100. A zero or invalid denominator yields
 * 0 rather than NaN/Infinity; callers never build a window from such data, so the
 * 0 is a safety net and is never shown as a real result.
 */
export function accuracyPercent(correct: number, total: number): number {
  if (!Number.isFinite(correct) || !Number.isFinite(total) || total <= 0) return 0;
  const pct = Math.round((Math.min(Math.max(correct, 0), total) / total) * 100);
  return Math.min(100, Math.max(0, pct));
}

// ── logical attempts ────────────────────────────────────────────────

const timeOf = (iso: string): number => Date.parse(iso);

function byTimeThenId(a: AttemptTally, b: AttemptTally): number {
  return timeOf(a.completedAt) - timeOf(b.completedAt) || a.id.localeCompare(b.id);
}

/** Drop tallies with no usable sample or date; clamp `correct` into [0, total]. */
function usableTallies(tallies: readonly AttemptTally[]): AttemptTally[] {
  const out: AttemptTally[] = [];
  for (const t of Array.isArray(tallies) ? tallies : []) {
    if (!t || typeof t.id !== 'string' || t.id.length === 0) continue;
    if (typeof t.completedAt !== 'string' || Number.isNaN(timeOf(t.completedAt))) continue;
    if (!Number.isFinite(t.correct) || !Number.isFinite(t.total) || t.total <= 0) continue;
    out.push({
      id: t.id,
      completedAt: t.completedAt,
      correct: Math.min(Math.max(t.correct, 0), t.total),
      total: t.total
    });
  }
  return out.sort(byTimeThenId);
}

/**
 * Rebuild LOGICAL attempts from topic-history rows.
 *
 * The store keeps one row per topic per attempt, so a five-topic practice run is
 * five rows. Grouping by `attemptId` and summing turns them back into ONE attempt
 * — otherwise a window of "5 attempts" would really be one sitting.
 *
 * Retention caps ROWS, so the oldest attempt can survive only partially; its
 * surviving rows are still summed as one (smaller) attempt.
 */
export function groupIntoLogicalAttempts(
  records: readonly TopicRecordLike[],
  source: TopicRecordLike['source']
): AttemptTally[] {
  const byAttempt = new Map<string, { completedAt: string; correct: number; total: number }>();

  for (const r of Array.isArray(records) ? records : []) {
    if (!r || r.source !== source || typeof r.attemptId !== 'string' || r.attemptId.length === 0) continue;
    if (typeof r.completedAt !== 'string' || Number.isNaN(timeOf(r.completedAt))) continue;
    if (!Number.isFinite(r.correct) || !Number.isFinite(r.total) || r.total <= 0) continue;

    const current = byAttempt.get(r.attemptId) ?? { completedAt: r.completedAt, correct: 0, total: 0 };
    current.correct += Math.min(Math.max(r.correct, 0), r.total);
    current.total += r.total;
    if (timeOf(r.completedAt) > timeOf(current.completedAt)) current.completedAt = r.completedAt;
    byAttempt.set(r.attemptId, current);
  }

  return usableTallies(
    [...byAttempt.entries()].map(([id, v]) => ({ id, completedAt: v.completedAt, correct: v.correct, total: v.total }))
  );
}

/** Interview history entries are already one-per-attempt; use the attempt-level counts. */
export function tallyInterviewAttempts(attempts: readonly InterviewAttemptLike[]): AttemptTally[] {
  return usableTallies(
    (Array.isArray(attempts) ? attempts : []).map((a) => ({
      id: a?.id,
      completedAt: a?.completedAt,
      correct: a?.score,
      total: a?.totalQuestions
    }))
  );
}

// ── windows and comparison ──────────────────────────────────────────

function windowOf(tallies: readonly AttemptTally[]): PerformanceWindow {
  const correct = tallies.reduce((sum, t) => sum + t.correct, 0);
  const total = tallies.reduce((sum, t) => sum + t.total, 0);
  return { attempts: tallies.length, correct, total, accuracyPct: accuracyPercent(correct, total) };
}

/**
 * Recent vs previous, from attempts already sorted oldest → newest.
 *
 * RULE (every clause is tested):
 *   1. Window size w = min(5, floor(n / 2)) — the two windows are always the same
 *      size, so neither is compared against a smaller sample.
 *   2. recent   = the newest w attempts.
 *      previous = the w attempts immediately before those. Older attempts are ignored.
 *   3. Available only when w >= 2, i.e. at least 4 attempts. One attempt against
 *      one attempt is a single result, not a comparison.
 *   4. Available only when BOTH windows hold at least WEAK_AREA_MIN_ANSWERED
 *      questions — the same minimum-sample rule Weak Areas uses.
 *   5. Otherwise null. Never a fabricated "0 pts".
 * From 10 attempts up this is exactly "latest 5 vs the 5 before".
 */
export function compareWindows(sorted: readonly AttemptTally[]): PerformanceComparison | null {
  const n = sorted.length;
  const size = Math.min(COMPARISON_MAX_WINDOW, Math.floor(n / 2));
  if (size < COMPARISON_MIN_WINDOW) return null;

  const recent = windowOf(sorted.slice(n - size));
  const previous = windowOf(sorted.slice(n - 2 * size, n - size));
  if (recent.total < WEAK_AREA_MIN_ANSWERED || previous.total < WEAK_AREA_MIN_ANSWERED) return null;

  return { recent, previous, deltaPts: recent.accuracyPct - previous.accuracyPct };
}

// ── per-source summary ──────────────────────────────────────────────

const RETENTION_LABEL: Record<InsightSource, string> = {
  'interview': `${INTERVIEW_HISTORY_MAX} most recent interviews`,
  'topic-quiz': `${TOPIC_PERFORMANCE_HISTORY_MAX} most recent topic results`,
  'weak-areas-practice': `${TOPIC_PERFORMANCE_HISTORY_MAX} most recent topic results`
};

/** Summarize ONE source. Null when that source has no usable attempts — never zeros. */
export function summarizeSource(
  source: InsightSource,
  tallies: readonly AttemptTally[]
): SourceSummary | null {
  const sorted = usableTallies(tallies);
  if (sorted.length === 0) return null;

  const all = windowOf(sorted);
  return {
    source,
    attempts: all.attempts,
    correct: all.correct,
    total: all.total,
    accuracyPct: all.accuracyPct,
    latestAt: sorted[sorted.length - 1]!.completedAt,
    comparison: compareWindows(sorted),
    retentionLabel: RETENTION_LABEL[source]
  };
}

// ── topics ──────────────────────────────────────────────────────────

/**
 * EVERY topic with recorded answers, via the authoritative Weak Areas path with
 * its rules relaxed (no threshold, no minimum, no cap). That is the same
 * aggregation, the same malformed-attempt filtering and the same recency rule —
 * not a second implementation of any of them.
 */
function everyTopic(attempts: readonly TopicAttemptLike[]): WeakTopic[] {
  return calculateWeakTopics(attempts, {
    threshold: Number.POSITIVE_INFINITY,
    minAnswered: 0,
    max: Number.POSITIVE_INFINITY
  });
}

function toInsight(t: WeakTopic): TopicPerformanceInsight {
  return {
    topicId: t.topicId,
    topicName: t.topicName,
    correct: t.correct,
    total: t.total,
    percentage: accuracyPercent(t.correct, t.total),
    lastActivityAt: t.lastActivityAt,
    hasEnoughData: t.total >= WEAK_AREA_MIN_ANSWERED
  };
}

/**
 * Strongest topics.
 *
 * ELIGIBLE  a topic Weak Areas could JUDGE (>= the minimum sample) that Weak
 *           Areas does NOT consider weak.
 * EXCLUDED  every topic below the weak threshold — the UNCAPPED weak set, not
 *           just the three Needs Review shows, or a 4th-weakest topic would
 *           qualify as "strongest" — plus whatever the caller passes as needsReview.
 *           So "Strongest ∩ Needs Review = ∅" holds by construction, and follows
 *           the threshold automatically if Weak Areas ever changes it.
 * ORDER     highest accuracy, then the larger sample, then most recent, then topicId.
 */
export function selectStrongestTopics(
  attempts: readonly TopicAttemptLike[],
  needsReview: readonly WeakTopic[]
): TopicPerformanceInsight[] {
  const weakIds = new Set<string>([
    ...calculateWeakTopics(attempts, { max: Number.POSITIVE_INFINITY }).map((t) => t.topicId),
    ...(Array.isArray(needsReview) ? needsReview : []).map((t) => t.topicId)
  ]);

  return everyTopic(attempts)
    .filter((t) => t.total >= WEAK_AREA_MIN_ANSWERED && !weakIds.has(t.topicId))
    .sort(
      (a, b) =>
        b.percentage - a.percentage ||
        b.total - a.total ||
        b.lastActivityAt.localeCompare(a.lastActivityAt) ||
        a.topicId.localeCompare(b.topicId)
    )
    .slice(0, STRONGEST_MAX_TOPICS)
    .map(toInsight);
}

/** Every topic, most evidence first (then topicId, so the order is deterministic). */
export function summarizeTopics(attempts: readonly TopicAttemptLike[]): TopicPerformanceInsight[] {
  return everyTopic(attempts)
    .sort((a, b) => b.total - a.total || a.topicId.localeCompare(b.topicId))
    .map(toInsight);
}

// ── assembly ────────────────────────────────────────────────────────

export function buildPerformanceInsights(input: PerformanceInsightsInput): PerformanceInsights {
  const topicQuiz = summarizeSource('topic-quiz', groupIntoLogicalAttempts(input.topicRecords, 'topic-quiz'));
  const practice = summarizeSource(
    'weak-areas-practice',
    groupIntoLogicalAttempts(input.topicRecords, 'weak-areas-practice')
  );
  const interview = summarizeSource('interview', tallyInterviewAttempts(input.interviewAttempts));

  const needsReview = Array.isArray(input.needsReview) ? input.needsReview : [];
  const topics = summarizeTopics(input.attempts);

  return {
    hasData: topicQuiz !== null || practice !== null || interview !== null || topics.length > 0,
    topicQuiz,
    interview,
    practice,
    topics,
    strongest: selectStrongestTopics(input.attempts, needsReview),
    needsReview
  };
}
