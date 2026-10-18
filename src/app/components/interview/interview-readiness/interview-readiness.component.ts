import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  ViewEncapsulation
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
  // One combined "label, value" (or "label, note") phrase — see this
  // component's own history comment on .readiness__factor in the .html
  // file for why the label and value/note are merged into one spoken unit.
  accessibleLabel: string;
}

const BAND_LABEL: Record<InterviewReadinessBand, string> = {
  'early-preparation': $localize`Early Preparation`,
  developing: $localize`Developing`,
  progressing: $localize`Progressing`,
  strong: $localize`Strong`,
  'interview-ready': $localize`Interview Ready`
};

const FACTOR_LABEL: Record<InterviewReadinessFactor, string> = {
  'recent-performance': $localize`Recent Performance`,
  consistency: $localize`Consistency`,
  'topic-coverage': $localize`Topic Coverage`,
  'topic-strength': $localize`Topic Strength`
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
  changeDetection: ChangeDetectionStrategy.OnPush
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
    // Plain concatenation, not $localize — matching the ORIGINAL bar
    // aria-label's own convention (this exact ": N out of 100" shape was
    // never wrapped in $localize here, since $localize's leading-colon
    // metadata-block parsing mis-parses a literal ':' right after an
    // interpolation).
    const outOf100 = (label: string, value: number) => `${label}: ${value} out of 100`;
    const coverageNote = $localize`${r.practicedTopicCount} topics practiced`;
    return [
      {
        key: 'recent-performance',
        label: FACTOR_LABEL['recent-performance'],
        value: r.recentPerformance,
        showBar: true,
        accessibleLabel: outOf100(FACTOR_LABEL['recent-performance'], r.recentPerformance)
      },
      {
        key: 'consistency',
        label: FACTOR_LABEL['consistency'],
        value: r.consistency,
        showBar: true,
        accessibleLabel: outOf100(FACTOR_LABEL['consistency'], r.consistency)
      },
      {
        key: 'topic-coverage',
        label: FACTOR_LABEL['topic-coverage'],
        value: r.topicCoverage,
        showBar: r.coverageAvailable,
        note: r.coverageAvailable ? undefined : coverageNote,
        accessibleLabel: r.coverageAvailable
          ? outOf100(FACTOR_LABEL['topic-coverage'], r.topicCoverage)
          : $localize`${FACTOR_LABEL['topic-coverage']}, ${coverageNote}`
      },
      {
        key: 'topic-strength',
        label: FACTOR_LABEL['topic-strength'],
        value: r.topicStrength,
        showBar: true,
        accessibleLabel: outOf100(FACTOR_LABEL['topic-strength'], r.topicStrength)
      }
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

  /**
   * CONFIRMED (manual Narrator Scan Mode report, 2026-10-18): this card's
   * related content was announced as disconnected fragments — the score/
   * band summary (a separate hidden paragraph), the explanation (a
   * separate visible paragraph saying something related but differently
   * worded), and in the limited-data case, two more separate visible
   * paragraphs covering similar ground again. Fix, reusing the Interview
   * Results score-hero pattern (see .html file's own comment on
   * .readiness__summary): one `role="img"` wrapper around the real
   * score-row + explanation (or the two limited-data paragraphs), named
   * by this exact phrase — now the ONLY source for all of it, so the
   * wording actually matches what's on screen instead of drifting from
   * it. The heading stays OUTSIDE this wrapper and fully real, so
   * "Interview Readiness" remains discoverable as its own heading stop.
   */
  readonly ariaSummary = computed(() => {
    const r = this.readiness();
    if (!r) return '';
    if (r.status !== 'ready') {
      return $localize`Complete at least one more interview to calculate your readiness score. Your first result has been recorded.`;
    }
    return $localize`Interview readiness score: ${r.score} out of 100. Band: ${this.bandLabel()}. ${r.explanation}`;
  });
}
