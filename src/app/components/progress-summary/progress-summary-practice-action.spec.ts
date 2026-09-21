import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { signal } from '@angular/core';

import { ProgressSummaryComponent } from './progress-summary.component';
import { ProgressSummary } from '../../shared/models/progress.model';
import { WeakAreasService } from '../../shared/services/progress/weak-areas.service';
import { PracticeSessionService } from '../../shared/services/features/practice/practice-session.service';
import { WeakTopic } from '../../shared/utils/weak-areas';

function summary(overrides: Partial<ProgressSummary> = {}): ProgressSummary {
  return {
    completedCount: 2,
    totalCount: 5,
    completionPercentage: 40,
    byDifficulty: [],
    strongestQuiz: null,
    weakestQuiz: null,
    averageScore: 60,
    perfectScores: 0,
    questionsCompleted: 20,
    ...overrides
  };
}

const WEAK: WeakTopic[] = [
  {
    topicId: 'rxjs', topicName: 'RxJS', percentage: 42.4,
    correct: 7, incorrect: 10, total: 17, lastActivityAt: '2026-07-30T00:00:00.000Z'
  },
  {
    topicId: 'signals', topicName: 'Signals', percentage: 61.1,
    correct: 11, incorrect: 7, total: 18, lastActivityAt: '2026-07-29T00:00:00.000Z'
  }
];

const weakTopics = signal<WeakTopic[]>([]);
const insufficient = signal(false);
const startResult = signal(true);

const weakAreasStub = {
  weakTopics,
  hasWeakTopics: signal(true),
  hasInsufficientData: insufficient,
  weakTopicIds: signal<string[]>([])
} as unknown as WeakAreasService;

const start = jest.fn(() => startResult());
const practiceStub = { start } as unknown as PracticeSessionService;

/**
 * The highlights block (which hosts Needs Review) renders when there is a
 * strongest/weakest quiz OR weak topics. Supplying a strongest quiz lets the
 * NO-weak-topics states be asserted at all.
 */
const WITH_HIGHLIGHTS = {
  strongestQuiz: { milestone: 'Components', bestScore: 90 }
} as Partial<ProgressSummary>;

function mount(overrides: Partial<ProgressSummary> = {}): ComponentFixture<ProgressSummaryComponent> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [ProgressSummaryComponent],
    providers: [
      provideRouter([]),
      { provide: WeakAreasService, useValue: weakAreasStub },
      { provide: PracticeSessionService, useValue: practiceStub }
    ]
  });
  const fixture = TestBed.createComponent(ProgressSummaryComponent);
  fixture.componentRef.setInput('summary', summary(overrides));
  fixture.detectChanges();
  return fixture;
}

function action(fixture: ComponentFixture<ProgressSummaryComponent>): HTMLButtonElement | null {
  return fixture.nativeElement.querySelector('.progress-summary__practice');
}

function text(fixture: ComponentFixture<ProgressSummaryComponent>): string {
  return (fixture.nativeElement.textContent as string).replace(/\s+/g, ' ');
}

describe('Practice Weak Areas action — activation', () => {
  beforeEach(() => {
    start.mockClear();
    startResult.set(true);
    weakTopics.set([]);
    insufficient.set(false);
  });

  it('is RENDERED whenever there are weak topics — no feature flag remains', () => {
    weakTopics.set(WEAK);
    const fixture = mount();
    expect(action(fixture)).not.toBeNull();
  });

  it('is ABSENT (not disabled) when there is not enough data yet', () => {
    insufficient.set(true);
    const fixture = mount(WITH_HIGHLIGHTS);
    expect(action(fixture)).toBeNull();
    expect(text(fixture)).toContain('Complete a quiz or interview to identify weak areas.');
  });

  it('is ABSENT (not disabled) when nothing is weak', () => {
    const fixture = mount(WITH_HIGHLIGHTS);
    expect(action(fixture)).toBeNull();
    expect(text(fixture)).toContain('No weak areas detected.');
  });

  it('names the SAME topics the generator will draw from', () => {
    weakTopics.set(WEAK);
    const fixture = mount();
    const body = text(fixture);
    expect(body).toContain('RxJS');
    expect(body).toContain('Signals');
    expect(action(fixture)!.getAttribute('aria-label')).toBe('Practice weak areas: RxJS, Signals');
  });

  it('rounds the displayed percentages', () => {
    weakTopics.set(WEAK);
    const fixture = mount();
    expect(text(fixture)).toContain('42%');
    expect(text(fixture)).not.toContain('42.4');
  });
});

describe('Needs Review — one topic per row', () => {
  const THREE: WeakTopic[] = [
    { topicId: 'signals', topicName: 'Angular Signals', percentage: 33.3, correct: 3, incorrect: 6, total: 9, lastActivityAt: '2026-07-30T00:00:00.000Z' },
    { topicId: 'http', topicName: 'Angular HTTP', percentage: 66.7, correct: 2, incorrect: 1, total: 3, lastActivityAt: '2026-07-29T00:00:00.000Z' },
    { topicId: 'di', topicName: 'Dependency Injection', percentage: 72, correct: 18, incorrect: 7, total: 25, lastActivityAt: '2026-07-28T00:00:00.000Z' }
  ];

  beforeEach(() => {
    start.mockClear();
    startResult.set(true);
    insufficient.set(false);
  });

  const items = (fixture: ComponentFixture<ProgressSummaryComponent>): HTMLElement[] =>
    Array.from(fixture.nativeElement.querySelectorAll('.progress-summary__weak-list > .progress-summary__weak-topic'));

  it('renders several weak topics as separate list items, not run-on inline text', () => {
    // The reported defect was bare inline <span>s with no rule, flowing onto one
    // line. Jest strips component CSS and jsdom has no layout, so what CAN be
    // pinned here is the semantic structure (a <ul> of <li>s); the stylesheet's
    // effect — one topic per line — is checked in a real browser.
    weakTopics.set(THREE);
    const fixture = mount();

    const list = fixture.nativeElement.querySelector('.progress-summary__weak-list') as HTMLElement;
    expect(list.tagName).toBe('UL');
    expect(items(fixture)).toHaveLength(3);
    expect(items(fixture).every((li) => li.tagName === 'LI')).toBe(true);
  });

  it('gives each item exactly its own "name — NN%" and nothing from its neighbours', () => {
    weakTopics.set(THREE);
    const fixture = mount();

    expect(items(fixture).map((li) => (li.textContent ?? '').trim())).toEqual([
      'Angular Signals — 33%',
      'Angular HTTP — 67%',
      'Dependency Injection — 72%'
    ]);
  });

  it('keeps the same order the Weak Areas service returned (weakest first)', () => {
    weakTopics.set(THREE);
    const fixture = mount();
    expect(items(fixture).map((li) => li.textContent!.split(' — ')[0]))
      .toEqual(['Angular Signals', 'Angular HTTP', 'Dependency Injection']);
  });

  it('still renders a single weak topic as a one-item list', () => {
    weakTopics.set([THREE[0]]);
    const fixture = mount();
    expect(items(fixture)).toHaveLength(1);
    expect((items(fixture)[0].textContent ?? '').trim()).toBe('Angular Signals — 33%');
  });

  it('leaves the Practice action and its accessible label exactly as they were', () => {
    weakTopics.set(THREE);
    const fixture = mount();
    expect(action(fixture)).not.toBeNull();
    expect(action(fixture)!.textContent!.trim()).toBe('Practice Weak Areas');
    expect(action(fixture)!.getAttribute('aria-label'))
      .toBe('Practice weak areas: Angular Signals, Angular HTTP, Dependency Injection');
  });
});

describe('Practice Weak Areas action — never navigates into an empty session', () => {
  beforeEach(() => {
    start.mockClear();
    startResult.set(true);
    weakTopics.set(WEAK);
    insufficient.set(false);
  });

  it('GENERATES the session before navigating', async () => {
    const fixture = mount();
    const navigate = jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    await fixture.componentInstance.startPractice();

    expect(start).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/practice/weak-areas']);
    // Generation must come first — the guard bounces a bare link.
    expect(start.mock.invocationCallOrder[0]).toBeLessThan(navigate.mock.invocationCallOrder[0]);
  });

  it('does NOT navigate when generation yields nothing', async () => {
    startResult.set(false);
    const fixture = mount();
    const navigate = jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    await fixture.componentInstance.startPractice();

    expect(start).toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('clicking the rendered button runs the same guarded path', async () => {
    const fixture = mount();
    const navigate = jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    action(fixture)!.click();
    await fixture.whenStable();

    expect(start).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/practice/weak-areas']);
  });
});
