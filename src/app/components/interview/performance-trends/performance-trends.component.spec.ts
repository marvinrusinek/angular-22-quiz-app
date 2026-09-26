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
    expect(el.querySelector('.perf-trends__empty')?.textContent).toContain('first recorded interview');
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
    const items = el.querySelectorAll('.perf-trends__sr li');
    expect(items).toHaveLength(2);
    // "out of" phrasing + newest-first ordering (85% listed before 70%).
    expect(items[0].textContent).toContain('out of');
    expect(items[0].textContent).toContain('85%');
    expect(items[1].textContent).toContain('70%');
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
    expect(change?.getAttribute('aria-label')).toContain('percentage points');
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
