import {
  allCorrectSelectedFromVerdict,
  authorizedCorrectTexts,
  selectedVerdictFor
} from './authorized-correctness';
import { IDLE_VERDICT_STATE, type QuestionVerdictState } from './question-verdict.types';
import type { QuizService } from '../../data/quiz.service';
import type { QuestionVerdictService } from './question-verdict.service';

/**
 * The rules that decide what the UI is allowed to know, mid-question.
 *
 * Locking, greying and highlight decisions used to derive the correct set by
 * walking `quizInitialState`. That answered a question nobody had earned the
 * answer to: on an incomplete multi-answer question, the correctness of an
 * option the user has NOT selected is not disclosed — otherwise partial play
 * becomes a way to enumerate the answer key one click at a time.
 *
 * These tests pin the disclosure boundary itself, so a future consumer cannot
 * quietly widen it.
 */

const QUIZ = 'rxjs';
const QUESTION = 'Select every operator';

function quizStub(): QuizService {
  return {
    quizId: QUIZ,
    getQuestionsInDisplayOrder: () => [{ questionText: QUESTION }],
    questions: [{ questionText: QUESTION }],
    isShuffleEnabled: () => false,
    shuffledQuestions: []
  } as unknown as QuizService;
}

function verdictsStub(state: QuestionVerdictState): QuestionVerdictService {
  return { verdictFor: () => state } as unknown as QuestionVerdictService;
}

const state = (over: Partial<QuestionVerdictState>): QuestionVerdictState =>
  ({ ...IDLE_VERDICT_STATE, ...over });

describe('the full correct set is only readable once it is authorized', () => {
  it('is withheld while the question is incomplete', () => {
    const s = state({
      phase: 'incomplete',
      selectedVerdicts: new Map([['map', true]]),
      remainingCorrectCount: 1
    });

    expect(authorizedCorrectTexts(quizStub(), 0, verdictsStub(s))).toBeNull();
  });

  it('is withheld while idle, checking or errored', () => {
    for (const phase of ['idle', 'checking', 'error'] as const) {
      expect(authorizedCorrectTexts(quizStub(), 0, verdictsStub(state({ phase })))).toBeNull();
    }
  });

  it('is released once resolved', () => {
    const s = state({ phase: 'resolved', correctOptionTexts: ['map', 'filter'], isResolvedCorrect: true });

    expect([...(authorizedCorrectTexts(quizStub(), 0, verdictsStub(s)) ?? [])].sort())
      .toEqual(['filter', 'map']);
  });

  it('is released once expired — the deadline reveals it too', () => {
    const s = state({ phase: 'expired', correctOptionTexts: ['map', 'filter'] });

    expect(authorizedCorrectTexts(quizStub(), 0, verdictsStub(s))?.has('map')).toBe(true);
  });

  it('is null — not an empty set — when unauthorized, so callers cannot read it as "nothing is correct"', () => {
    const s = state({ phase: 'incomplete', remainingCorrectCount: 2 });
    const result = authorizedCorrectTexts(quizStub(), 0, verdictsStub(s));

    expect(result).toBeNull();
    expect(result).not.toEqual(new Set());
  });
});

describe('a selected option carries its own verdict', () => {
  const s = state({
    phase: 'incomplete',
    selectedVerdicts: new Map([['map', true], ['Observable', false]]),
    remainingCorrectCount: 1
  });

  it('reports a selected correct pick', () => {
    expect(selectedVerdictFor(s, 'map')).toBe(true);
  });

  it('reports a selected wrong pick', () => {
    expect(selectedVerdictFor(s, 'Observable')).toBe(false);
  });

  it('says nothing about an option the user never selected', () => {
    // undefined, NOT false — "no verdict" is not "wrong".
    expect(selectedVerdictFor(s, 'filter')).toBeUndefined();
  });

  it('tolerates whitespace drift in the option text', () => {
    expect(selectedVerdictFor(s, '  map  ')).toBe(true);
  });
});

describe('completion is read from authorized facts only', () => {
  it('is true when the question resolved correctly', () => {
    expect(allCorrectSelectedFromVerdict(
      state({ phase: 'resolved', isResolvedCorrect: true })
    )).toBe(true);
  });

  it('is false when the question resolved incorrectly', () => {
    expect(allCorrectSelectedFromVerdict(
      state({ phase: 'resolved', isResolvedCorrect: false })
    )).toBe(false);
  });

  it('uses the outstanding COUNT while incomplete — never which options', () => {
    expect(allCorrectSelectedFromVerdict(
      state({ phase: 'incomplete', remainingCorrectCount: 0 })
    )).toBe(true);
    expect(allCorrectSelectedFromVerdict(
      state({ phase: 'incomplete', remainingCorrectCount: 2 })
    )).toBe(false);
  });

  it('is unknown when nothing has been checked', () => {
    expect(allCorrectSelectedFromVerdict(state({ phase: 'idle' }))).toBeNull();
    expect(allCorrectSelectedFromVerdict(state({ phase: 'checking' }))).toBeNull();
    expect(allCorrectSelectedFromVerdict(null)).toBeNull();
  });
});
