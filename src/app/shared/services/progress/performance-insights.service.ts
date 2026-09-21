import { computed, inject, Service, Signal } from '@angular/core';

import { PerformanceInsights } from '../../models/performance-insights.model';
import { buildPerformanceInsights } from '../../utils/performance-insights';
import { InterviewHistoryService } from '../features/interview/interview-history.service';
import { TopicPerformanceHistoryService } from './topic-performance-history.service';
import { WeakAreasService } from './weak-areas.service';

/**
 * Read-only Performance Insights.
 *
 * Reads the histories that already exist and hands them to the pure calculation
 * in `utils/performance-insights.ts`. It owns NOTHING: no storage key, no write,
 * no UI state, no answer data, and it never mutates the services it reads.
 *
 *   TopicPerformanceHistoryService ─ raw records (with `source`)
 *   InterviewHistoryService        ─ interview attempts
 *   WeakAreasService               ─ the merged dataset AND Needs Review, so the
 *                                    two can never disagree about a topic
 *
 * It deliberately does NOT extend WeakAreasService: that service is the single
 * authority on "weakest topics" and stays exactly that.
 */
@Service()
export class PerformanceInsightsService {
  private readonly topicHistory = inject(TopicPerformanceHistoryService);
  private readonly interviewHistory = inject(InterviewHistoryService);
  private readonly weakAreas = inject(WeakAreasService);

  /** Recomputes whenever any underlying history changes. */
  readonly insights: Signal<PerformanceInsights> = computed(() =>
    buildPerformanceInsights({
      topicRecords: this.topicHistory.records(),
      interviewAttempts: this.interviewHistory.history(),
      attempts: this.weakAreas.mergedAttempts(),
      needsReview: this.weakAreas.weakTopics()
    })
  );
}
