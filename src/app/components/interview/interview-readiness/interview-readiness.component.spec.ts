import { ComponentFixture, TestBed } from '@angular/core/testing';

import { InterviewReadiness } from '@shared/models';
import { InterviewReadinessComponent } from './interview-readiness.component';

function ready(over: Partial<InterviewReadiness> = {}): InterviewReadiness {
  return {
    status: 'ready',
    score: 84,
    band: 'strong',
    recentPerformance: 86,
    consistency: 78,
    rawConsistency: 90,
    topicCoverage: 70,
    topicStrength: 82,
    coverageAvailable: true,
    practicedTopicCount: 6,
    eligibleTopicCount: 8,
    strongestFactor: 'recent-performance',
    limitingFactor: 'topic-coverage',
    explanation: 'Your recent interview scores are strong. Topic coverage is currently limiting your readiness.',
    recommendations: ['Review Signals and HTTP.', 'Complete interviews covering additional Angular topics to broaden your coverage.'],
    attemptsUsed: 4,
    totalAttempts: 4,
    ...over
  };
}

function insufficient(): InterviewReadiness {
  return { ...ready(), status: 'insufficient', score: 0, totalAttempts: 1, attemptsUsed: 1, recommendations: [], explanation: '' };
}

describe('InterviewReadinessComponent', () => {
  let fixture: ComponentFixture<InterviewReadinessComponent>;

  function render(r: InterviewReadiness | null, compact = false): HTMLElement {
    fixture = TestBed.createComponent(InterviewReadinessComponent);
    fixture.componentRef.setInput('readiness', r);
    fixture.componentRef.setInput('compact', compact);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  beforeEach(() => TestBed.configureTestingModule({ imports: [InterviewReadinessComponent] }));

  it('renders nothing when readiness is null', () => {
    expect(render(null).querySelector('.readiness')).toBeNull();
  });

  it('27. displays the score and band', () => {
    const el = render(ready());
    expect(el.querySelector('.readiness__score')?.textContent).toContain('84');
    expect(el.querySelector('.readiness__band')?.textContent).toContain('Strong');
  });

  it('28. displays all four factor values', () => {
    const nums = Array.from(render(ready()).querySelectorAll('.readiness__factor-num')).map((n) =>
      n.textContent?.trim()
    );
    expect(nums).toEqual(['86', '78', '70', '82']);
  });

  it('displays the recommendations (at most two)', () => {
    const items = render(ready()).querySelectorAll('.readiness__recs-list li');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('Review');
  });

  it('29. displays the limited-data state for one attempt', () => {
    const el = render(insufficient());
    expect(el.querySelector('.readiness__limited')?.textContent).toContain('Complete at least one more interview');
    expect(el.querySelector('.readiness__limited-sub')?.textContent).toContain('first result has been recorded');
    expect(el.querySelector('.readiness__factors')).toBeNull();
  });

  it('30. includes an accessible readiness summary', () => {
    const el = render(ready());
    expect(el.querySelector('.readiness__sr')?.textContent).toContain('Interview readiness score: 84 out of 100');
    expect(el.querySelector('.readiness__sr')?.textContent).toContain('Strong');
    // Each bar has an accessible label (not colour-only).
    expect(el.querySelector('.readiness__bar')?.getAttribute('aria-label')).toContain('out of 100');
  });

  it('shows "Based on N completed interviews" for 2–4 attempts', () => {
    expect(render(ready({ totalAttempts: 3 })).querySelector('.readiness__basedon')?.textContent).toContain(
      'Based on 3 completed interviews'
    );
  });

  it('shows the 5-most-recent note for 5+ attempts', () => {
    expect(render(ready({ totalAttempts: 7 })).querySelector('.readiness__basedon')?.textContent).toContain(
      '5 most recent'
    );
  });

  it('surfaces a practiced-topic note when coverage is unavailable', () => {
    const el = render(ready({ coverageAvailable: false, practicedTopicCount: 4 }));
    expect(el.querySelector('.readiness__factor-note')?.textContent).toContain('4 topics practiced');
  });

  it('compact mode hides the factor breakdown and recommendations', () => {
    const el = render(ready(), true);
    expect(el.querySelector('.readiness--compact')).not.toBeNull();
    expect(el.querySelector('.readiness__score')?.textContent).toContain('84');
    expect(el.querySelector('.readiness__factors')).toBeNull();
    expect(el.querySelector('.readiness__recs')).toBeNull();
  });

  it('31/32. applies a band class (theme/contrast hook) without relying on colour alone', () => {
    // Band text label is always present; the class is only a styling hook.
    const el = render(ready({ band: 'interview-ready' }));
    expect(el.querySelector('.readiness--interview-ready')).not.toBeNull();
    expect(el.querySelector('.readiness__band')?.textContent).toContain('Interview Ready');
  });
});
