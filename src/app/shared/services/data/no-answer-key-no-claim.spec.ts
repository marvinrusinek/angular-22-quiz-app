import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { API_BASE_URL } from '../../tokens/api-base-url.token';
import { QuestionType } from '../../models/question-type.enum';
import type { QuizQuestion } from '../../models/QuizQuestion.model';

import { questionsFromApiViews } from '../../utils/topic-quiz-content';
import { TopicQuizTypeRegistry } from '../api/topic-quiz-type-registry.service';
import { QuizShuffleService } from '../flow/quiz-shuffle.service';
import { QuizQuestionResolverService } from './quiz-question-resolver.service';

/**
 * THE INVARIANT
 *
 * If API content carries no answer key, NO production transformation may
 * materialize `correct`, `answer`, or a single/multiple classification derived
 * from that absence.
 *
 * Absence and `false` are different statements. `correct: false` asserts an
 * option is WRONG; `answer: []` asserts a question has NO correct option; a
 * type counted from zero correct flags asserts a multi-answer question is
 * single-answer. Every one of those is a claim the server never made, and each
 * one caused a real failure during the `/questions` cutover — most visibly a
 * declared multi-answer question rendering as radio buttons, which made it
 * impossible to answer: the second correct pick was refused, `/check` received
 * an incomplete selection, and the question could never score.
 *
 * This runs ONE API-shaped question through EVERY live transformation. It is
 * deliberately a sweep rather than one test per site — six sites were found by
 * bisecting a browser failure, one at a time, and the sweep is what makes a
 * SEVENTH fail here instead of in production.
 *
 * A transformation that legitimately needs correctness must take it from the
 * verdict, never reconstruct it here — and never from `correctCount`, which is
 * cardinality, not identity.
 */

const BASE = 'https://api.test/api';
const QUIZ = 'dependency-injection';
const MULTI_TEXT = 'Which of the following statements are true about DI?';
const SINGLE_TEXT = 'What is Dependency Injection?';

const API_RESPONSE = {
  quizId: QUIZ,
  questions: [
    {
      questionText: MULTI_TEXT, type: 'multiple', difficulty: null, correctCount: 3,
      options: [
        { text: 'Reduces coupling' }, { text: 'Eases testing' },
        { text: 'Is a technique' }, { text: 'Slows startup' }
      ]
    },
    {
      questionText: SINGLE_TEXT, type: 'single', difficulty: null, correctCount: 1,
      options: [{ text: 'A pattern' }, { text: 'A compiler' }]
    }
  ]
};

/** What `GET /questions` produces: content only. */
const apiViews = () => API_RESPONSE.questions.map((q) => ({
  questionText: q.questionText,
  type: q.type as any,
  difficulty: q.difficulty,
  correctCount: q.correctCount,
  options: q.options.map((o) => ({ text: o.text }))
}));

/**
 * The assertion every stage must satisfy. Reports WHICH question and option
 * broke it, because a sweep that only says "false" is hard to act on.
 */
function assertNoClaims(questions: readonly QuizQuestion[], stage: string): void {
  for (const question of questions) {
    expect(`${stage}: ${question.questionText} answer`)
      .toBe(`${stage}: ${question.questionText} answer`);

    // `answer` must be absent, not an empty array.
    if (question.answer !== undefined) {
      throw new Error(
        `${stage} materialized an answer array (${JSON.stringify(question.answer)}) ` +
        `for "${question.questionText}", which carries no answer key.`
      );
    }

    for (const option of question.options ?? []) {
      if (Object.prototype.hasOwnProperty.call(option, 'correct')) {
        throw new Error(
          `${stage} materialized correct=${JSON.stringify((option as any).correct)} ` +
          `on option "${option.text}" of "${question.questionText}", which carries no answer key. ` +
          `Absence is not "false" — correctness comes from the verdict.`
        );
      }
    }
  }
}

/** The declared type must be exactly what the API said, at every stage. */
function assertDeclaredTypes(questions: readonly QuizQuestion[], stage: string): void {
  const multi = questions.find((q) => q.questionText === MULTI_TEXT);
  const single = questions.find((q) => q.questionText === SINGLE_TEXT);
  expect(`${stage}:${multi?.type}`).toBe(`${stage}:${QuestionType.MultipleAnswer}`);
  expect(`${stage}:${single?.type}`).toBe(`${stage}:${QuestionType.SingleAnswer}`);
}

describe('no answer key, no claim — across every live transformation', () => {
  let shuffle: QuizShuffleService;
  let resolver: QuizQuestionResolverService;
  let registry: TopicQuizTypeRegistry;
  let http: HttpTestingController;
  let store: Record<string, string>;

  beforeAll(() => {
    store = {};
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation((k) => store[k] ?? null);
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation((k, v) => { store[k] = v; });
    jest.spyOn(Storage.prototype, 'removeItem').mockImplementation((k) => { delete store[k]; });
  });

  afterAll(() => jest.restoreAllMocks());

  beforeEach(() => {
    store = {};
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(), provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: BASE },
        TopicQuizTypeRegistry, QuizShuffleService, QuizQuestionResolverService
      ]
    });
    registry = TestBed.inject(TopicQuizTypeRegistry);
    http = TestBed.inject(HttpTestingController);
    shuffle = TestBed.inject(QuizShuffleService);
    resolver = TestBed.inject(QuizQuestionResolverService);

    registry.load(QUIZ).subscribe();
    http.expectOne(`${BASE}/quizzes/${QUIZ}/questions`).flush(API_RESPONSE);
    shuffle.clearAll();
  });

  afterEach(() => http.verify());

  it('STAGE 1 — the API mapper produces no correct, no answer, and the declared type', () => {
    const mapped = questionsFromApiViews(apiViews() as any);
    assertNoClaims(mapped, 'questionsFromApiViews');
    assertDeclaredTypes(mapped, 'questionsFromApiViews');
  });

  it('STAGE 2 — shuffle (prepared state) preserves absence and type', () => {
    const mapped = questionsFromApiViews(apiViews() as any);
    shuffle.prepareShuffle(QUIZ, mapped);
    const shuffled = shuffle.buildShuffledQuestions(QUIZ, mapped);

    expect(shuffled.length).toBe(mapped.length);
    assertNoClaims(shuffled, 'buildShuffledQuestions(prepared)');
    assertDeclaredTypes(shuffled, 'buildShuffledQuestions(prepared)');
  });

  it('STAGE 2b — shuffle with NO prepared state preserves absence and type', () => {
    const mapped = questionsFromApiViews(apiViews() as any);
    const shuffled = shuffle.buildShuffledQuestions('never-prepared', mapped);

    assertNoClaims(shuffled, 'buildShuffledQuestions(no state)');
    assertDeclaredTypes(shuffled, 'buildShuffledQuestions(no state)');
  });

  it('STAGE 3 — session cloning preserves absence and type', () => {
    const mapped = questionsFromApiViews(apiViews() as any);
    shuffle.prepareShuffle(QUIZ, mapped);
    const shuffled = shuffle.buildShuffledQuestions(QUIZ, mapped);

    const cloned = shuffled
      .map((q, i) => resolver.cloneQuestionForSession(q, i))
      .filter((q): q is QuizQuestion => !!q);

    expect(cloned.length).toBe(shuffled.length);
    assertNoClaims(cloned, 'cloneQuestionForSession');
    assertDeclaredTypes(cloned, 'cloneQuestionForSession');
  });

  it('THE FULL CHAIN — mapper → shuffle → session clone, end to end', () => {
    const mapped = questionsFromApiViews(apiViews() as any);
    shuffle.prepareShuffle(QUIZ, mapped);
    const shuffled = shuffle.buildShuffledQuestions(QUIZ, mapped);
    const cloned = shuffled
      .map((q, i) => resolver.cloneQuestionForSession(q, i))
      .filter((q): q is QuizQuestion => !!q);

    assertNoClaims(cloned, 'full chain');
    assertDeclaredTypes(cloned, 'full chain');

    // And the registry — the authority — still agrees with the objects.
    for (const question of cloned) {
      expect(registry.questionTypeOf(question.questionText)).toBe(question.type);
    }
  });

  it('the bank path is UNAFFECTED — a real answer key still aligns', () => {
    // Absence is preserved; presence must not be discarded, or the local-bank
    // features (Weak Areas, pristine lookups) would silently lose correctness.
    const withKey: QuizQuestion[] = [{
      questionText: 'Bank question',
      type: QuestionType.MultipleAnswer,
      options: [
        { text: 'a', correct: true, value: 1 } as any,
        { text: 'b', correct: false, value: 2 } as any,
        { text: 'c', correct: true, value: 3 } as any
      ],
      answer: [{ text: 'a', correct: true, value: 1 } as any, { text: 'c', correct: true, value: 3 } as any]
    } as QuizQuestion];

    shuffle.prepareShuffle('bank', withKey);
    const shuffled = shuffle.buildShuffledQuestions('bank', withKey);
    const cloned = shuffled
      .map((q, i) => resolver.cloneQuestionForSession(q, i))
      .filter((q): q is QuizQuestion => !!q);

    const opts = cloned[0].options ?? [];
    expect(opts.find((o) => o.text === 'a')?.correct).toBe(true);
    expect(opts.find((o) => o.text === 'b')?.correct).toBe(false);
    expect(opts.find((o) => o.text === 'c')?.correct).toBe(true);
    expect(cloned[0].answer?.length).toBe(2);
  });

  it('correctCount is NEVER used to reconstruct which options are correct', () => {
    // The API says three options are correct. Cardinality is public; identity
    // is not. No transformation may turn the count into flags.
    const mapped = questionsFromApiViews(apiViews() as any);
    shuffle.prepareShuffle(QUIZ, mapped);
    const shuffled = shuffle.buildShuffledQuestions(QUIZ, mapped);

    const multi = shuffled.find((q) => q.questionText === MULTI_TEXT);
    expect(registry.correctCountOf(MULTI_TEXT)).toBe(3);
    expect((multi?.options ?? []).filter((o) => (o as any).correct === true).length).toBe(0);
    assertNoClaims(shuffled, 'correctCount must not become flags');
  });
});
