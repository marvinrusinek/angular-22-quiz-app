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
    explanation:
      'Your recent interview scores are strong. Topic coverage is currently limiting your readiness.',
    recommendations: [
      'Review Signals and HTTP.',
      'Complete interviews covering additional Angular topics to broaden your coverage.'
    ],
    attemptsUsed: 4,
    totalAttempts: 4,
    ...over
  };
}

function insufficient(): InterviewReadiness {
  return {
    ...ready(),
    status: 'insufficient',
    score: 0,
    totalAttempts: 1,
    attemptsUsed: 1,
    recommendations: [],
    explanation: ''
  };
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
    expect(el.querySelector('.readiness__limited')?.textContent).toContain(
      'Complete at least one more interview'
    );
    expect(el.querySelector('.readiness__limited-sub')?.textContent).toContain(
      'first result has been recorded'
    );
    expect(el.querySelector('.readiness__factors')).toBeNull();
  });

  it('30. includes an accessible readiness summary, as one named object (not a separate hidden paragraph)', () => {
    const el = render(ready());
    const summary = el.querySelector('.readiness__summary')!;
    expect(summary.getAttribute('role')).toBe('img');
    const label = summary.getAttribute('aria-label')!;
    expect(label).toContain('Interview readiness score: 84 out of 100');
    expect(label).toContain('Strong');
    // The explanation is folded into the same phrase, not a separate stop.
    expect(label).toContain(
      'Your recent interview scores are strong. Topic coverage is currently limiting your readiness.'
    );
    // The visible pieces inside are hidden from the tree — spoken once, via
    // the summary's own aria-label, not again from their own text content.
    expect(el.querySelector('.readiness__score-row')?.getAttribute('aria-hidden')).toBe('true');
    expect(el.querySelector('.readiness__explanation')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('exposes one combined "label, value" phrase per factor row, with no duplicate label speech', () => {
    const el = render(ready());
    const rows = el.querySelectorAll('.readiness__factor');
    expect(rows.length).toBe(4);
    rows.forEach((row) => {
      expect(row.getAttribute('role')).toBe('group');
      expect(row.querySelector('.readiness__factor-label')?.getAttribute('aria-hidden')).toBe('true');
      expect(row.querySelector('.readiness__factor-value')?.getAttribute('aria-hidden')).toBe('true');
      expect(row.querySelector('.readiness__bar')?.getAttribute('role')).toBeNull();
    });
    const phrases = Array.from(rows).map(
      (row) => row.querySelector('.readiness__factor-hidden')!.textContent!.trim()
    );
    expect(phrases).toEqual([
      'Recent Performance: 86 out of 100',
      'Consistency: 78 out of 100',
      'Topic Coverage: 70 out of 100',
      'Topic Strength: 82 out of 100'
    ]);
  });

  it('combines the label and practiced-count note into one phrase when coverage is unavailable', () => {
    const el = render(ready({ coverageAvailable: false, practicedTopicCount: 4 }));
    const rows = el.querySelectorAll('.readiness__factor');
    const coverageRow = rows[2]; // Topic Coverage is the third factor
    expect(coverageRow.querySelector('.readiness__factor-hidden')!.textContent!.trim()).toBe(
      'Topic Coverage, 4 topics practiced'
    );
  });

  it('combines the limited-data sentences into one phrase for the insufficient-history state', () => {
    const el = render(insufficient());
    const summary = el.querySelector('.readiness__summary')!;
    expect(summary.getAttribute('role')).toBe('img');
    const label = summary.getAttribute('aria-label')!;
    expect(label).toContain('Complete at least one more interview to calculate your readiness score');
    expect(label).toContain('Your first result has been recorded');
    expect(el.querySelector('.readiness__limited')?.getAttribute('aria-hidden')).toBe('true');
    expect(el.querySelector('.readiness__limited-sub')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps "Interview Readiness" as a real, separately-navigable heading, outside the summary object', () => {
    const el = render(ready());
    const heading = el.querySelector('#readiness-heading')!;
    expect(heading.tagName).toBe('H2');
    expect(heading.textContent).toContain('Interview Readiness');
    expect(heading.closest('.readiness__summary')).toBeNull();
    expect(heading.getAttribute('aria-hidden')).toBeNull();
  });

  // CANDIDATE fix for a reported heading-splitting issue (see the .html
  // file's own comment) — unconfirmed without a live Narrator retest. Only
  // the name's SOURCE changes (attribute instead of content); everything
  // else about the heading (tag, visible text, role, level) stays the same.
  it('gives the heading an explicit aria-label matching its visible text, without changing its tag or role', () => {
    const el = render(ready());
    const heading = el.querySelector('#readiness-heading')!;
    expect(heading.tagName).toBe('H2');
    expect(heading.getAttribute('aria-label')).toBe('Interview Readiness');
    expect(heading.textContent).toBe('Interview Readiness');
  });

  it('names the section via the heading it contains (unchanged; a region/heading double-announcement theory was tried and ruled out by retest)', () => {
    const el = render(ready());
    const section = el.querySelector('section.readiness')!;
    expect(section.getAttribute('aria-labelledby')).toBe('readiness-heading');
    const heading = el.querySelector('#readiness-heading')!;
    expect(heading.tagName).toBe('H2');
    expect(heading.textContent).toBe('Interview Readiness');
  });

  it('introduces no new tabindex or live regions on the grouped objects', () => {
    const el = render(ready());
    el.querySelectorAll('[role="img"], [role="group"], .readiness__factor-hidden').forEach((node) => {
      expect(node.getAttribute('tabindex')).toBeNull();
      expect(node.getAttribute('aria-live')).toBeNull();
    });
  });

  it('shows "Based on N completed interviews" for 2–4 attempts', () => {
    expect(
      render(ready({ totalAttempts: 3 })).querySelector('.readiness__basedon')?.textContent
    ).toContain('Based on 3 completed interviews');
  });

  it('shows the 5-most-recent note for 5+ attempts', () => {
    expect(
      render(ready({ totalAttempts: 7 })).querySelector('.readiness__basedon')?.textContent
    ).toContain('5 most recent');
  });

  it('surfaces a practiced-topic note when coverage is unavailable', () => {
    const el = render(ready({ coverageAvailable: false, practicedTopicCount: 4 }));
    expect(el.querySelector('.readiness__factor-note')?.textContent).toContain(
      '4 topics practiced'
    );
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
