import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  ViewEncapsulation,
} from '@angular/core';

import {
  InterviewReadiness,
  InterviewReadinessBand,
  InterviewReadinessFactor
} from '@shared/models';

interface FactorRow {
  key: InterviewReadinessFactor;
  label: string;
  value: number;
  showBar: boolean; // false → coverage unavailable, show practiced-count note
  note?: string;
}

const BAND_LABEL: Record<InterviewReadinessBand, string> = {
  'early-preparation': $localize`Early Preparation`,
  developing: $localize`Developing`,
  progressing: $localize`Progressing`,
  strong: $localize`Strong`,
  'interview-ready': $localize`Interview Ready`,
};

const FACTOR_LABEL: Record<InterviewReadinessFactor, string> = {
  'recent-performance': $localize`Recent Performance`,
  consistency: $localize`Consistency`,
  'topic-coverage': $localize`Topic Coverage`,
  'topic-strength': $localize`Topic Strength`,
};

/**
 * Interview Readiness — a coaching indicator. Purely presentational: it renders
 * a supplied InterviewReadiness (computed by InterviewReadinessService from the
 * shared history) and never reads storage or does scoring. A score card with
 * text + simple bars (no gauge), accessible and theme-aware.
 */
@Component({
  selector: 'app-interview-readiness',
  standalone: true,
  imports: [],
  templateUrl: './interview-readiness.component.html',
  styleUrls: ['./interview-readiness.component.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InterviewReadinessComponent {
  readonly readiness = input<InterviewReadiness | null>(null);
  // Compact = the Interview History list banner: score + band + explanation only.
  readonly compact = input<boolean>(false);

  readonly bandLabel = computed(() => {
    const r = this.readiness();
    return r ? BAND_LABEL[r.band] : '';
  });

  readonly factors = computed<FactorRow[]>(() => {
    const r = this.readiness();
    if (!r || r.status !== 'ready') return [];
    return [
      {
        key: 'recent-performance',
        label: FACTOR_LABEL['recent-performance'],
        value: r.recentPerformance,
        showBar: true,
      },
      {
        key: 'consistency',
        label: FACTOR_LABEL['consistency'],
        value: r.consistency,
        showBar: true,
      },
      {
        key: 'topic-coverage',
        label: FACTOR_LABEL['topic-coverage'],
        value: r.topicCoverage,
        showBar: r.coverageAvailable,
        note: r.coverageAvailable
          ? undefined
          : $localize`${r.practicedTopicCount} topics practiced`,
      },
      {
        key: 'topic-strength',
        label: FACTOR_LABEL['topic-strength'],
        value: r.topicStrength,
        showBar: true,
      },
    ];
  });

  // "Based on N" footnote per the data-volume state.
  readonly basedOn = computed(() => {
    const r = this.readiness();
    if (!r || r.status !== 'ready') return '';
    return r.totalAttempts >= 5
      ? $localize`Based on your 5 most recent interviews and retained topic history`
      : $localize`Based on ${r.totalAttempts} completed interviews`;
  });

  // Screen-reader summary of the whole card.
  readonly ariaSummary = computed(() => {
    const r = this.readiness();
    if (!r) return '';
    if (r.status !== 'ready') {
      return $localize`Interview readiness: not enough data yet. Complete at least one more interview.`;
    }
    return $localize`Interview readiness score: ${r.score} out of 100. Band: ${this.bandLabel()}.`;
  });
}
