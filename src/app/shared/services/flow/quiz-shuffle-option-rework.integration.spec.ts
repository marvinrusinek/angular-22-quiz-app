/**
 * OPTION-SHUFFLE REWORK — invariant harness.
 *
 * Pins the contract that must hold for option shuffling to be safe. Written
 * BEFORE the fix, so the failing tests document exactly what's broken today:
 *
 *   (A) optionId must be STABLE — it travels with the option regardless of
 *       display position, and re-running assignOptionIds must NOT renumber an
 *       option that already has an id. (QuizShuffleService.assignOptionIds
 *       currently overwrites by position → fails I-A2.)
 *   (B) The FET/feedback "Option N" number must reflect the DISPLAYED position,
 *       i.e. getCorrectOptionIndices over the shuffled options returns the
 *       display index of each correct option. (resolveOptionsForCorrectness
 *       currently swaps in the ORIGINAL options → fails I-B1.)
 *   (C) Correctness travels with the option — the correct option stays flagged
 *       correct at its new position, so scoring/resolution still works.
 *
 * ArrayUtils.shuffleArray is stubbed to REVERSE, giving a deterministic non-identity
 * permutation so we can assert exact positions.
 */
import { QuizShuffleService } from './quiz-shuffle.service';
import { QuizQuestion } from '@shared/models/QuizQuestion.model';
import { ArrayUtils } from '@shared/utils/array-utils';

function makeQuestions(): QuizQuestion[] {
  return [
    {
      questionText: 'Q1',
      // Correct option is FIRST originally so a reverse shuffle clearly moves it.
      options: [
        { text: 'Alpha', correct: true },
        { text: 'Bravo', correct: false },
        { text: 'Charlie', correct: false }
      ],
      explanation: 'Alpha is the answer.'
    } as unknown as QuizQuestion
  ];
}

describe('Option-shuffle rework — invariants', () => {
  let svc: QuizShuffleService;
  const QUIZ_ID = 'rework-quiz';

  beforeEach(() => {
    localStorage.clear();
    svc = new QuizShuffleService();
    // Deterministic, non-identity permutation: reverse.
    jest.spyOn(ArrayUtils, 'shuffleArray').mockImplementation((a: any[]) => [...a].reverse());
  });

  afterEach(() => {
    (ArrayUtils.shuffleArray as jest.Mock).mockRestore?.();
    localStorage.clear();
  });

  it('I-C1: options are actually shuffled (reversed) and correctness travels', () => {
    const qs = makeQuestions();
    svc.prepareShuffle(QUIZ_ID, qs, { shuffleQuestions: false, shuffleOptions: true });
    const [shuffled] = svc.buildShuffledQuestions(QUIZ_ID, qs);

    // Reverse of [Alpha, Bravo, Charlie] → [Charlie, Bravo, Alpha]
    expect(shuffled.options.map(o => o.text)).toEqual(['Charlie', 'Bravo', 'Alpha']);

    // The correct option ('Alpha') is now LAST but still flagged correct.
    const alpha = shuffled.options.find(o => o.text === 'Alpha')!;
    expect(alpha.correct).toBe(true);
    expect(shuffled.options[2].text).toBe('Alpha');
    expect(shuffled.options[2].correct).toBe(true);
  });

  it('I-A1: each option keeps a stable optionId after the reorder (id ≠ display position)', () => {
    const qs = makeQuestions();
    svc.prepareShuffle(QUIZ_ID, qs, { shuffleQuestions: false, shuffleOptions: true });
    const [shuffled] = svc.buildShuffledQuestions(QUIZ_ID, qs);

    // 'Alpha' was original position 0 → id ...01, and must keep it even though
    // it now displays at position 2.
    const alpha = shuffled.options.find(o => o.text === 'Alpha')!;
    expect(alpha.optionId).toBe(101);
    expect(shuffled.options[2].optionId).toBe(101); // display-pos 2 holds id 101
  });

  it('I-A2: assignOptionIds is IDEMPOTENT — re-running on the displayed array must NOT renumber by position', () => {
    const qs = makeQuestions();
    svc.prepareShuffle(QUIZ_ID, qs, { shuffleQuestions: false, shuffleOptions: true });
    const [shuffled] = svc.buildShuffledQuestions(QUIZ_ID, qs);

    const before = shuffled.options.map(o => o.optionId);
    // A downstream pipeline stage re-stamps ids on the already-shuffled array.
    const reassigned = svc.assignOptionIds(shuffled.options, 0);
    const after = reassigned.map(o => o.optionId);

    // Same options, same ids — position must not change the id.
    expect(after).toEqual(before);
    // And 'Alpha' must still be 101, not renumbered to its display position (103).
    expect(reassigned.find(o => o.text === 'Alpha')!.optionId).toBe(101);
  });

  it('I-A3: navigation does not reshuffle — same option order on every build', () => {
    const qs = makeQuestions();
    svc.prepareShuffle(QUIZ_ID, qs, { shuffleQuestions: false, shuffleOptions: true });
    const first = svc.buildShuffledQuestions(QUIZ_ID, qs)[0].options.map(o => o.text);
    // Re-preparing (as happens on each navigation) must be a no-op for the order.
    svc.prepareShuffle(QUIZ_ID, qs, { shuffleQuestions: false, shuffleOptions: true });
    const second = svc.buildShuffledQuestions(QUIZ_ID, qs)[0].options.map(o => o.text);
    expect(second).toEqual(first);
  });
});
