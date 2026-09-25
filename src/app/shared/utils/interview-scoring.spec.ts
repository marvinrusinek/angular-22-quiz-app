import { Option } from '@shared/models/Option.model';
import { isAnswerCorrect } from './interview-scoring';

/**
 * `computeInterviewResult` was removed with the legacy Interview pipeline in
 * Stage 9F — the backend scores every interview now. What remains is the
 * shared exact-set rule, which Weak Areas Practice still uses over the local
 * quiz bank.
 */
function makeQuestion(correctIds: number[], optionIds: number[]) {
  const options: Option[] = optionIds.map((id) => ({
    text: `opt-${id}`,
    optionId: id,
    correct: correctIds.includes(id)
  }));
  return { questionText: 'q', explanation: 'e', options };
}

const single = makeQuestion([1], [1, 2, 3, 4]);
const multi = makeQuestion([10, 11], [10, 11, 12]);

describe('isAnswerCorrect — exact set equality', () => {
  it('single answer: only the correct option counts', () => {
    expect(isAnswerCorrect(single, [1])).toBe(true);
    expect(isAnswerCorrect(single, [2])).toBe(false);
  });

  it('multi answer: the WHOLE correct set is required — no partial credit', () => {
    expect(isAnswerCorrect(multi, [10, 11])).toBe(true);
    expect(isAnswerCorrect(multi, [11, 10])).toBe(true);        // order irrelevant
    expect(isAnswerCorrect(multi, [10])).toBe(false);           // partial
    expect(isAnswerCorrect(multi, [10, 11, 12])).toBe(false);   // extra wrong
  });

  it('unanswered is incorrect, never a free pass', () => {
    expect(isAnswerCorrect(single, [])).toBe(false);
    expect(isAnswerCorrect(multi, [])).toBe(false);
  });

  it('tolerates missing options and null ids', () => {
    expect(isAnswerCorrect({ questionText: 'q', explanation: '', options: [] }, [1])).toBe(false);
    expect(isAnswerCorrect(single, [null as unknown as number, 1])).toBe(true);
  });
});

describe('the local interview scorer is gone', () => {
  it('no longer exports computeInterviewResult', () => {
    const scoring = jest.requireActual('./interview-scoring') as Record<string, unknown>;
    expect(scoring['computeInterviewResult']).toBeUndefined();
    expect(typeof scoring['isAnswerCorrect']).toBe('function');
  });
});
