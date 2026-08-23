import {
  clearEarnedVerdicts,
  readPayload,
  saveEarnedVerdict,
  toEarnedEntry
} from './earned-verdict-storage';
import { IDLE_VERDICT_STATE, type QuestionVerdictState } from './question-verdict.types';

/**
 * WHAT MAY SURVIVE A RELOAD, AND WHAT MAY NOT.
 *
 * A page reload used to empty the in-memory verdict store, after which the UI
 * repainted an already-answered question from the bundled answer key. That was
 * the last correctness dependency on the asset, so the fix is to persist what
 * the user has EARNED — and nothing else.
 *
 * The security property these pin is narrow and checkable: reading this storage
 * tells you exactly what the player already saw, for the questions they already
 * answered. No key, no future questions, no unanswered correctness.
 */

const QUIZ = 'typescript';
const Q = 'Which of the following does TypeScript use to specify types?';

function state(over: Partial<QuestionVerdictState> = {}): QuestionVerdictState {
  return { ...IDLE_VERDICT_STATE, ...over } as QuestionVerdictState;
}

const resolvedCorrect = () => state({
  phase: 'resolved',
  isResolvedCorrect: true,
  selectedVerdicts: new Map([[':', true]]),
  correctOptionTexts: [':'],
  explanation: 'TS uses a colon.'
});

const resolvedWrong = () => state({
  phase: 'resolved',
  isResolvedCorrect: false,
  selectedVerdicts: new Map([[';', false]]),
  correctOptionTexts: [':'],
  explanation: 'TS uses a colon.'
});

beforeEach(() => sessionStorage.clear());

describe('only earned state is persisted', () => {
  it('a RESOLVED question is stored with the judgement of the user own picks', () => {
    saveEarnedVerdict(QUIZ, Q, resolvedCorrect());

    const [entry] = readPayload(QUIZ);
    expect(entry.questionText).toBe(Q);
    expect(entry.phase).toBe('resolved');
    expect(entry.selectedVerdicts).toEqual([[':', true]]);
    expect(entry.isResolvedCorrect).toBe(true);
  });

  it.each([['idle'], ['checking'], ['incomplete'], ['error']] as const)(
    'a %s question earns nothing and is not stored',
    (phase) => {
      saveEarnedVerdict(QUIZ, Q, state({ phase, selectedVerdicts: new Map([[':', true]]) }));
      expect(readPayload(QUIZ)).toEqual([]);
    }
  );

  it('an UNANSWERED question contributes no correctness whatsoever', () => {
    // Nothing was ever checked, so nothing is written — the storage cannot be
    // mined for questions the player has not reached.
    saveEarnedVerdict(QUIZ, 'A question never answered', state());
    expect(readPayload(QUIZ)).toEqual([]);
  });

  it('the reveal is stored ONLY when the server actually revealed it', () => {
    // An expired question that was never revealed: no correct texts, no
    // explanation. Absence here is the whole point.
    saveEarnedVerdict(QUIZ, Q, state({ phase: 'expired', correctOptionTexts: [], explanation: null }));

    const [entry] = readPayload(QUIZ);
    expect(entry.phase).toBe('expired');
    expect(entry.correctOptionTexts).toBeUndefined();
    expect(entry.explanation).toBeUndefined();
  });

  it('does not persist remainingCorrectCount or selectedOptionTexts', () => {
    // Neither is needed to restore: the first is meaningful only for the
    // `incomplete` phase, which is never stored, and the second is recoverable
    // from the verdict keys. Storing less is the point.
    saveEarnedVerdict(QUIZ, Q, resolvedCorrect());

    const [entry] = readPayload(QUIZ) as unknown as Record<string, unknown>[];
    expect(entry['remainingCorrectCount']).toBeUndefined();
    expect(entry['selectedOptionTexts']).toBeUndefined();
  });
});

describe('restore round-trips the facts the user already saw', () => {
  it('a correct pick round-trips as correct', () => {
    saveEarnedVerdict(QUIZ, Q, resolvedCorrect());
    const [entry] = readPayload(QUIZ);
    expect(new Map(entry.selectedVerdicts as [string, boolean][]).get(':')).toBe(true);
  });

  it('a wrong pick round-trips as wrong', () => {
    saveEarnedVerdict(QUIZ, Q, resolvedWrong());
    const [entry] = readPayload(QUIZ);
    expect(new Map(entry.selectedVerdicts as [string, boolean][]).get(';')).toBe(false);
    expect(entry.isResolvedCorrect).toBe(false);
  });

  it('re-saving the same question replaces rather than duplicates it', () => {
    saveEarnedVerdict(QUIZ, Q, resolvedWrong());
    saveEarnedVerdict(QUIZ, Q, resolvedCorrect());

    const entries = readPayload(QUIZ);
    expect(entries).toHaveLength(1);
    expect(entries[0].isResolvedCorrect).toBe(true);
  });
});

describe('fail closed', () => {
  it('discards malformed JSON', () => {
    sessionStorage.setItem('earnedVerdicts:v1:' + QUIZ, '{not json');
    expect(readPayload(QUIZ)).toEqual([]);
  });

  it('discards a payload written under a different schema version', () => {
    sessionStorage.setItem(
      'earnedVerdicts:v1:' + QUIZ,
      JSON.stringify({ v: 99, quizId: QUIZ, entries: [{ questionText: Q, phase: 'resolved', selectedVerdicts: [], isResolvedCorrect: true }] })
    );
    expect(readPayload(QUIZ)).toEqual([]);
  });

  it('refuses a payload whose quizId does not match the key it was read under', () => {
    // Tampering with the key cannot make another quiz's verdicts apply here.
    sessionStorage.setItem(
      'earnedVerdicts:v1:' + QUIZ,
      JSON.stringify({ v: 1, quizId: 'some-other-quiz', entries: [{ questionText: Q, phase: 'resolved', selectedVerdicts: [], isResolvedCorrect: true }] })
    );
    expect(readPayload(QUIZ)).toEqual([]);
  });

  it('another quiz cannot consume this quiz state', () => {
    saveEarnedVerdict(QUIZ, Q, resolvedCorrect());
    expect(readPayload('forms')).toEqual([]);
  });

  it('drops individual entries with the wrong shape, keeping valid ones', () => {
    sessionStorage.setItem(
      'earnedVerdicts:v1:' + QUIZ,
      JSON.stringify({
        v: 1,
        quizId: QUIZ,
        entries: [
          { questionText: Q, phase: 'resolved', selectedVerdicts: [[':', true]], isResolvedCorrect: true },
          { questionText: 'bad', phase: 'resolved', selectedVerdicts: 'not-an-array', isResolvedCorrect: true },
          { questionText: 'also bad', phase: 'checking', selectedVerdicts: [], isResolvedCorrect: null },
          { phase: 'resolved', selectedVerdicts: [], isResolvedCorrect: null }
        ]
      })
    );

    const entries = readPayload(QUIZ);
    expect(entries).toHaveLength(1);
    expect(entries[0].questionText).toBe(Q);
  });

  it('a non-terminal phase in a hand-written payload is rejected', () => {
    sessionStorage.setItem(
      'earnedVerdicts:v1:' + QUIZ,
      JSON.stringify({ v: 1, quizId: QUIZ, entries: [{ questionText: Q, phase: 'incomplete', selectedVerdicts: [], isResolvedCorrect: null }] })
    );
    expect(readPayload(QUIZ)).toEqual([]);
  });
});

describe('lifecycle', () => {
  it('clearing forgets this quiz earned verdicts', () => {
    saveEarnedVerdict(QUIZ, Q, resolvedCorrect());
    expect(readPayload(QUIZ)).toHaveLength(1);

    clearEarnedVerdicts(QUIZ);
    expect(readPayload(QUIZ)).toEqual([]);
  });

  it('clearing one quiz leaves another quiz untouched', () => {
    saveEarnedVerdict(QUIZ, Q, resolvedCorrect());
    saveEarnedVerdict('forms', 'A forms question', resolvedCorrect());

    clearEarnedVerdicts(QUIZ);
    expect(readPayload(QUIZ)).toEqual([]);
    expect(readPayload('forms')).toHaveLength(1);
  });

  it('toEarnedEntry refuses a non-terminal state outright', () => {
    expect(toEarnedEntry(Q, state({ phase: 'checking' }))).toBeNull();
    expect(toEarnedEntry('', resolvedCorrect())).toBeNull();
  });
});
