import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  signal,
  ViewEncapsulation
} from '@angular/core';
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
  weak: $localize`Needs Review` // user-facing label for the internal 'weak'
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

  /**
   * CONFIRMED (manual Narrator report, 2026-10-19): right after the Topic
   * Trends heading, Down Arrow read each of these four stats' label and
   * value as two separate stops. Fix: one combined "Label, value" phrase
   * per stat (see .tt-summary's own comment in the .html file for the
   * full reasoning) — matching the "Label, value" comma convention
   * already used for Interview Results' and Performance Trends' own
   * grouped statistics.
   */
  readonly trackedAccessibleLabel = computed(() =>
    $localize`Topics Tracked, ${this.trends()?.trackedCount ?? 0}`
  );
  readonly improvingAccessibleLabel = computed(() =>
    $localize`Improving, ${this.trends()?.improvingCount ?? 0}`
  );
  readonly steadyAccessibleLabel = computed(() =>
    $localize`Holding Steady, ${this.trends()?.steadyCount ?? 0}`
  );
  readonly needsAttentionAccessibleLabel = computed(() =>
    $localize`Needs Attention, ${this.trends()?.needsAttentionCount ?? 0}`
  );

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

  /**
   * CONFIRMED (manual Narrator Scan Mode report, 2026-10-19): entering a
   * topic card announced a full combined sentence (the former
   * `ariaSummary()` / `.tt-card__sr`), then Down Arrow read the heading,
   * badges, and metrics a SECOND time — genuine duplication across several
   * real text nodes, not one misunderstood mechanism. Removed the combined
   * sentence; each piece now reads once, grouped with its own label, via
   * the methods below (same "Label, value" plain-string convention —
   * $localize would misparse the literal ":" these dynamic sentences use).
   */
  badgesAccessibleLabel(t: TopicTrend): string {
    return `Strength, ${this.bandLabel(t.strengthBand)}. Direction, ${this.directionLabel(t.direction)}.`;
  }

  latestAccessibleLabel(t: TopicTrend): string {
    return `Latest, ${t.latestPercentage} percent`;
  }

  previousAccessibleLabel(t: TopicTrend): string {
    return t.previousPercentage === null
      ? 'Previous, no previous attempt'
      : `Previous, ${t.previousPercentage} percent`;
  }

  changeAccessibleLabel(t: TopicTrend): string {
    const change = t.change;
    if (change === null || change === undefined) return 'Change, not available';
    if (change > 0) return `Change, up ${change} points`;
    if (change < 0) return `Change, down ${Math.abs(change)} points`;
    return 'Change, 0 points';
  }

  overallAccessibleLabel(t: TopicTrend): string {
    return `Overall, ${t.aggregatePercentage} percent`;
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
    const y = (pct: number) => padY + (H - padY * 2) * (1 - pct / 100); // full 0–100 scale
    const r1 = (v: number) => Math.round(v * 10) / 10;
    const plotted = points.map((p, i) => ({
      cx: r1(x(i)),
      cy: r1(y(p.percentage)),
      latest: i === n - 1
    }));
    const line = plotted.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.cx} ${p.cy}`).join(' ');
    return { vb: `0 0 ${W} ${H}`, line, points: plotted };
  }
}
