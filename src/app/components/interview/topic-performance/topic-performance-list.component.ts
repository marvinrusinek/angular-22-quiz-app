import { ChangeDetectionStrategy, Component, computed, input, ViewEncapsulation } from '@angular/core';

import { InterviewAnalytics } from '@shared/models/interview-analytics.model';

/**
 * Presentational Topic Performance — the per-topic bands plus the Strongest /
 * Needs-Review highlights. Driven entirely by an InterviewAnalytics input so it
 * can be reused by both the live Interview Results page and the read-only
 * historical summary. It NEVER computes analytics itself — the caller passes the
 * output of InterviewAnalyticsService.analyze().
 *
 * ViewEncapsulation.None with `topic-*` class names + `--ir-*` theme vars (with
 * fallbacks), so it looks identical wherever it is hosted.
 */
@Component({
  selector: 'app-topic-performance-list',
  standalone: true,
  imports: [],
  templateUrl: './topic-performance-list.component.html',
  styleUrls: ['./topic-performance-list.component.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class TopicPerformanceListComponent {
  readonly analytics = input<InterviewAnalytics | null>(null);

  readonly topics = computed(() => this.analytics()?.topics ?? []);
  readonly strongest = computed(() => this.analytics()?.strongestTopics ?? []);
  readonly weakest = computed(() => this.analytics()?.weakestTopics ?? []);
  readonly hasHighlights = computed(() => this.strongest().length > 0 || this.weakest().length > 0);
}
