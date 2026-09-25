import { Service } from '@angular/core';

import { InterviewResult } from '@shared/models/InterviewResult.model';
import {
  InterviewAnalytics,
  PerformanceBand,
  TopicPerformance,
} from '@shared/models/interview-analytics.model';

const EMPTY: InterviewAnalytics = Object.freeze({
  topics: Object.freeze([]),
  strongestTopics: Object.freeze([]),
  weakestTopics: Object.freeze([]),
}) as InterviewAnalytics;

/**
 * Derives Topic Performance analytics from an InterviewResult. It REUSES the
 * result's existing `perTopic` scores (computed at submission) — it never
 * re-scores questions or recomputes the interview. Pure + immutable.
 *
 * Bands: strong ≥ 80%, moderate 60–79%, weak < 60%.
 *
 * Ordering (documented, deterministic): topics are sorted by percentage, then by
 * question count (more questions first — a more reliable signal), then by name.
 * Strongest/Needs-Review each show up to 3 topics, capped at HALF the topics so
 * the two ends never overlap; when every topic has the same percentage there is
 * no meaningful ranking, so both ends are empty.
 */
@Service()
export class InterviewAnalyticsService {
  private static readonly STRONG_MIN = 80;
  private static readonly MODERATE_MIN = 60;
  private static readonly MAX_HIGHLIGHTS = 3;

  analyze(result: InterviewResult | null | undefined): InterviewAnalytics {
    const perTopic = result?.perTopic ?? [];
    // Only topics that actually appeared (perTopic already excludes total === 0,
    // but guard anyway).
    const topics: TopicPerformance[] = perTopic
      .filter((t) => t && t.total > 0)
      .map((t) => ({
        topicId: t.quizId,
        topicName: t.title,
        correct: t.correct,
        total: t.total,
        percentage: t.percentage,
        band: this.bandFor(t.percentage),
      }));

    if (topics.length === 0) return EMPTY;

    const byBest = [...topics].sort(this.compareBestFirst);
    // Worst-first is the EXACT reverse of best-first, so the top-k and bottom-k
    // are always disjoint — a middle topic can never appear as both strongest and
    // needs-review, whatever the ties.
    const byWorst = [...byBest].reverse();

    const allEqual = topics.every((t) => t.percentage === topics[0].percentage);
    const k =
      topics.length < 2 || allEqual
        ? 0
        : Math.min(InterviewAnalyticsService.MAX_HIGHLIGHTS, Math.floor(topics.length / 2));

    return Object.freeze({
      topics: Object.freeze(byBest),
      strongestTopics: Object.freeze(byBest.slice(0, k)),
      weakestTopics: Object.freeze(byWorst.slice(0, k)),
    }) as InterviewAnalytics;
  }

  private bandFor(percentage: number): PerformanceBand {
    if (percentage >= InterviewAnalyticsService.STRONG_MIN) return 'strong';
    if (percentage >= InterviewAnalyticsService.MODERATE_MIN) return 'moderate';
    return 'weak';
  }

  // Canonical order — best first: higher %, then more questions (a stronger
  // signal), then name A→Z. Needs-Review reverses this exact order.
  private readonly compareBestFirst = (a: TopicPerformance, b: TopicPerformance): number =>
    b.percentage - a.percentage || b.total - a.total || a.topicName.localeCompare(b.topicName);
}
