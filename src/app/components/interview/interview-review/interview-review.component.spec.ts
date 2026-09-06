import { ComponentFixture, TestBed } from '@angular/core/testing';

import { InterviewReviewComponent } from './interview-review.component';
import {
  countReviewStatuses,
  getReviewOptionLabel,
  getReviewOptionState,
  joinWithAnd
} from './interview-review-status';
import type {
  InterviewResultViewModel,
  InterviewReviewQuestionViewModel
} from '../../../shared/models/interview/interview-view-models';

/**
 * Review renders the FROZEN backend review data.
 *
 * Correctness comes from `selectedOptionIds` vs `correctOptionIds` — there is
 * no `correct` flag on an option and no local re-scoring. Question and option
 * order are the server's.
 */

// Q1 single (A correct, answered correctly)
// Q2 multiple (C+E correct, answered C only → incorrect)
// Q3 true/false (True correct, unanswered)
const QUESTIONS: InterviewReviewQuestionViewModel[] = [
  {
    questionId: 'q1', sourceQuizId: 'rxjs', questionText: 'Q1', type: 'single',
    options: [{ optionId: 1, text: 'A' }, { optionId: 2, text: 'B' }],
    selectedOptionIds: [1], correctOptionIds: [1], explanation: 'E1',
    isCorrect: true, isAnswered: true
  },
  {
    questionId: 'q2', sourceQuizId: 'signals', questionText: 'Q2', type: 'multiple',
    options: [{ optionId: 3, text: 'C' }, { optionId: 4, text: 'D' }, { optionId: 5, text: 'E' }],
    selectedOptionIds: [3], correctOptionIds: [3, 5], explanation: 'E2',
    isCorrect: false, isAnswered: true
  },
  {
    questionId: 'q3', sourceQuizId: 'rxjs', questionText: 'Q3', type: 'trueFalse',
    options: [{ optionId: 6, text: 'True' }, { optionId: 7, text: 'False' }],
    selectedOptionIds: [], correctOptionIds: [6], explanation: '',
    isCorrect: false, isAnswered: false
  }
];

function result(over: Partial<InterviewResultViewModel> = {}): InterviewResultViewModel {
  return {
    sessionId: 'is_1', submittedAtMs: 1_700_000_000_000, submittedByExpiry: false,
    total: 3, answered: 2, unanswered: 1, correct: 1, incorrect: 1, percentage: 33,
    durationSeconds: 900, timeUsedSeconds: 300,
    config: { mode: 'custom', difficulty: 'mixed', topicIds: ['rxjs'], questionCount: 3 },
    byTopic: [
      { topicId: 'rxjs', title: 'RxJS', correct: 1, incorrect: 0, unanswered: 1, total: 2, percentage: 50 },
      { topicId: 'signals', title: 'Signals', correct: 0, incorrect: 1, unanswered: 0, total: 1, percentage: 0 }
    ],
    review: QUESTIONS,
    ...over
  };
}

// ── pure helpers ──────────────────────────────────────────────────────
describe('interview-review-status helpers', () => {
  it('option state from correctness + selection', () => {
    expect(getReviewOptionState(true, true)).toBe('correct-selected');
    expect(getReviewOptionState(false, true)).toBe('incorrect-selected');
    expect(getReviewOptionState(true, false)).toBe('correct-missed');
    expect(getReviewOptionState(false, false)).toBe('neutral');
  });

  it('option labels are descriptive text (not colour-only)', () => {
    expect(getReviewOptionLabel('correct-selected')).toContain('Correct');
    expect(getReviewOptionLabel('incorrect-selected')).toContain('Incorrect');
    expect(getReviewOptionLabel('correct-missed')).toBe('Correct answer');
    expect(getReviewOptionLabel('neutral')).toBe('');
  });

  it('grammatical list join', () => {
    expect(joinWithAnd(['C', 'E'])).toBe('C and E');
    expect(joinWithAnd(['A', 'B', 'C'])).toBe('A, B and C');
    expect(joinWithAnd(['A'])).toBe('A');
    expect(joinWithAnd([])).toBe('');
  });

  it('status counts sum to total', () => {
    const c = countReviewStatuses(['correct', 'incorrect', 'unanswered', 'correct']);
    expect(c).toEqual({ correct: 2, incorrect: 1, unanswered: 1, total: 4 });
    expect(c.correct + c.incorrect + c.unanswered).toBe(c.total);
  });

  it('no helper reads a per-option correctness flag any more', () => {
    const status = jest.requireActual('./interview-review-status') as Record<string, unknown>;
    expect(status['getReviewQuestionStatus']).toBeUndefined();
    expect(status['getCorrectAnswerLabels']).toBeUndefined();
    expect(status['getReviewQuestionType']).toBeUndefined();
  });
});

// ── component ─────────────────────────────────────────────────────────
describe('InterviewReviewComponent', () => {
  let fixture: ComponentFixture<InterviewReviewComponent>;
  let component: InterviewReviewComponent;

  function setup(
    questions: InterviewReviewQuestionViewModel[] = QUESTIONS,
    res: InterviewResultViewModel | null = result(),
    flaggingEnabled = false
  ) {
    fixture = TestBed.createComponent(InterviewReviewComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('questions', questions);
    fixture.componentRef.setInput('result', res);
    fixture.componentRef.setInput('flaggingEnabled', flaggingEnabled);
    fixture.detectChanges();
  }

  const el = () => fixture.nativeElement as HTMLElement;
  const itemEls = () => Array.from(el().querySelectorAll('.rv-item')) as HTMLElement[];
  const chipIds = () =>
    Array.from(el().querySelectorAll('.rv-filter')).map((b) =>
      (b as HTMLElement).getAttribute('aria-label')!.split(',')[0].toLowerCase()
    );

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [InterviewReviewComponent] }).compileComponents();
  });

  it('takes status from the SERVER, not from local scoring', () => {
    setup();
    expect(component.items().map((i) => i.status)).toEqual(['correct', 'incorrect', 'unanswered']);
  });

  it('derives option display state from selectedOptionIds vs correctOptionIds', () => {
    setup();
    const q2 = component.items()[1]!;
    expect(q2.options.find((o) => o.text === 'C')!.state).toBe('correct-selected');
    expect(q2.options.find((o) => o.text === 'E')!.state).toBe('correct-missed');
    expect(q2.options.find((o) => o.text === 'D')!.state).toBe('neutral');
    expect(q2.correctSummary).toBe('C and E');
  });

  it('renders question text, explanation, type and the unanswered message', () => {
    setup();
    expect(el().textContent).toContain('Multiple answer');
    expect(el().querySelector('.rv-explanation__heading')?.textContent).toContain('Explanation');
    expect(el().textContent).toContain('E2');
    expect(el().querySelector('.rv-unanswered')?.textContent).toContain('did not answer');
  });

  it('uses the FROZEN backend topic titles', () => {
    setup();
    expect(component.items().map((i) => i.topicName)).toEqual(['RxJS', 'Signals', 'RxJS']);
  });

  it('preserves the server question and option order — no re-sort, no AOTA re-pin', () => {
    const withAota: InterviewReviewQuestionViewModel[] = [{
      ...QUESTIONS[0]!,
      options: [
        { optionId: 1, text: 'All of the above' },
        { optionId: 2, text: 'B' },
        { optionId: 3, text: 'C' }
      ]
    }];
    setup(withAota);
    expect(component.items()[0]!.options.map((o) => o.text)).toEqual(['All of the above', 'B', 'C']);
  });

  it('summary uses the backend result as the source of truth', () => {
    setup(QUESTIONS, result({ correct: 5, incorrect: 4, unanswered: 2, total: 11 }));
    expect(component.summary()).toMatchObject({ correct: 5, incorrect: 4, unanswered: 2, total: 11 });
    const dds = Array.from(el().querySelectorAll('.rv-summary dd')).map((d) => d.textContent?.trim());
    expect(dds).toEqual(['5 / 11', '5', '4', '2']);
  });

  it('summary falls back to the per-question tally when no result is supplied', () => {
    setup(QUESTIONS, null);
    expect(component.summary()).toEqual({ correct: 1, incorrect: 1, unanswered: 1, total: 3 });
  });

  it('shows the difficulty chip only for a CUSTOM interview', () => {
    setup(QUESTIONS, result());
    expect(el().querySelector('.rv-meta')?.textContent).toContain('Mixed');

    // A role preset mixes difficulties, so no chip is shown at all.
    setup(QUESTIONS, result({
      config: { mode: 'preset', presetId: 'junior', topicIds: ['rxjs'], questionCount: 3 }
    }));
    expect(el().querySelector('.rv-meta')?.textContent).not.toContain('Mixed');
  });

  // ── filters ─────────────────────────────────────────────────────────
  it('filter counts + order (All / Incorrect / Unanswered / Correct)', () => {
    setup();
    expect(chipIds()).toEqual(['all', 'incorrect', 'unanswered', 'correct']);
    expect(component.counts()).toEqual({ all: 3, incorrect: 1, unanswered: 1, correct: 1, flagged: 0 });
  });

  it('each filter shows only its questions, preserving order', () => {
    const allIncorrect = QUESTIONS.map((q, i) =>
      i === 0 ? q : { ...q, isCorrect: false, isAnswered: true, selectedOptionIds: [q.options[1]!.optionId] }
    );
    setup(allIncorrect);
    component.setFilter('incorrect');
    fixture.detectChanges();
    expect(component.filtered().map((i) => i.number)).toEqual([2, 3]);
    component.setFilter('correct');
    fixture.detectChanges();
    expect(itemEls().length).toBe(1);
  });

  it('an empty filter result shows a friendly state', () => {
    const allCorrect = QUESTIONS.map((q) => ({
      ...q, isCorrect: true, isAnswered: true, selectedOptionIds: [...q.correctOptionIds]
    }));
    setup(allCorrect);
    component.setFilter('incorrect');
    fixture.detectChanges();
    expect(itemEls().length).toBe(0);
    expect(el().querySelector('.rv-empty')?.textContent).toContain('No incorrect answers.');
  });

  it('switching filters never mutates the input data', () => {
    const snapshot = JSON.stringify(QUESTIONS);
    setup();
    component.setFilter('incorrect');
    fixture.detectChanges();
    component.setFilter('all');
    fixture.detectChanges();
    expect(JSON.stringify(QUESTIONS)).toBe(snapshot);
  });

  // ── accessibility ───────────────────────────────────────────────────
  it('filters use role=radio + aria-checked + singular/plural accessible names', () => {
    setup();
    const chips = Array.from(el().querySelectorAll('.rv-filter')) as HTMLElement[];
    expect(chips.every((c) => c.getAttribute('role') === 'radio')).toBe(true);
    expect(chips.filter((c) => c.getAttribute('aria-checked') === 'true')).toHaveLength(1);
    expect(chips.find((c) => c.getAttribute('aria-label')?.startsWith('Correct'))!.getAttribute('aria-label'))
      .toBe('Correct, 1 question');
    expect(chips.find((c) => c.getAttribute('aria-label')?.startsWith('Unanswered'))!.getAttribute('aria-label'))
      .toBe('Unanswered, 1 question');
  });

  // ── Angular Aria Toolbar prototype ─────────────────────────────────────
  it('only ONE filter chip participates in the initial Tab order (native roving tabindex)', async () => {
    setup();
    // ngToolbar establishes its default active/roving-tabindex item via
    // afterRenderEffect, which flushes on the next render pass rather than
    // synchronously within setup()'s detectChanges().
    await fixture.whenStable();
    fixture.detectChanges();

    const chips = Array.from(el().querySelectorAll('.rv-filter')) as HTMLButtonElement[];
    expect(chips.filter((c) => c.tabIndex === 0)).toHaveLength(1);
  });

  it('mouse click on the "Correct" chip updates filter, aria-checked, and the rendered list', async () => {
    setup();
    await fixture.whenStable();
    fixture.detectChanges();

    const correctChip = Array.from(el().querySelectorAll('.rv-filter')).find((c) =>
      c.getAttribute('aria-label')?.startsWith('Correct')
    ) as HTMLButtonElement;
    correctChip.click();
    fixture.detectChanges();

    expect(component.filter()).toBe('correct');
    expect(correctChip.getAttribute('aria-checked')).toBe('true');
    expect(itemEls()).toHaveLength(1);
  });

  it('the ngToolbar valueChange path drives the SAME setFilter() a click always has', () => {
    setup();
    const spy = jest.spyOn(component, 'setFilter');

    component.onFilterToolbarChange(['incorrect']);

    expect(spy).toHaveBeenCalledWith('incorrect');
    expect(component.filter()).toBe('incorrect');
  });

  it('read-only options are list items, not buttons/radios/checkboxes', () => {
    setup();
    expect(el().querySelector('.rv-option')?.tagName).toBe('LI');
    expect(el().querySelectorAll('.rv-option button, .rv-option input')).toHaveLength(0);
  });

  it('decorative marks are hidden from assistive tech', () => {
    setup();
    for (const mark of Array.from(el().querySelectorAll('.rv-badge__mark, .rv-option__mark'))) {
      expect(mark.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('hides the Flagged chip until flagging is enabled', () => {
    setup();
    expect(chipIds()).toEqual(['all', 'incorrect', 'unanswered', 'correct']);
  });

  it('embedded mode hides the header meta but keeps the review list', () => {
    setup();
    expect(el().querySelector('.rv-meta')).not.toBeNull();
    fixture.componentRef.setInput('embedded', true);
    fixture.detectChanges();
    expect(el().querySelector('.rv-meta')).toBeNull();
    expect(itemEls().length).toBeGreaterThan(0);
  });
});
