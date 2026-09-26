import { ChangeDetectionStrategy, Component, computed, input, signal, ViewEncapsulation } from '@angular/core';
import { RouterLink } from '@angular/router';

import {
  InterviewTopicTrendsResult,
  TopicStrengthBand,
  TopicTrend,
  TopicTrendDirection,
  TopicTrendFilter,
  TopicTrendPoint
} from '@shared/models';
import { filterTopicTrends } from '@shared/services/features/interview/interview-topic-trends.service';

interface SparkGeometry {
  vb: string;
  line: string;
  points: { cx: number; cy: number; latest: boolean }[];
}

const DIRECTION_LABEL: Record<TopicTrendDirection, string> = {
  improving: $localize`Improving`,
  declining: $localize`Declining`,
  steady: $localize`Holding Steady`,
  insufficient: $localize`More data needed`
};

const BAND_LABEL: Record<TopicStrengthBand, string> = {
  strong: $localize`Strong`,
  moderate: $localize`Moderate`,
  weak: $localize`Needs Review`   // user-facing label for the internal 'weak'
};

/**
 * Topic Trends — presentational only. Renders a supplied InterviewTopicTrendsResult
 * (computed by InterviewTopicTrendsService); it never reads storage, loads quiz
 * data, or calculates trend formulas. Trend + strength are shown as SEPARATE
 * labels. A restrained inline SVG sparkline supplements the always-present
 * numeric text (never color-only), with expandable per-topic history.
 */
@Component({
  selector: 'app-interview-topic-trends',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './interview-topic-trends.component.html',
  styleUrls: ['./interview-topic-trends.component.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InterviewTopicTrendsComponent {
  readonly trends = input<InterviewTopicTrendsResult | null>(null);

  readonly filter = signal<TopicTrendFilter>('all');
  private readonly expanded = signal<ReadonlySet<string>>(new Set());

  readonly hasResult = computed(() => this.trends() !== null);
  readonly hasTopics = computed(() => (this.trends()?.topics.length ?? 0) > 0);
  readonly allInsufficient = computed(() => {
    const t = this.trends();
    return !!t && t.topics.length > 0 && t.topics.every((x) => x.direction === 'insufficient');
  });

  readonly filters = computed<{ id: TopicTrendFilter; label: string; count: number }[]>(() => {
    const t = this.trends();
    if (!t) return [];
    return [
      { id: 'all', label: $localize`All`, count: t.trackedCount },
      { id: 'improving', label: $localize`Improving`, count: t.improvingCount },
      { id: 'steady', label: $localize`Steady`, count: t.steadyCount },
      { id: 'needs-attention', label: $localize`Needs Attention`, count: t.needsAttentionCount },
      { id: 'insufficient', label: $localize`More Data Needed`, count: t.insufficientCount }
    ];
  });

  readonly visibleTopics = computed<TopicTrend[]>(() =>
    filterTopicTrends(this.trends()?.topics ?? [], this.filter())
  );

  setFilter(id: TopicTrendFilter): void {
    this.filter.set(id);
  }

  isExpanded(topicId: string): boolean {
    return this.expanded().has(topicId);
  }

  toggle(topicId: string): void {
    this.expanded.update((set) => {
      const next = new Set(set);
      if (next.has(topicId)) next.delete(topicId);
      else next.add(topicId);
      return next;
    });
  }

  directionLabel(d: TopicTrendDirection): string {
    return DIRECTION_LABEL[d];
  }

  bandLabel(b: TopicStrengthBand): string {
    return BAND_LABEL[b];
  }

  /** "+15 points" / "-10 points" / "—". */
  changeLabel(change: number | null): string {
    if (change === null) return '—';
    const sign = change > 0 ? '+' : '';
    return `${sign}${change} points`;
  }

  sampleText(t: TopicTrend): string {
    return `Based on ${t.appearances} appearances and ${t.totalQuestions} questions`;
  }

  /** Full accessible summary sentence for a topic (chart alternative). Plain
   *  string (not $localize) — a placeholder immediately before ":" would be
   *  misread as $localize metadata, and these dynamic sentences aren't extracted. */
  ariaSummary(t: TopicTrend): string {
    // Announce strength AND direction (the two separate visible badges are
    // aria-hidden), then the numeric scores.
    const band = this.bandLabel(t.strengthBand);
    if (t.direction === 'insufficient') {
      return `${t.topicName}: ${band}, more data needed. Latest score ${t.latestPercentage} percent, overall score ${t.aggregatePercentage} percent.`;
    }
    const dir = this.directionLabel(t.direction).toLowerCase();
    const pts = Math.abs(t.change ?? 0);
    return `${t.topicName}: ${band} and ${dir} by ${pts} percentage points, latest score ${t.latestPercentage} percent, overall score ${t.aggregatePercentage} percent.`;
  }

  formatDate(iso: string): string {
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    } catch {
      return iso;
    }
  }

  /** Inline sparkline geometry (0–100 scale, no truncated axis). Null when < 2
   *  points. Pure geometry — the numeric values remain the primary signal. */
  sparkline(points: readonly TopicTrendPoint[]): SparkGeometry | null {
    if (points.length < 2) return null;
    const W = 120;
    const H = 36;
    const padX = 4;
    const padY = 4;
    const n = points.length;
    const x = (i: number) => padX + (i * (W - padX * 2)) / (n - 1);
    const y = (pct: number) => padY + (H - padY * 2) * (1 - pct / 100);   // full 0–100 scale
    const r1 = (v: number) => Math.round(v * 10) / 10;
    const plotted = points.map((p, i) => ({ cx: r1(x(i)), cy: r1(y(p.percentage)), latest: i === n - 1 }));
    const line = plotted.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.cx} ${p.cy}`).join(' ');
    return { vb: `0 0 ${W} ${H}`, line, points: plotted };
  }
}
