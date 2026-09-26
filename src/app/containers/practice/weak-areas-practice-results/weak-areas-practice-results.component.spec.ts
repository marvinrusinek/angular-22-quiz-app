import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { signal } from '@angular/core';

import { WeakAreasPracticeResultsComponent } from './weak-areas-practice-results.component';
import { PracticeSessionService } from '@shared/services/features/practice/practice-session.service';
import { WeakAreasService } from '@shared/services/progress/weak-areas.service';
import { PracticeResult } from '@shared/models';

const RESULT: PracticeResult = {
  sessionId: 'wap_test',
  completedAt: '2026-08-01T10:00:00.000Z',
  total: 3,
  answered: 2,
  unanswered: 1,
  correct: 1,
  incorrect: 2,
  percentage: 33,
  perTopic: [
    { topicId: 'rxjs', topicName: 'RxJS', correct: 1, total: 2, percentage: 50 },
    { topicId: 'signals', topicName: 'Signals', correct: 0, total: 1, percentage: 0 }
  ],
  review: [
    {
      index: 0,
      questionText: 'What is a subject?',
      topicId: 'rxjs',
      topicName: 'RxJS',
      selectedTexts: ['A multicast observable'],
      correctTexts: ['A multicast observable'],
      answered: true,
      isCorrect: true,
      explanation: 'CORRECT-FET'
    },
    {
      index: 1,
      questionText: 'Pick two operators',
      topicId: 'rxjs',
      topicName: 'RxJS',
      selectedTexts: ['map'],
      correctTexts: ['map', 'filter'],
      answered: true,
      isCorrect: false,
      explanation: 'PARTIAL-FET'
    },
    {
      index: 2,
      questionText: 'Signals are?',
      topicId: 'signals',
      topicName: 'Signals',
      selectedTexts: [],
      correctTexts: ['Reactive primitives'],
      answered: false,
      isCorrect: false,
      explanation: 'SKIPPED-FET'
    }
  ]
};

function makeStubs(options: { practiceAgainSucceeds?: boolean; hasWeak?: boolean } = {}) {
  const session = {
    result: signal<PracticeResult | null>(RESULT),
    ensureRecorded: jest.fn(),
    practiceAgain: jest.fn(() => options.practiceAgainSucceeds !== false),
    clear: jest.fn()
  };
  const weakAreas = { hasWeakTopics: signal(options.hasWeak !== false) };
  return { session, weakAreas };
}

type Stubs = ReturnType<typeof makeStubs>;

function mount(stubs: Stubs): ComponentFixture<WeakAreasPracticeResultsComponent> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [WeakAreasPracticeResultsComponent],
    providers: [
      provideRouter([]),
      { provide: PracticeSessionService, useValue: stubs.session },
      { provide: WeakAreasService, useValue: stubs.weakAreas }
    ]
  });
  const fixture = TestBed.createComponent(WeakAreasPracticeResultsComponent);
  fixture.detectChanges();
  return fixture;
}

function text(fixture: ComponentFixture<WeakAreasPracticeResultsComponent>): string {
  return (fixture.nativeElement.textContent as string).replace(/\s+/g, ' ');
}

describe('WeakAreasPracticeResultsComponent — overall score', () => {
  it('shows the percentage alongside the raw counts', () => {
    const fixture = mount(makeStubs());
    const body = text(fixture);
    expect(body).toContain('33%');
    expect(body).toContain('1 of 3 correct');
  });

  it('reports unanswered questions', () => {
    const fixture = mount(makeStubs());
    expect(text(fixture)).toContain('1 left unanswered');
  });

  it('omits the unanswered note when everything was answered', () => {
    const stubs = makeStubs();
    stubs.session.result.set({ ...RESULT, unanswered: 0 });
    const fixture = mount(stubs);
    expect(text(fixture)).not.toContain('left unanswered');
  });
});

describe('WeakAreasPracticeResultsComponent — per-topic breakdown', () => {
  it('lists each topic with its raw counts and percentage', () => {
    const fixture = mount(makeStubs());
    const rows = [...fixture.nativeElement.querySelectorAll('.wapr__topic')] as HTMLElement[];
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('RxJS');
    expect(rows[0].textContent).toContain('1/2');
    expect(rows[0].textContent).toContain('50%');
    expect(rows[1].textContent).toContain('Signals');
    expect(rows[1].textContent).toContain('0%');
  });
});

describe('WeakAreasPracticeResultsComponent — Answer Review', () => {
  it('renders one entry per question', () => {
    const fixture = mount(makeStubs());
    expect(fixture.nativeElement.querySelectorAll('.wapr__entry').length).toBe(3);
  });

  it('shows the question, its source topic and the result as TEXT', () => {
    const fixture = mount(makeStubs());
    const entries = [...fixture.nativeElement.querySelectorAll('.wapr__entry')] as HTMLElement[];

    expect(entries[0].textContent).toContain('What is a subject?');
    expect(entries[0].textContent).toContain('RxJS');
    expect(entries[0].textContent).toContain('Correct');

    expect(entries[1].textContent).toContain('Incorrect');
    expect(entries[2].textContent).toContain('Not answered');
  });

  it('shows the user selection and the COMPLETE correct set', () => {
    const fixture = mount(makeStubs());
    const partial = fixture.nativeElement.querySelectorAll('.wapr__entry')[1] as HTMLElement;
    const body = partial.textContent!.replace(/\s+/g, ' ');
    expect(body).toContain('Your answer');
    expect(body).toContain('map');
    expect(body).toContain('Correct answer');
    expect(body).toContain('filter');      // the missing half of a partial answer
  });

  it('states "No answer selected" for a skipped question', () => {
    const fixture = mount(makeStubs());
    const skipped = fixture.nativeElement.querySelectorAll('.wapr__entry')[2] as HTMLElement;
    expect(skipped.textContent).toContain('No answer selected');
  });

  it('shows the explanation for INCORRECT answers — the FET withheld during play', () => {
    const fixture = mount(makeStubs());
    const body = text(fixture);
    expect(body).toContain('PARTIAL-FET');
    expect(body).toContain('SKIPPED-FET');
    expect(body).toContain('CORRECT-FET');
  });
});

describe('WeakAreasPracticeResultsComponent — recording', () => {
  it('ensures the attempt is recorded on mount', () => {
    const stubs = makeStubs();
    mount(stubs);
    expect(stubs.session.ensureRecorded).toHaveBeenCalledTimes(1);
  });

  it('a REMOUNT calls the idempotent recorder again rather than a second write path', () => {
    const stubs = makeStubs();
    mount(stubs);
    mount(stubs);
    // Two mounts, two idempotent calls — dedup lives in the history service,
    // keyed by attemptId against persisted state.
    expect(stubs.session.ensureRecorded).toHaveBeenCalledTimes(2);
  });
});

describe('WeakAreasPracticeResultsComponent — Practice Again', () => {
  it('starts a new session and navigates when weak topics remain', async () => {
    const stubs = makeStubs({ practiceAgainSucceeds: true });
    const fixture = mount(stubs);
    const navigate = jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    await fixture.componentInstance.practiceAgain();

    expect(stubs.session.practiceAgain).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/practice/weak-areas']);
    expect(fixture.componentInstance.noWeakAreasRemaining()).toBe(false);
  });

  it('shows "No weak areas detected" instead of starting an empty session', async () => {
    const stubs = makeStubs({ practiceAgainSucceeds: false });
    const fixture = mount(stubs);
    const navigate = jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    await fixture.componentInstance.practiceAgain();
    fixture.detectChanges();

    expect(navigate).not.toHaveBeenCalled();
    expect(text(fixture)).toContain('No weak areas detected');
  });

  it('offers Back to Quizzes from the no-weak-areas state, and hides Practice Again', async () => {
    const stubs = makeStubs({ practiceAgainSucceeds: false });
    const fixture = mount(stubs);
    await fixture.componentInstance.practiceAgain();
    fixture.detectChanges();

    const buttons = [...fixture.nativeElement.querySelectorAll('.wapr__actions button')] as HTMLButtonElement[];
    const labels = buttons.map((b) => b.textContent!.trim());
    expect(labels).toContain('Back to Quizzes');
    expect(labels).not.toContain('Practice Again');
  });
});

describe('WeakAreasPracticeResultsComponent — Back to Quizzes', () => {
  it('clears the completed snapshot and replaces the history entry', async () => {
    const stubs = makeStubs();
    const fixture = mount(stubs);
    const navigate = jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    await fixture.componentInstance.backToQuizzes();

    expect(stubs.session.clear).toHaveBeenCalled();
    // replaceUrl keeps browser Back from returning to the finished session.
    expect(navigate).toHaveBeenCalledWith(['/quiz'], { replaceUrl: true });
  });
});
