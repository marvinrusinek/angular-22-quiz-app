import { TestBed } from '@angular/core/testing';

import { SK_COMPLETED_REVIEW } from '@shared/constants/session-keys';
import { CompletedReviewStoreService, clearCompletedReview } from './completed-review-store.service';
import type { ReviewReveal } from './review-reveal.service';

const RESULT = { quizId: 'angular', completedAt: 1_700_000_000_000 };
const reveal = (q: string, ...correct: string[]): ReviewReveal => ({
  questionText: q,
  correctOptionTexts: correct,
  explanation: `why ${q}`
});

describe('CompletedReviewStoreService', () => {
  let store: CompletedReviewStoreService;

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({});
    store = TestBed.inject(CompletedReviewStoreService);
  });
  afterEach(() => sessionStorage.clear());

  it('round-trips the reveals of one result, keyed by normalized question text', () => {
    store.save(RESULT, [reveal('Q One ', 'A'), reveal('Q2', 'B', 'C')]);
    const got = store.load(RESULT);
    expect([...got.keys()].sort()).toEqual(['q one', 'q2']);
    expect(got.get('q2')).toEqual({ questionText: 'Q2', correctOptionTexts: ['B', 'C'], explanation: 'why Q2' });
  });

  it('is scoped to one exact result: another quiz or another attempt reads nothing', () => {
    store.save(RESULT, [reveal('Q1', 'A')]);
    expect(store.load({ ...RESULT, quizId: 'rxjs' }).size).toBe(0);
    expect(store.load({ ...RESULT, completedAt: RESULT.completedAt + 1 }).size).toBe(0);
    expect(store.load(RESULT).size).toBe(1);
  });

  it('adds late reveals to the same result and keeps the earlier ones', () => {
    store.save(RESULT, [reveal('Q1', 'A')]);
    store.save(RESULT, [reveal('Q2', 'B')]);
    expect([...store.load(RESULT).keys()].sort()).toEqual(['q1', 'q2']);
  });

  it('writes nothing, and deletes nothing, when there is nothing valid to add', () => {
    store.save(RESULT, [reveal('Q1', 'A')]);
    const before = sessionStorage.getItem(SK_COMPLETED_REVIEW);
    store.save(RESULT, []);
    store.save(RESULT, [{ questionText: 'Q9', correctOptionTexts: [], explanation: '' }]);
    expect(sessionStorage.getItem(SK_COMPLETED_REVIEW)).toBe(before);
  });

  it('refuses malformed and oversized entries, and never throws on corrupt storage', () => {
    store.save(RESULT, [
      { questionText: '', correctOptionTexts: ['A'], explanation: '' },
      { questionText: 'ok', correctOptionTexts: [''], explanation: '' },
      { questionText: 'big', correctOptionTexts: ['x'.repeat(1_001)], explanation: '' },
      { questionText: 'many', correctOptionTexts: Array.from({ length: 13 }, (_, i) => `o${i}`), explanation: '' },
      { questionText: 'fat', correctOptionTexts: ['A'], explanation: 'e'.repeat(20_001) },
      { questionText: 'good', correctOptionTexts: ['A'], explanation: 'fine' }
    ]);
    expect([...store.load(RESULT).keys()]).toEqual(['good']);

    sessionStorage.setItem(SK_COMPLETED_REVIEW, '{broken');
    expect(store.load(RESULT).size).toBe(0);
    sessionStorage.setItem(SK_COMPLETED_REVIEW, JSON.stringify({ v: 2, quizId: 'angular', completedAt: RESULT.completedAt, reveals: [] }));
    expect(store.load(RESULT).size).toBe(0);
    sessionStorage.setItem(
      SK_COMPLETED_REVIEW,
      JSON.stringify({ v: 1, ...RESULT, reveals: [{ questionText: 'q', correctOptionTexts: 'A' }, 42, null] })
    );
    expect(store.load(RESULT).size).toBe(0);
  });

  it('caps the record at 200 reveals', () => {
    store.save(RESULT, Array.from({ length: 250 }, (_, i) => reveal(`Q${i}`, 'A')));
    expect(store.load(RESULT).size).toBe(200);
  });

  it('is removed by clear() and by the standalone clearCompletedReview()', () => {
    store.save(RESULT, [reveal('Q1', 'A')]);
    store.clear();
    expect(sessionStorage.getItem(SK_COMPLETED_REVIEW)).toBeNull();
    store.save(RESULT, [reveal('Q1', 'A')]);
    clearCompletedReview();
    expect(sessionStorage.getItem(SK_COMPLETED_REVIEW)).toBeNull();
  });
});
