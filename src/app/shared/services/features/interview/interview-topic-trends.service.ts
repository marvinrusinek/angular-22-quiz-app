import { computed, inject, Service } from '@angular/core';

import {
  InterviewAttemptHistoryEntry,
  InterviewTopicTrendsResult,
  TopicStrengthBand,
  TopicTrend,
  TopicTrendDirection,
  TopicTrendFilter,
  TopicTrendPoint
} from '@shared/models';
import { aggregateTopicPercentages } from '@shared/utils/interview-topic-history';
import { InterviewHistoryService } from './interview-history.service';

// The dead-band for a directional topic trend, in percentage points. One named
// constant — never scattered through the UI.
export const TOPIC_TREND_THRESHOLD = 5;

// Strength band cutoffs (aggregate percentage). 'weak' surfaces as "Needs Review".
const STRONG_MIN = 75;
const MODERATE_MIN = 60;

const round = (n: number): number => Math.round(n);

/**
 * Derives per-topic trends from retained Interview History. Focused (keeps
 * Readiness/Analytics small), storage-free, presentation-free: it reuses the
 * shared aggregateTopicPercentages helper and the validated history signal, and
 * exposes a computed result. All scoring is in the pure helpers below.
 */
@Service()
export class InterviewTopicTrendsService {
  private readonly history = inject(InterviewHistoryService);

  readonly trends = computed<InterviewTopicTrendsResult>(() =>
    calculateTopicTrends(this.history.history())
  );
}

// ── pure helpers (exported for tests) ─────────────────────────────────

/** Group retained attempts into per-topic chronological appearance points.
 *  Attempts are already oldest → latest; only real appearances (total > 0). */
export function buildTopicTrendPoints(
  attempts: readonly InterviewAttemptHistoryEntry[]
): Map<string, TopicTrendPoint[]> {
  const map = new Map<string, TopicTrendPoint[]>();
  for (const [i, a] of attempts.entries()) {
    for (const t of a.topicPerformance ?? []) {
      if (!(t.total > 0)) continue;
      const point: TopicTrendPoint = {
        attemptId: a.id,
        attemptNumber: a.attemptNumber ?? i + 1,
        completedAt: a.completedAt,
        correct: t.correct,
        total: t.total,
        // Recompute from raw correct/total (total > 0 here) so a directional
        // trend can never be skewed by an inconsistent retained percentage.
        percentage: Math.round((t.correct / t.total) * 100)
      };
      const list = map.get(t.topicId);
      if (list) list.push(point);
      else map.set(t.topicId, [point]);
    }
  }
  return map;
}

/** Direction from a topic's latest two appearance percentages. */
export function calculateTopicDirection(
  latestPercentage: number,
  previousPercentage: number | null,
  threshold = TOPIC_TREND_THRESHOLD
): TopicTrendDirection {
  if (previousPercentage === null) return 'insufficient';
  const change = latestPercentage - previousPercentage;
  if (change >= threshold) return 'improving';
  if (change <= -threshold) return 'declining';
  return 'steady';
}

/** Aggregate topic percentage from raw correct/total sums (0–100). */
export function calculateAggregateTopicPercentage(points: readonly TopicTrendPoint[]): number {
  const correct = points.reduce((s, p) => s + p.correct, 0);
  const total = points.reduce((s, p) => s + p.total, 0);
  return total > 0 ? round((correct / total) * 100) : 0;
}

/** Aggregate percentage → strength band. */
export function getTopicStrengthBand(aggregatePercentage: number): TopicStrengthBand {
  if (aggregatePercentage >= STRONG_MIN) return 'strong';
  if (aggregatePercentage >= MODERATE_MIN) return 'moderate';
  return 'weak';
}

/** A topic needs attention when it is declining or weak overall. Insufficient
 *  data alone never forces priority. */
export function isPriorityTopic(aggregatePercentage: number, direction: TopicTrendDirection): boolean {
  return aggregatePercentage < MODERATE_MIN || direction === 'declining';
}

/** Assemble one TopicTrend from its chronological points. */
export function buildTopicTrend(
  topicId: string,
  topicName: string,
  points: TopicTrendPoint[]
): TopicTrend {
  const appearances = points.length;
  const totalQuestions = points.reduce((s, p) => s + p.total, 0);
  const latestPercentage = appearances > 0 ? points[appearances - 1].percentage : 0;
  const previousPercentage = appearances >= 2 ? points[appearances - 2].percentage : null;
  const change = previousPercentage !== null ? latestPercentage - previousPercentage : null;
  const direction = calculateTopicDirection(latestPercentage, previousPercentage);
  const aggregatePercentage = calculateAggregateTopicPercentage(points);
  const strengthBand = getTopicStrengthBand(aggregatePercentage);
  const isPriority = isPriorityTopic(aggregatePercentage, direction);

  return {
    topicId,
    topicName,
    points,
    appearances,
    totalQuestions,
    latestPercentage,
    previousPercentage,
    aggregatePercentage,
    change,
    direction,
    strengthBand,
    isPriority,
    explanation: buildTopicExplanation(topicName, direction, change)
  };
}

/** Sort by usefulness: declining → other priority → improving → steady →
 *  insufficient; within groups by aggregate / change, then name. */
export function sortTopicTrends(topics: readonly TopicTrend[]): TopicTrend[] {
  const group = (t: TopicTrend): number => {
    if (t.direction === 'insufficient') return 4;
    if (t.direction === 'declining') return 0;
    if (t.isPriority) return 1;
    if (t.direction === 'improving') return 2;
    return 3;   // steady, non-priority
  };
  return [...topics].sort((a, b) => {
    const ga = group(a);
    const gb = group(b);
    if (ga !== gb) return ga - gb;
    // Priority groups (declining/other-priority): lowest aggregate first.
    if (ga <= 1) {
      if (a.aggregatePercentage !== b.aggregatePercentage) return a.aggregatePercentage - b.aggregatePercentage;
    } else if (ga === 2) {
      // Improving: largest positive change first.
      const ca = a.change ?? 0;
      const cb = b.change ?? 0;
      if (ca !== cb) return cb - ca;
    }
    return a.topicName.localeCompare(b.topicName);   // stable final tie-break
  });
}

/** Summary counts (a topic counts once per applicable category). */
export function summarizeTopicTrends(
  topics: readonly TopicTrend[]
): Omit<InterviewTopicTrendsResult, 'topics'> {
  return {
    trackedCount: topics.length,
    improvingCount: topics.filter((t) => t.direction === 'improving').length,
    steadyCount: topics.filter((t) => t.direction === 'steady').length,
    needsAttentionCount: topics.filter((t) => t.isPriority).length,
    insufficientCount: topics.filter((t) => t.direction === 'insufficient').length
  };
}

/** Client-side filter. */
export function filterTopicTrends(
  topics: readonly TopicTrend[],
  filter: TopicTrendFilter
): TopicTrend[] {
  switch (filter) {
    case 'improving':
      return topics.filter((t) => t.direction === 'improving');
    case 'steady':
      return topics.filter((t) => t.direction === 'steady');
    case 'needs-attention':
      return topics.filter((t) => t.isPriority);
    case 'insufficient':
      return topics.filter((t) => t.direction === 'insufficient');
    default:
      return [...topics];
  }
}

/** Whole result from retained history. */
export function calculateTopicTrends(
  attempts: readonly InterviewAttemptHistoryEntry[]
): InterviewTopicTrendsResult {
  const pointsByTopic = buildTopicTrendPoints(attempts);
  // Reuse the shared aggregation for topic names (raw correct/total identical).
  const names = new Map(aggregateTopicPercentages(attempts).map((t) => [t.topicId, t.topicName]));

  const topics = [...pointsByTopic.entries()].map(([topicId, points]) =>
    buildTopicTrend(topicId, names.get(topicId) ?? topicId, points)
  );
  const sorted = sortTopicTrends(topics);
  return { topics: sorted, ...summarizeTopicTrends(sorted) };
}

// Short, factual interpretations — no exaggerated language.
export function buildTopicExplanation(
  topicName: string,
  direction: TopicTrendDirection,
  change: number | null
): string {
  const pts = Math.abs(change ?? 0);
  switch (direction) {
    case 'improving':
      return `Your ${topicName} performance improved by ${pts} percentage points across its two most recent appearances.`;
    case 'declining':
      return `Your ${topicName} performance declined by ${pts} percentage points. Review this topic before your next interview.`;
    case 'steady':
      return `Your ${topicName} performance is holding steady across recent interviews.`;
    default:
      return 'Complete another interview containing this topic to establish a trend.';
  }
}
