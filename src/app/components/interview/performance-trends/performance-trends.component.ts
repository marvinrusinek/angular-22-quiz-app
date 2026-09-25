import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  ViewEncapsulation
} from '@angular/core';

import { InterviewTrendPoint, InterviewTrends } from '@shared/models/interview-history.model';

// SVG canvas geometry (a viewBox — the element itself scales to its container,
// so the chart is fully responsive without any JS resize handling).
const VB = { W: 320, H: 150, padL: 36, padR: 12, padT: 14, padB: 28 } as const;

interface PlottedPoint extends InterviewTrendPoint {
  cx: number;
  cy: number;
}

interface ChartGeometry {
  vb: string;
  points: PlottedPoint[];
  line: string;
  area: string;
  grid: { value: number; y: number; label: boolean }[];
  baselineY: number;
  axisX: number;
  right: number;
}

/**
 * Performance Trends — an overall interview-score trend for the retained
 * attempts. Presentation only: it takes the derived `trends` (from
 * InterviewHistoryService) and renders a lightweight, dependency-free inline SVG
 * line chart, compact metrics, a factual interpretation, and a visually-hidden
 * accessible data list (the chart's information is never colour- or vision-only).
 *
 * A hand-rolled SVG line chart is the project's established charting approach
 * (see the Topic Performance bars and the results scroll-cue): it is CSP-safe
 * (strict `script-src 'self'`), theme-aware via the results CSS vars, and far
 * lighter than pulling in Chart.js for a single line.
 */
@Component({
  selector: 'app-performance-trends',
  standalone: true,
  templateUrl: './performance-trends.component.html',
  styleUrls: ['./performance-trends.component.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PerformanceTrendsComponent {
  readonly trends = input<InterviewTrends | null>(null);

  readonly count = computed(() => this.trends()?.count ?? 0);

  // View states: no history (defensive), the just-saved first attempt, or a
  // chartable series (≥ 2 attempts).
  readonly isEmpty = computed(() => this.count() === 0);
  readonly isFirst = computed(() => this.count() === 1);
  readonly hasChart = computed(() => this.count() >= 2);

  // Accessible data list: newest first (matches how users read "most recent").
  readonly srPoints = computed<InterviewTrendPoint[]>(() =>
    [...(this.trends()?.points ?? [])].reverse()
  );

  // Compact "+6 pts" / "-6 pts" / "0 pts" label for the Change metric.
  readonly changeLabel = computed(() => {
    const c = this.trends()?.change;
    if (c === null || c === undefined) return '—';
    const sign = c > 0 ? '+' : '';
    return `${sign}${c} pts`;
  });

  readonly changeAria = computed(() => {
    const c = this.trends()?.change;
    if (c === null || c === undefined) return $localize`No previous interview to compare against yet`;
    if (c > 0) return $localize`Up ${c} percentage points since the previous interview`;
    if (c < 0) return $localize`Down ${Math.abs(c)} percentage points since the previous interview`;
    return $localize`No change since the previous interview`;
  });

  // Pure SVG geometry for the score line. Null until there are ≥ 2 points.
  readonly chart = computed<ChartGeometry | null>(() => {
    const t = this.trends();
    if (!t || t.points.length < 2) return null;

    const innerW = VB.W - VB.padL - VB.padR;
    const innerH = VB.H - VB.padT - VB.padB;
    const n = t.points.length;

    const x = (i: number) => VB.padL + (i * innerW) / (n - 1);
    const y = (pct: number) => VB.padT + innerH * (1 - pct / 100);
    const r1 = (v: number) => Math.round(v * 10) / 10;

    const points: PlottedPoint[] = t.points.map((p, i) => ({
      ...p,
      cx: r1(x(i)),
      cy: r1(y(p.percentage))
    }));

    const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.cx} ${p.cy}`).join(' ');

    const baselineY = r1(y(0));
    const area =
      `${line} L${points[points.length - 1].cx} ${baselineY} ` +
      `L${points[0].cx} ${baselineY} Z`;

    const grid = [0, 25, 50, 75, 100].map((value) => ({
      value,
      y: r1(y(value)),
      label: value % 50 === 0   // label only 0 / 50 / 100 to avoid clutter
    }));

    return {
      vb: `0 0 ${VB.W} ${VB.H}`,
      points,
      line,
      area,
      grid,
      baselineY,
      axisX: VB.padL,
      right: VB.W - VB.padR
    };
  });

  // Show an x-axis attempt label sparsely so up to 20 points never crowd.
  showXLabel(index0: number): boolean {
    const n = this.count();
    if (n <= 1) return false;
    const step = Math.max(1, Math.ceil(n / 6));
    return index0 === 0 || index0 === n - 1 || index0 % step === 0;
  }

  /** "July 22, 2026" — locale-formatted, with a safe fallback for odd input. */
  formatDate(iso: string): string {
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    } catch {
      return iso;
    }
  }

  /** Accessible sentence per attempt, e.g. "July 22, 2026: 17 out of 20, 85%." */
  srLine(p: InterviewTrendPoint): string {
    const base = `${this.formatDate(p.completedAt)}: ${p.score} out of ${p.totalQuestions}, ${p.percentage}%`;
    return p.completionReason === 'time-expired' ? `${base} (time expired).` : `${base}.`;
  }

  /** SVG point tooltip (native <title>). */
  pointTitle(p: InterviewTrendPoint): string {
    return this.srLine(p);
  }
}
