import { ComponentFixture, TestBed } from '@angular/core/testing';

import { InterviewAttemptHistoryEntry, InterviewTrends } from '@shared/models';
import { summarizeTrends } from '@shared/services/features/interview/interview-history.service';
import { PerformanceTrendsComponent } from './performance-trends.component';

function entry(pct: number, i: number): InterviewAttemptHistoryEntry {
  return {
    id: `att-${i}`,
    completedAt: `2026-07-${String(10 + i).padStart(2, '0')}T10:00:00.000Z`,
    score: pct,
    totalQuestions: 100,
    percentage: pct,
    completionReason: 'submitted',
    selectedTopicIds: ['a'],
    topicPerformance: []
  };
}

function trendsFor(pcts: number[]): InterviewTrends {
  return summarizeTrends(pcts.map((p, i) => entry(p, i)));
}

describe('PerformanceTrendsComponent', () => {
  let fixture: ComponentFixture<PerformanceTrendsComponent>;

  function render(trends: InterviewTrends | null): HTMLElement {
    fixture = TestBed.createComponent(PerformanceTrendsComponent);
    fixture.componentRef.setInput('trends', trends);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [PerformanceTrendsComponent] });
  });

  it('always renders the Performance Trends heading', () => {
    const el = render(trendsFor([70, 80]));
    expect(el.querySelector('.perf-trends__heading')?.textContent).toContain('Performance Trends');
  });

  it('19. first-attempt empty state renders (no chart)', () => {
    const el = render(trendsFor([85]));
    expect(el.querySelector('.perf-trends__empty')?.textContent).toContain(
      'first recorded interview'
    );
    expect(el.querySelector('.perf-chart')).toBeNull();
    expect(el.querySelector('.perf-metrics')).toBeNull();
  });

  it('20. multiple attempts render the score trend chart', () => {
    const el = render(trendsFor([70, 76, 82]));
    expect(el.querySelector('.perf-chart__svg')).not.toBeNull();
    expect(el.querySelectorAll('.perf-chart__dot')).toHaveLength(3);
    expect(el.querySelector('.perf-chart__line')?.getAttribute('d')).toContain('M');
    // Summary metrics present.
    expect(el.querySelectorAll('.perf-metrics dd')).toHaveLength(4);
  });

  it('21. the latest attempt is clearly identified', () => {
    const el = render(trendsFor([70, 76, 82]));
    expect(el.querySelectorAll('.perf-chart__dot--latest')).toHaveLength(1);
  });

  it('22. accessible text data is available for each attempt', () => {
    const el = render(trendsFor([70, 85]));
    const items = el.querySelectorAll('.perf-trends__sr p');
    // The lead sentence ("Interview scores, most recent first:") plus one
    // paragraph per attempt.
    expect(items).toHaveLength(3);
    // newest-first ordering (85% listed before 70%).
    expect(items[1].textContent).toContain('score 85 percent');
    expect(items[2].textContent).toContain('score 70 percent');
  });

  /**
   * CONFIRMED (manual Narrator report, 2026-10-18): the <ul>/<li> version
   * of this list made Narrator announce "bullet" per attempt and stop
   * short of the score. Fix: no list markup at all.
   */
  it('exposes each attempt as a plain paragraph, not a list item — no "bullet" role to announce', () => {
    const el = render(trendsFor([70, 85]));
    expect(el.querySelector('.perf-trends__sr ul')).toBeNull();
    expect(el.querySelector('.perf-trends__sr li')).toBeNull();
    const items = el.querySelectorAll('.perf-trends__sr p');
    items.forEach((p) => {
      expect(p.getAttribute('role')).toBeNull();
      expect(p.getAttribute('tabindex')).toBeNull();
    });
  });

  it('includes the time-expired qualifier for an attempt that timed out', () => {
    const el = render(trendsFor([70]));
    // trendsFor doesn't set completionReason directly; verify the method
    // itself produces the qualifier for that case.
    expect(
      fixture.componentInstance.srAttemptPhrase({
        id: 'att-x',
        index: 1,
        completedAt: '2026-07-20T10:00:00.000Z',
        score: 14,
        totalQuestions: 20,
        percentage: 70,
        completionReason: 'time-expired',
        isLatest: false
      })
    ).toBe('July 20, 2026, score 70 percent, time expired.');
  });

  it('23. the chart scales with its container (viewBox, no fixed pixel width)', () => {
    const el = render(trendsFor([70, 76, 82, 88]));
    const svg = el.querySelector('.perf-chart__svg') as SVGElement;
    expect(svg.getAttribute('viewBox')).toBe('0 0 320 150');
    // Responsive: no hard-coded width/height attribute (CSS sets width:100%).
    expect(svg.getAttribute('width')).toBeNull();
    expect(svg.getAttribute('height')).toBeNull();
  });

  it('renders the change metric with a signed percentage-point label', () => {
    const el = render(trendsFor([70, 76]));
    const change = el.querySelector('.perf-metrics__change--up');
    expect(change?.textContent).toContain('+6 pts');
    expect(change?.getAttribute('aria-hidden')).toBe('true');
  });

  /**
   * CONFIRMED (manual Narrator Scan Mode report, 2026-10-18): each metric's
   * label and value were read as two separate stops. Fix: one combined
   * "Label, value" phrase per row — the same technique already confirmed
   * for Interview Results' stat-grid.
   */
  describe('each metric reads as one combined "Label, value" phrase', () => {
    const groupPhrase = (el: HTMLElement, i: number): string | null =>
      el.querySelectorAll('.perf-metrics > div')[i]
        ?.querySelector('.visually-hidden-overlay')?.textContent?.trim() ?? null;

    it('groups Latest/Best/Average with their percentage values', () => {
      const el = render(trendsFor([70, 76, 82]));
      const rows = el.querySelectorAll('.perf-metrics > div');
      expect(rows.length).toBe(4);
      rows.forEach((row) => expect(row.getAttribute('role')).toBe('group'));
      expect(groupPhrase(el, 0)).toBe('Latest, 82 percent');
      expect(groupPhrase(el, 1)).toBe('Best, 82 percent');
      expect(groupPhrase(el, 2)).toBe('Average, 76 percent');
    });

    it('groups a positive Change with "up N points"', () => {
      const el = render(trendsFor([70, 76]));
      expect(groupPhrase(el, 3)).toBe('Change, up 6 points');
    });

    it('groups a negative Change with "down N points"', () => {
      const el = render(trendsFor([76, 70]));
      expect(groupPhrase(el, 3)).toBe('Change, down 6 points');
    });

    it('groups a zero Change exactly as "Change, 0 points"', () => {
      const el = render(trendsFor([70, 70]));
      expect(groupPhrase(el, 3)).toBe('Change, 0 points');
    });

    it('hides the real dt/dd from the accessibility tree so nothing is spoken twice', () => {
      const el = render(trendsFor([70, 76]));
      el.querySelectorAll('.perf-metrics dt, .perf-metrics dd').forEach((node) => {
        expect(node.getAttribute('aria-hidden')).toBe('true');
      });
    });

    it('does not change the visible metric text', () => {
      const el = render(trendsFor([70, 76]));
      expect(el.querySelector('.perf-metrics__latest')?.textContent?.trim()).toBe('76%');
    });

    it('leaves the New Personal Best badge separately readable (not hidden inside the group)', () => {
      const el = render(trendsFor([70, 80, 92]));
      const pb = el.querySelector('.perf-metrics__pb');
      expect(pb?.getAttribute('aria-hidden')).toBeNull();
      expect(pb?.getAttribute('role')).toBe('status');
      expect(pb?.textContent).toContain('New Personal Best!');
    });

    it('introduces no new tabindex or live regions on the grouped rows', () => {
      const el = render(trendsFor([70, 76]));
      el.querySelectorAll('[role="group"], .visually-hidden-overlay').forEach((node) => {
        expect(node.getAttribute('tabindex')).toBeNull();
        expect(node.getAttribute('aria-live')).toBeNull();
      });
    });
  });

  it('shows the improving interpretation for a +5-or-more jump', () => {
    const el = render(trendsFor([70, 82]));
    expect(el.querySelector('.perf-trends__interp')?.textContent).toContain('improving');
  });

  it('shows the New Personal Best badge when the latest beats every previous attempt', () => {
    const el = render(trendsFor([70, 80, 92]));
    const pb = el.querySelector('.perf-metrics__pb');
    expect(pb).not.toBeNull();
    expect(pb?.textContent).toContain('New Personal Best!');
  });

  it('hides the New Personal Best badge on a tie with the prior best', () => {
    const el = render(trendsFor([90, 70, 90]));
    expect(el.querySelector('.perf-metrics__pb')).toBeNull();
  });

  it('hides the New Personal Best badge when the latest is not the highest', () => {
    const el = render(trendsFor([95, 80]));
    expect(el.querySelector('.perf-metrics__pb')).toBeNull();
  });

  it('sparsely labels the x-axis for a full 20-attempt window', () => {
    const pcts = Array.from({ length: 20 }, (_, i) => 50 + (i % 10));
    const el = render(trendsFor(pcts));
    const xLabels = el.querySelectorAll('.perf-chart__xlabel');
    // Never one-per-point (would crowd); endpoints always labelled.
    expect(xLabels.length).toBeGreaterThan(1);
    expect(xLabels.length).toBeLessThanOrEqual(9);
  });
});
