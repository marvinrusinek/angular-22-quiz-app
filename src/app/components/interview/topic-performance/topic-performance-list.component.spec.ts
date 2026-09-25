import { ComponentFixture, TestBed } from '@angular/core/testing';

import { InterviewAnalytics, TopicPerformance } from '@shared/models/interview-analytics.model';
import { TopicPerformanceListComponent } from './topic-performance-list.component';

function tp(topicId: string, pct: number, band: TopicPerformance['band']): TopicPerformance {
  return { topicId, topicName: topicId.toUpperCase(), correct: pct, total: 100, percentage: pct, band };
}

function analytics(topics: TopicPerformance[], strong: TopicPerformance[] = [], weak: TopicPerformance[] = []): InterviewAnalytics {
  return { topics, strongestTopics: strong, weakestTopics: weak };
}

describe('TopicPerformanceListComponent', () => {
  let fixture: ComponentFixture<TopicPerformanceListComponent>;

  function render(a: InterviewAnalytics | null): HTMLElement {
    fixture = TestBed.createComponent(TopicPerformanceListComponent);
    fixture.componentRef.setInput('analytics', a);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  beforeEach(() => TestBed.configureTestingModule({ imports: [TopicPerformanceListComponent] }));

  it('renders a row per topic with an accessible label', () => {
    const el = render(analytics([tp('forms', 80, 'strong'), tp('http', 40, 'weak')]));
    const rows = el.querySelectorAll('.topic-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute('aria-label')).toContain('80 percent');
    expect(rows[0].className).toContain('topic-row--strong');
    expect(rows[1].className).toContain('topic-row--weak');
  });

  it('renders Strongest / Needs Review highlights when present', () => {
    const el = render(analytics(
      [tp('a', 90, 'strong'), tp('b', 30, 'weak')],
      [tp('a', 90, 'strong')],
      [tp('b', 30, 'weak')]
    ));
    expect(el.querySelector('#ir-strongest')?.textContent).toContain('Strongest');
    expect(el.querySelector('#ir-needs-review')?.textContent).toContain('Needs Review');
  });

  it('renders nothing for empty or null analytics', () => {
    expect(render(analytics([])).querySelector('.topic-row')).toBeNull();
    expect(render(null).querySelector('.topics-heading')).toBeNull();
  });
});
