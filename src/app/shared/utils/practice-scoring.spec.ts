import { QuestionType } from '../models/question-type.enum';
import { QuizQuestion } from '../models/QuizQuestion.model';
import {
  AuthorizedResolved,
  canAdvanceFromQuestion,
  computePracticeResult,
  declaredMultiAnswer,
  isMultiAnswerQuestion,
  isQuestionResolved
} from './practice-scoring';

/**
 * Weak Areas Practice gating + scoring, AFTER the S6 migration.
 *
 * Two things changed and both are asserted here rather than assumed:
 *
 *   1. Question type comes from the DECLARED API type, never from counting
 *      correct options. The declared-type tests below deliberately disagree with
 *      the option flags to prove which one wins.
 *   2. Correctness comes from the AUTHORIZED verdict, passed in. The helpers no
 *      longer read `option.correct` at all, so these tests supply a resolver
 *      that stands in for `POST /check`.
 *
 * `serverRule` reproduces the BACKEND's rule (superset for multi, any pick
 * terminal for single) purely so the fixtures stay readable. It is a test
 * oracle, not production code — production has no such function, which is the
 * whole point of the slice.
 */

function question(
  text: string,
  type: QuestionType,
  options: { id: number; text: string; correct?: boolean }[],
  sourceQuizId = 'rxjs'
): QuizQuestion {
  return {
    questionText: text,
    type,
    sourceQuizId,
    options: options.map((o) => ({
      optionId: o.id,
      text: o.text,
      // Present ONLY so the test oracle below can play the server's part. No
      // production path reads it any more.
      correct: o.correct === true
    }))
  } as QuizQuestion;
}

/** Correct ids for a fixture, read by the test oracle only. */
function correctIdsOf(q: QuizQuestion): number[] {
  return (q.options ?? [])
    .filter((o) => (o as { correct?: boolean }).correct === true)
    .map((o) => o.optionId as number);
}

/**
 * Stand in for the server: resolve a question when the selection satisfies the
 * backend's rule. Single/true-false resolve only on the correct pick; multi
 * resolves when every correct option is selected (superset).
 */
function serverRule(answers: Record<string, number[]>): AuthorizedResolved {
  return (q: QuizQuestion) => {
    const selected = answers[q.questionText] ?? [];
    if (selected.length === 0) return false;
    const correct = correctIdsOf(q);
    if (q.type === QuestionType.MultipleAnswer) {
      return correct.every((id) => selected.includes(id));
    }
    return selected.length === 1 && correct.includes(selected[0]);
  };
}

/** A resolver that authorizes nothing — the API-unavailable case. */
const NOTHING_AUTHORIZED: AuthorizedResolved = () => false;

const single = question('Single?', QuestionType.SingleAnswer, [
  { id: 1, text: 'Wrong A' },
  { id: 2, text: 'Right', correct: true },
  { id: 3, text: 'Wrong B' }
]);

const trueFalse = question('True or false?', QuestionType.TrueFalse, [
  { id: 1, text: 'True', correct: true },
  { id: 2, text: 'False' }
]);

const multi = question('Pick two', QuestionType.MultipleAnswer, [
  { id: 1, text: 'Right one', correct: true },
  { id: 2, text: 'Wrong' },
  { id: 3, text: 'Right two', correct: true }
]);

describe('practice-scoring — question type comes from the DECLARED type', () => {
  it('a DECLARED multi-answer question is multi even with ONE correct option', () => {
    // The count says single. The declaration says multiple. The declaration wins
    // — this is the demotion that broke shuffled multi-answer questions before.
    const declaredMulti = question('Declared multi', QuestionType.MultipleAnswer, [
      { id: 1, text: 'only right', correct: true },
      { id: 2, text: 'wrong' }
    ]);
    expect(isMultiAnswerQuestion(declaredMulti)).toBe(true);
    expect(declaredMultiAnswer(declaredMulti)).toBe(true);
  });

  it('a DECLARED single question stays single even with TWO correct options', () => {
    const declaredSingle = question('Declared single', QuestionType.SingleAnswer, [
      { id: 1, text: 'a', correct: true },
      { id: 2, text: 'b', correct: true }
    ]);
    expect(isMultiAnswerQuestion(declaredSingle)).toBe(false);
    expect(declaredMultiAnswer(declaredSingle)).toBe(false);
  });

  it('API-sourced options carry NO correct flag, and type still resolves', () => {
    const apiShaped = {
      questionText: 'From the API',
      type: QuestionType.MultipleAnswer,
      sourceQuizId: 'rxjs',
      options: [{ optionId: 1, text: 'a' }, { optionId: 2, text: 'b' }]
    } as unknown as QuizQuestion;

    for (const option of apiShaped.options ?? []) {
      expect(Object.prototype.hasOwnProperty.call(option, 'correct')).toBe(false);
    }
    expect(isMultiAnswerQuestion(apiShaped)).toBe(true);
  });

  it('an UNDECLARED type is null — never silently single', () => {
    const undeclared = {
      questionText: 'No type',
      options: [{ optionId: 1, text: 'a', correct: true }, { optionId: 2, text: 'b', correct: true }]
    } as unknown as QuizQuestion;
    expect(declaredMultiAnswer(undeclared)).toBeNull();
  });

  it('treats a null question as neither resolved nor advanceable', () => {
    expect(isQuestionResolved(null, [1], NOTHING_AUTHORIZED)).toBe(false);
    expect(canAdvanceFromQuestion(null, [1], NOTHING_AUTHORIZED)).toBe(false);
    expect(isMultiAnswerQuestion(null)).toBe(false);
  });
});

describe('practice-scoring — the Next gate (verified topic-quiz behaviour)', () => {
  const resolve = (q: QuizQuestion, ids: number[]) => serverRule({ [q.questionText!]: ids });

  it('SINGLE: a WRONG selection enables Next', () => {
    expect(canAdvanceFromQuestion(single, [1], resolve(single, [1]))).toBe(true);
    expect(isQuestionResolved(single, [1], resolve(single, [1]))).toBe(false);
  });

  it('SINGLE: a correct selection enables Next and resolves', () => {
    expect(canAdvanceFromQuestion(single, [2], resolve(single, [2]))).toBe(true);
    expect(isQuestionResolved(single, [2], resolve(single, [2]))).toBe(true);
  });

  it('TRUE/FALSE: a wrong selection enables Next but does not resolve', () => {
    expect(canAdvanceFromQuestion(trueFalse, [2], resolve(trueFalse, [2]))).toBe(true);
    expect(isQuestionResolved(trueFalse, [2], resolve(trueFalse, [2]))).toBe(false);
    expect(isQuestionResolved(trueFalse, [1], resolve(trueFalse, [1]))).toBe(true);
  });

  it('MULTI: a PARTIAL selection does NOT enable Next and does not resolve', () => {
    expect(canAdvanceFromQuestion(multi, [1], resolve(multi, [1]))).toBe(false);
    expect(isQuestionResolved(multi, [1], resolve(multi, [1]))).toBe(false);
  });

  it('MULTI: only the EXACT correct set enables Next', () => {
    expect(canAdvanceFromQuestion(multi, [1, 3], resolve(multi, [1, 3]))).toBe(true);
    expect(isQuestionResolved(multi, [3, 1], resolve(multi, [3, 1]))).toBe(true);
  });

  it('an EMPTY selection never enables Next, for either type', () => {
    expect(canAdvanceFromQuestion(single, [], NOTHING_AUTHORIZED)).toBe(false);
    expect(canAdvanceFromQuestion(multi, [], NOTHING_AUTHORIZED)).toBe(false);
    expect(canAdvanceFromQuestion(single, undefined, NOTHING_AUTHORIZED)).toBe(false);
  });

  it('NO LOCAL FALLBACK: an unauthorized verdict never resolves, however right the picks look', () => {
    // The fixture's own flags say [1,3] is the exact correct set. With nothing
    // authorized it must STILL be unresolved — proving the helpers read the
    // verdict and not the options.
    expect(isQuestionResolved(multi, [1, 3], NOTHING_AUTHORIZED)).toBe(false);
    expect(isQuestionResolved(single, [2], NOTHING_AUTHORIZED)).toBe(false);
    expect(canAdvanceFromQuestion(multi, [1, 3], NOTHING_AUTHORIZED)).toBe(false);
  });

  it('FAILS CLOSED on an undeclared type: one pick is not enough to advance', () => {
    const undeclared = {
      questionText: 'No type',
      sourceQuizId: 'rxjs',
      options: [{ optionId: 1, text: 'a' }, { optionId: 2, text: 'b' }]
    } as unknown as QuizQuestion;
    // Unknown must not be treated as single-answer, which would let a
    // multi-answer question advance on a single pick.
    expect(canAdvanceFromQuestion(undeclared, [1], NOTHING_AUTHORIZED)).toBe(false);
  });
});

describe('practice-scoring — results (final-state scoring)', () => {
  const questions = [single, trueFalse, multi];
  const topicNameFor = (id: string) => (id === 'rxjs' ? 'RxJS' : id);

  function score(answers: Record<number, number[]>) {
    const byText: Record<string, number[]> = {};
    questions.forEach((q, i) => {
      if (answers[i]) byText[q.questionText!] = answers[i];
    });
    const authorizedResolved = serverRule(byText);
    return computePracticeResult({
      sessionId: 's1',
      questions,
      answersByIndex: answers,
      completedAt: '2026-08-01T10:00:00.000Z',
      topicNameFor,
      authorizedResolved,
      // The server reveals correct texts only once terminal; mirror that.
      authorizedCorrectTexts: (q) =>
        authorizedResolved(q)
          ? (q.options ?? [])
              .filter((o) => (o as { correct?: boolean }).correct === true)
              .map((o) => o.text ?? '')
          : []
    });
  }

  it('scores single, true/false and multi correctly', () => {
    const r = score({ 0: [2], 1: [1], 2: [1, 3] });
    expect(r.correct).toBe(3);
    expect(r.total).toBe(3);
    expect(r.percentage).toBe(100);
    expect(r.incorrect).toBe(0);
  });

  it('a WRONG single answer scores incorrect', () => {
    const r = score({ 0: [1], 1: [1], 2: [1, 3] });
    expect(r.correct).toBe(2);
    expect(r.percentage).toBe(67);
    expect(r.review[0].isCorrect).toBe(false);
    expect(r.review[0].answered).toBe(true);
  });

  it('a PARTIAL multi answer is NOT credited', () => {
    const r = score({ 0: [2], 1: [1], 2: [1] });
    expect(r.correct).toBe(2);
    expect(r.review[2].isCorrect).toBe(false);
  });

  it('an UNANSWERED question is incorrect and counted as unanswered', () => {
    const r = score({ 0: [2] });
    expect(r.answered).toBe(1);
    expect(r.unanswered).toBe(2);
    expect(r.correct).toBe(1);
    expect(r.review[1].answered).toBe(false);
    expect(r.review[1].isCorrect).toBe(false);
  });

  it('FINAL-STATE: changing a wrong answer to the right one scores CORRECT', () => {
    expect(score({ 0: [1] }).correct).toBe(0);
    expect(score({ 0: [2] }).correct).toBe(1);
  });

  it('an all-wrong session scores 0%', () => {
    const r = score({ 0: [1], 1: [2], 2: [2] });
    expect(r.correct).toBe(0);
    expect(r.percentage).toBe(0);
  });

  it('correct texts in the review come from the AUTHORIZED reveal, not the options', () => {
    const r = score({ 0: [2], 1: [1], 2: [1, 3] });
    expect(r.review[0].correctTexts).toEqual(['Right']);
    // Unanswered => the server revealed nothing => nothing claimed.
    const unanswered = score({ 0: [2] });
    expect(unanswered.review[2].correctTexts).toEqual([]);
  });

  it('scores NOTHING when no verdict is authorized, even for perfect picks', () => {
    const r = computePracticeResult({
      sessionId: 's-none',
      questions,
      answersByIndex: { 0: [2], 1: [1], 2: [1, 3] },
      completedAt: 'now',
      topicNameFor,
      authorizedResolved: NOTHING_AUTHORIZED,
      authorizedCorrectTexts: () => []
    });
    expect(r.correct).toBe(0);
    expect(r.answered).toBe(3);
  });

  it('handles an empty question set without dividing by zero', () => {
    const r = computePracticeResult({
      sessionId: 's0',
      questions: [],
      answersByIndex: {},
      completedAt: 'now',
      topicNameFor,
      authorizedResolved: NOTHING_AUTHORIZED,
      authorizedCorrectTexts: () => []
    });
    expect(r.total).toBe(0);
    expect(r.percentage).toBe(0);
    expect(r.perTopic).toEqual([]);
  });
});

describe('practice-scoring — per-topic breakdown', () => {
  it('groups by the preserved sourceQuizId, never by wording', () => {
    const questions = [
      question('A', QuestionType.SingleAnswer, [{ id: 1, text: 'x', correct: true }, { id: 2, text: 'y' }], 'rxjs'),
      question('B', QuestionType.SingleAnswer, [{ id: 1, text: 'x', correct: true }, { id: 2, text: 'y' }], 'rxjs'),
      question('C', QuestionType.SingleAnswer, [{ id: 1, text: 'x', correct: true }, { id: 2, text: 'y' }], 'signals')
    ];
    const answers = { 0: [1], 1: [2], 2: [1] };
    const byText: Record<string, number[]> = {
      A: answers[0], B: answers[1], C: answers[2]
    };

    const r = computePracticeResult({
      sessionId: 's2',
      questions,
      answersByIndex: answers,
      completedAt: 'now',
      topicNameFor: (id) => (id === 'rxjs' ? 'RxJS' : 'Signals'),
      authorizedResolved: serverRule(byText),
      authorizedCorrectTexts: () => []
    });

    const rxjs = r.perTopic.find((t) => t.topicId === 'rxjs')!;
    const signals = r.perTopic.find((t) => t.topicId === 'signals')!;
    expect(rxjs).toEqual({ topicId: 'rxjs', topicName: 'RxJS', correct: 1, total: 2, percentage: 50 });
    expect(signals).toEqual({
      topicId: 'signals', topicName: 'Signals', correct: 1, total: 1, percentage: 100
    });
  });
});
