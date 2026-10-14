import {
  toDurableAnalysisItem,
  toDurableFinalResult,
  type FinalResult,
  type ScoreAnalysisItem
} from './Final-Result.model';

/**
 * DURABLE RESULT STORAGE must not become an answer cache.
 *
 * The authorized reveal — correct option texts and the explanation — is
 * legitimately on screen during Results/Review, and lives in memory for that
 * session. Writing it to browser storage is a different thing entirely: it
 * recreates, in every visitor's browser, exactly the answer key this migration
 * exists to remove from the bundle. A stored key is no better than a shipped
 * one, and it outlives the attempt that earned it.
 *
 * These tests assert on the SERIALIZED string, not the object, because that is
 * what actually reaches storage.
 */

const REVEALED_ANSWER = 'filter';
const EXPLANATION = 'map and filter are operators.';

const ITEM: ScoreAnalysisItem = {
  questionIndex: 0,
  questionText: 'Select every operator',
  wasCorrect: true,
  selectedOptionIds: ['2', '3'],
  correctOptionIds: ['2'],
  selectedOptionTexts: [REVEALED_ANSWER, 'map'],
  correctOptionTexts: [REVEALED_ANSWER],
  explanation: EXPLANATION
};

const RESULT: FinalResult = {
  quizId: 'rxjs',
  correct: 1,
  total: 1,
  percentage: 100,
  analysis: [ITEM],
  completedAt: 1_700_000_000_000
} as FinalResult;

const serialized = () => JSON.stringify(toDurableFinalResult(RESULT));

describe('what reaches storage', () => {
  it('drops the authorized correct-answer texts', () => {
    const item = toDurableAnalysisItem(ITEM);
    expect(item.correctOptionTexts).toBeUndefined();
  });

  it('drops the explanation', () => {
    expect(toDurableAnalysisItem(ITEM).explanation).toBeUndefined();
  });

  it('drops the legacy correctOptionIds', () => {
    expect(toDurableAnalysisItem(ITEM).correctOptionIds).toEqual([]);
  });

  it('the SERIALIZED payload contains no answer detail at all', () => {
    const json = serialized();

    expect(json).not.toContain(EXPLANATION);
    expect(json).not.toContain('correctOptionTexts');
    expect(json).not.toContain('explanation');

    // The reveal string must not survive under any key. `filter` is also a
    // SELECTED option here, so this asserts the correct-answer field is gone
    // rather than the string being absent by luck.
    const parsed = JSON.parse(json) as FinalResult;
    const stored = parsed.analysis[0]!;
    expect(stored.correctOptionIds).toEqual([]);
    expect(stored).not.toHaveProperty('correctOptionTexts');
    expect(stored).not.toHaveProperty('explanation');
  });
});

describe('what is deliberately kept', () => {
  it('keeps the summary facts', () => {
    const parsed = JSON.parse(serialized()) as FinalResult;

    expect(parsed.quizId).toBe('rxjs');
    expect(parsed.correct).toBe(1);
    expect(parsed.total).toBe(1);
    expect(parsed.percentage).toBe(100);
    expect(parsed.completedAt).toBe(1_700_000_000_000);
  });

  it("keeps the user's OWN selection and outcome", () => {
    const item = toDurableAnalysisItem(ITEM);

    // Neither discloses the key: these are what the user did, and how they did.
    expect(item.selectedOptionTexts).toEqual([REVEALED_ANSWER, 'map']);
    expect(item.selectedOptionIds).toEqual(['2', '3']);
    expect(item.wasCorrect).toBe(true);
    expect(item.questionText).toBe('Select every operator');
  });

  it('does not mutate the in-memory result', () => {
    // Same-session Review reads the live object and must still see the reveal.
    toDurableFinalResult(RESULT);

    expect(RESULT.analysis[0]!.correctOptionTexts).toEqual([REVEALED_ANSWER]);
    expect(RESULT.analysis[0]!.explanation).toBe(EXPLANATION);
  });
});

describe('legacy entries persisted by earlier builds', () => {
  it('parse without failing and lose their answer detail', () => {
    // Shaped like an older write: answer detail present, new fields absent.
    const legacy = {
      quizId: 'rxjs',
      correct: 1,
      total: 1,
      percentage: 100,
      completedAt: 1,
      analysis: [
        {
          questionIndex: 0,
          questionText: 'Select every operator',
          wasCorrect: true,
          selectedOptionIds: ['2'],
          correctOptionIds: ['2'],
          correctOptionTexts: [REVEALED_ANSWER],
          explanation: EXPLANATION
        }
      ]
    } as unknown as FinalResult;

    const scrubbed = toDurableFinalResult(legacy);
    const item = scrubbed.analysis[0]!;

    expect(item.correctOptionIds).toEqual([]);
    expect(item).not.toHaveProperty('correctOptionTexts');
    expect(item).not.toHaveProperty('explanation');

    // Summary and the user's own data survive, so history still renders.
    expect(scrubbed.correct).toBe(1);
    expect(item.wasCorrect).toBe(true);
    expect(item.questionText).toBe('Select every operator');
  });

  it('tolerates an entry with no analysis array', () => {
    const legacy = {
      quizId: 'rxjs',
      correct: 0,
      total: 0,
      percentage: 0
    } as unknown as FinalResult;
    expect(() => toDurableFinalResult(legacy)).not.toThrow();
    expect(toDurableFinalResult(legacy).analysis).toEqual([]);
  });

  it('tolerates an item missing the newer text fields', () => {
    const item = toDurableAnalysisItem({
      questionIndex: 0,
      questionText: 'q',
      wasCorrect: false,
      selectedOptionIds: [],
      correctOptionIds: ['9']
    } as ScoreAnalysisItem);

    expect(item.selectedOptionTexts).toEqual([]);
    expect(item.correctOptionIds).toEqual([]);
  });
});
