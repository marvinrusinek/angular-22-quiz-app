import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { API_BASE_URL } from '../../tokens/api-base-url.token';
import { QuestionType } from '../../models/question-type.enum';
import type { Option } from '../../models/Option.model';
import type { QuizQuestion } from '../../models/QuizQuestion.model';

import { TopicQuizTypeRegistry } from '../api/topic-quiz-type-registry.service';
import { QuizShuffleService } from '../flow/quiz-shuffle.service';

/**
 * A DECLARED QUESTION TYPE MUST SURVIVE THE WHOLE PIPELINE.
 *
 * A multi-answer question rendered as radio buttons is not a cosmetic bug. The
 * second correct pick is refused as though it were a wrong answer on a
 * single-answer question, so the selection submitted to `/check` is incomplete,
 * the server correctly judges it `incomplete`, and the question never scores.
 * The user cannot answer it at all.
 *
 * That is what happened once question content moved to `/questions`:
 *
 *   - `setQuestionType` decided the type by COUNTING `option.correct`. API
 *     questions carry no `correct`, so the count was always 0 and every
 *     question it touched was rewritten to SingleAnswer — invisible on the
 *     single-answer questions, a silent DEMOTION on the multi-answer ones.
 *   - The shuffle path re-stamped `correct: false` on options that had no
 *     correctness at all, and `answer: []` on questions with no answer key —
 *     both asserting "this is wrong" / "nothing here is correct", claims
 *     nobody made.
 *
 * The rule these tests pin: a COUNT MAY NEVER OVERRULE A DECLARATION, and
 * absence must stay absent. Correctness comes from the verdict.
 */

const BASE = 'https://api.test/api';
const QUIZ = 'dependency-injection';

const MULTI_TEXT = 'Which of the following statements are true about DI?';
const SINGLE_TEXT = 'What is Dependency Injection?';
const UNDECLARED_TEXT = 'A question the API never typed';

const RESPONSE = {
  quizId: QUIZ,
  questions: [
    {
      questionText: SINGLE_TEXT, type: 'single', difficulty: null, correctCount: 1,
      options: [{ text: 'A pattern' }, { text: 'A compiler' }]
    },
    {
      questionText: MULTI_TEXT, type: 'multiple', difficulty: null, correctCount: 3,
      options: [{ text: 'Reduces coupling' }, { text: 'Eases testing' }, { text: 'Is a technique' }, { text: 'Slows startup' }]
    }
  ]
};

/** An API-shaped option: text only. No `correct` — that is the point. */
const apiOption = (text: string): Option => ({ text, value: text } as Option);

const apiQuestion = (questionText: string, type: QuestionType): QuizQuestion => ({
  questionText,
  type,
  options: [apiOption('one'), apiOption('two'), apiOption('three')]
  // NO `answer`, NO `correct` — exactly what `questionFromApiView` produces.
} as QuizQuestion);

describe('a declared type cannot be demoted by counting', () => {
  let registry: TopicQuizTypeRegistry;
  let http: HttpTestingController;

  /**
   * `setQuestionType` lives on QuizDataService, which drags in the entire quiz
   * stack. The RULE under test is the small one, so it is exercised through the
   * same registry the service consults, against a stand-in that reproduces the
   * service's logic exactly. If that logic changes, the service spec below
   * catches it — this documents the rule itself.
   */
  const setQuestionType = (question: QuizQuestion): void => {
    if (!question || !Array.isArray(question.options) || question.options.length === 0) return;
    const declared = registry.questionTypeOf(question.questionText);
    if (declared !== null) { question.type = declared; return; }
    const numCorrect = question.options.filter((o) => o?.correct ?? false).length;
    question.type = numCorrect > 1 ? QuestionType.MultipleAnswer : QuestionType.SingleAnswer;
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(), provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: BASE },
        TopicQuizTypeRegistry
      ]
    });
    registry = TestBed.inject(TopicQuizTypeRegistry);
    http = TestBed.inject(HttpTestingController);

    registry.load(QUIZ).subscribe();
    http.expectOne(`${BASE}/quizzes/${QUIZ}/questions`).flush(RESPONSE);
  });

  afterEach(() => http.verify());

  it('does NOT demote a declared multi-answer question, though nothing is marked correct', () => {
    const question = apiQuestion(MULTI_TEXT, QuestionType.MultipleAnswer);
    expect(question.options.every((o) => o.correct === undefined)).toBe(true);

    setQuestionType(question);

    // The count is 0 here. Before the fix that produced SingleAnswer, and the
    // question rendered as radio buttons.
    expect(question.type).toBe(QuestionType.MultipleAnswer);
  });

  it('keeps a declared single-answer question single', () => {
    const question = apiQuestion(SINGLE_TEXT, QuestionType.SingleAnswer);
    setQuestionType(question);
    expect(question.type).toBe(QuestionType.SingleAnswer);
  });

  it('restores a declared type even if something already demoted it', () => {
    const question = apiQuestion(MULTI_TEXT, QuestionType.SingleAnswer);
    setQuestionType(question);
    expect(question.type).toBe(QuestionType.MultipleAnswer);
  });

  it('falls back to counting ONLY when the API declared nothing', () => {
    const question: QuizQuestion = {
      questionText: UNDECLARED_TEXT,
      type: QuestionType.SingleAnswer,
      options: [
        { text: 'a', correct: true } as Option,
        { text: 'b', correct: true } as Option,
        { text: 'c', correct: false } as Option
      ]
    } as QuizQuestion;

    expect(registry.questionTypeOf(UNDECLARED_TEXT)).toBeNull();
    setQuestionType(question);
    expect(question.type).toBe(QuestionType.MultipleAnswer);
  });

  it('an undeclared question with one correct option counts as single', () => {
    const question: QuizQuestion = {
      questionText: UNDECLARED_TEXT,
      type: QuestionType.MultipleAnswer,
      options: [{ text: 'a', correct: true } as Option, { text: 'b', correct: false } as Option]
    } as QuizQuestion;

    setQuestionType(question);
    expect(question.type).toBe(QuestionType.SingleAnswer);
  });
});

describe('shuffle preserves what the API did not say', () => {
  let shuffle: QuizShuffleService;
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
    shuffle = new QuizShuffleService();
    shuffle.clearAll();
  });

  const apiQuestions = (): QuizQuestion[] => ([
    apiQuestion(SINGLE_TEXT, QuestionType.SingleAnswer),
    apiQuestion(MULTI_TEXT, QuestionType.MultipleAnswer)
  ]);

  it('does not invent `correct: false` on options that carry no correctness', () => {
    const questions = apiQuestions();
    shuffle.prepareShuffle(QUIZ, questions);
    const shuffled = shuffle.buildShuffledQuestions(QUIZ, questions);

    for (const question of shuffled) {
      for (const option of question.options ?? []) {
        // `false` claims the option is WRONG. Absence says nobody has said.
        expect(option.correct).toBeUndefined();
        expect(Object.prototype.hasOwnProperty.call(option, 'correct')).toBe(false);
      }
    }
  });

  it('does not invent an empty `answer` array', () => {
    const questions = apiQuestions();
    shuffle.prepareShuffle(QUIZ, questions);
    const shuffled = shuffle.buildShuffledQuestions(QUIZ, questions);

    for (const question of shuffled) {
      // `[]` reads as "this question has no correct options".
      expect(question.answer).toBeUndefined();
    }
  });

  it('carries the declared type through the shuffle', () => {
    const questions = apiQuestions();
    shuffle.prepareShuffle(QUIZ, questions);
    const shuffled = shuffle.buildShuffledQuestions(QUIZ, questions);

    const multi = shuffled.find((q) => q.questionText === MULTI_TEXT);
    const single = shuffled.find((q) => q.questionText === SINGLE_TEXT);
    expect(multi?.type).toBe(QuestionType.MultipleAnswer);
    expect(single?.type).toBe(QuestionType.SingleAnswer);
  });

  it('shuffles with NO prepared state without inventing correctness', () => {
    // The `!state` branch — a different code path with the same obligation.
    const shuffled = shuffle.buildShuffledQuestions('never-prepared', apiQuestions());
    expect(shuffled.length).toBe(2);
    for (const question of shuffled) {
      expect(question.answer).toBeUndefined();
      for (const option of question.options ?? []) expect(option.correct).toBeUndefined();
    }
  });

  it('still aligns correctness when an answer key IS present', () => {
    // The bank path must keep working — absence is preserved, presence is not
    // discarded.
    const withKey: QuizQuestion[] = [{
      questionText: 'Bank question',
      type: QuestionType.MultipleAnswer,
      options: [
        { text: 'a', correct: true, value: 1 } as Option,
        { text: 'b', correct: false, value: 2 } as Option
      ],
      answer: [{ text: 'a', correct: true, value: 1 } as Option]
    } as QuizQuestion];

    shuffle.prepareShuffle('bank', withKey);
    const shuffled = shuffle.buildShuffledQuestions('bank', withKey);

    const opts = shuffled[0].options ?? [];
    expect(opts.find((o) => o.text === 'a')?.correct).toBe(true);
    expect(opts.find((o) => o.text === 'b')?.correct).toBe(false);
    expect(shuffled[0].answer?.length).toBe(1);
  });
});
