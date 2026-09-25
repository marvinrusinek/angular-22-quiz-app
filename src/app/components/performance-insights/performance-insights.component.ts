import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import {
  InsightSource,
  PerformanceInsights,
  SourceSummary
} from '@shared/models/performance-insights.model';
import { WEAK_AREA_MIN_ANSWERED, WEAK_AREA_THRESHOLD } from '@shared/utils/weak-areas';

/** What each source measures, shown next to its numbers so they are never read as one thing. */
const SOURCE_META: Record<InsightSource, { name: string; basis: string }> = {
  'topic-quiz': {
    name: 'Topic Quiz',
    basis: 'Instant feedback, retries allowed.'
  },
  'interview': {
    name: 'Interview Mode',
    basis: 'One submission, no feedback until the end.'
  },
  'weak-areas-practice': {
    name: 'Weak Areas Practice',
    basis: 'Questions are drawn from your weaker topics.'
  }
};

/** Topics shown before "Show all". Keeps the panel short on a phone. */
export const TOPICS_COLLAPSED_COUNT = 5;

/**
 * Performance Insights — presentation only.
 *
 * Everything shown is already computed (utils/performance-insights.ts via
 * PerformanceInsightsService). This component formats and lays it out; it does
 * no aggregation, reads no storage, and owns one piece of UI state: whether the
 * topic list is expanded.
 *
 * Deliberate omissions: no combined accuracy, no "improving/declining" label, no
 * colour-coded verdict on a change. A change is shown as plain arithmetic.
 *
 * Interview trends are NOT rebuilt here. The existing Performance Trends
 * component brings its own heading, chart and directional wording, which
 * contradicts the neutral-arithmetic rule and is too heavy for this panel, so
 * this links to Interview History instead.
 */
@Component({
  selector: 'codelab-performance-insights',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './performance-insights.component.html',
  styleUrls: ['./performance-insights.component.scss']
})
export class PerformanceInsightsComponent {
  readonly insights = input<PerformanceInsights | null>(null);

  /** Exposed so the template states the SAME thresholds Weak Areas uses. */
  protected readonly minAnswered = WEAK_AREA_MIN_ANSWERED;
  protected readonly threshold = WEAK_AREA_THRESHOLD;

  protected readonly meta = SOURCE_META;

  private readonly _showAllTopics = signal(false);
  protected readonly showAllTopics = this._showAllTopics.asReadonly();

  /** Sources that have data, always in the same order: Topic Quiz, Interview, Practice. */
  protected readonly sources = computed<readonly SourceSummary[]>(() => {
    const i = this.insights();
    if (!i) return [];
    return [i.topicQuiz, i.interview, i.practice].filter((s): s is SourceSummary => s !== null);
  });

  /**
   * Recent-vs-previous rows. Topic Quiz and Interview always get a row (either
   * the arithmetic or "not enough history"). Practice only appears once its
   * comparison is real, because a practice run is a sampled quiz and an
   * unavailable-comparison line for it would just be noise.
   */
  protected readonly recentRows = computed<readonly SourceSummary[]>(() =>
    this.sources().filter((s) => s.source !== 'weak-areas-practice' || s.comparison !== null)
  );

  protected readonly topics = computed(() => this.insights()?.topics ?? []);

  protected readonly visibleTopics = computed(() => {
    const all = this.topics();
    return this.showAllTopics() || all.length <= TOPICS_COLLAPSED_COUNT
      ? all
      : all.slice(0, TOPICS_COLLAPSED_COUNT);
  });

  protected readonly canToggleTopics = computed(() => this.topics().length > TOPICS_COLLAPSED_COUNT);

  protected readonly strongest = computed(() => this.insights()?.strongest ?? []);

  /** Needs Review as WeakAreasService returned it; percentage rounded for display only. */
  protected readonly needsReview = computed(() =>
    (this.insights()?.needsReview ?? []).map((t) => ({ ...t, percentage: Math.round(t.percentage) }))
  );

  protected readonly hasInterview = computed(() => this.insights()?.interview != null);

  /**
   * One quiet disclosure for the whole section, built only from the sources that
   * are actually present, so an interview-only user isn't told about topic results.
   */
  protected readonly retentionNote = computed(() => {
    const labels = [...new Set(this.sources().map((s) => s.retentionLabel))];
    if (labels.length === 0) return '';
    return `Based on your saved recent activity only: your ${labels.join(' and ')}. Older results are not included.`;
  });

  protected toggleTopics(): void {
    this._showAllTopics.update((v) => !v);
  }

  /** "+6 pts", "−6 pts", "0 pts". A real zero is shown as a zero. */
  protected deltaLabel(pts: number): string {
    if (pts > 0) return `+${pts} pts`;
    if (pts < 0) return `−${Math.abs(pts)} pts`;
    return '0 pts';
  }

  protected deltaAria(pts: number): string {
    const n = Math.abs(pts);
    const unit = n === 1 ? 'percentage point' : 'percentage points';
    if (pts > 0) return `up ${n} ${unit}`;
    if (pts < 0) return `down ${n} ${unit}`;
    return `no change, 0 ${unit}`;
  }

  protected plural(n: number, noun: string): string {
    return `${n} ${noun}${n === 1 ? '' : 's'}`;
  }
}
