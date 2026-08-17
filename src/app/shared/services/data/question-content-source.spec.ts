import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting
} from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { signal } from '@angular/core';
import { firstValueFrom, of } from 'rxjs';

import { QuizDataLoaderService } from './quiz-data-loader.service';
import { API_BASE_URL } from '../../tokens/api-base-url.token';
import { QuestionType } from '../../models/question-type.enum';
import type { QuizQuestion } from '../../models/QuizQuestion.model';
import * as quizDataCache from '../../quiz-data-cache';

/**
 * WHERE TOPIC QUIZ QUESTION CONTENT COMES FROM.
 *
 * This is the S4 seam itself, tested at the LOADER rather than at the mapper.
 * A mapper-only test proves the mapper is clean and says nothing about which
 * source fed it — the distinction that matters, and one a mutation run caught
 * before this file existed.
 *
 * THE LOCAL BANK LIES IN EVERY FIXTURE HERE. Its questions say "LOCAL", the
 * API's say "API". Any path that still reads the bundled asset renders the
 * wrong words and fails loudly instead of agreeing by accident.
 */

const BASE = 'https://api.test/api';
const QUIZ = 'rxjs';

/** What `assets/data/quiz.json` would have supplied — deliberately different. */
const LOCAL_BANK = [{
  quizId: QUIZ,
  milestone: 'RxJS',
  summary: '',
  image: '',
  questions: [
    {
      questionText: 'LOCAL QUESTION ONE',
      explanation: 'LOCAL EXPLANATION',
      options: [
        { optionId: 1, text: 'LOCAL OPTION A', correct: true },
        { optionId: 2, text: 'LOCAL OPTION B' }
      ]
    },
    {
      questionText: 'LOCAL QUESTION TWO',
      explanation: 'LOCAL EXPLANATION TWO',
      options: [
        { optionId: 1, text: 'LOCAL OPTION C', correct: true },
        { optionId: 2, text: 'LOCAL OPTION D' }
      ]
    }
  ]
}];

/** What the API serves. Different text, different types, different arity. */
const API_BODY = {
  quizId: QUIZ,
  questions: [
    {
      questionText: 'API QUESTION ONE',
      type: 'multiple',
      difficulty: 'advanced',
      correctCount: 2,
      options: [{ text: 'API OPTION A' }, { text: 'API OPTION B' }, { text: 'API OPTION C' }]
    },
    {
      questionText: 'API QUESTION TWO',
      type: 'trueFalse',
      difficulty: 'beginner',
      correctCount: 1,
      options: [{ text: 'True' }, { text: 'False' }]
    }
  ]
};

// Same polyfill the sibling loader specs use — jsdom has no structuredClone,
// and QuizDataLoaderService clones the cache in a field initializer.
if (typeof (globalThis as any).structuredClone !== 'function') {
  (globalThis as any).structuredClone = (value: unknown) => JSON.parse(JSON.stringify(value));
}

let loader: QuizDataLoaderService;
let http: HttpTestingController;
let bankSpy: jest.SpyInstance;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();

  // The bank is present and WRONG throughout.
  bankSpy = jest.spyOn(quizDataCache, 'getQuizData').mockReturnValue(LOCAL_BANK as never);

  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: API_BASE_URL, useValue: BASE },
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } }
    ]
  });

  loader = TestBed.inject(QuizDataLoaderService);
  http = TestBed.inject(HttpTestingController);
});

afterEach(() => {
  bankSpy.mockRestore();
  http.verify();
});

/** Drive the loader the way QuizService does, and flush the API response. */
async function load(body: object = API_BODY): Promise<QuizQuestion[]> {
  const sig = signal<QuizQuestion[]>([]);
  const promise = loader.fetchQuizQuestions(QUIZ, sig, () => undefined);
  http.expectOne(`${BASE}/quizzes/${QUIZ}/questions`).flush(body);
  return promise;
}

describe('A/B. content comes from the API, not the bank', () => {
  it('renders the API question text, not the local one', async () => {
    const questions = await load();
    expect(questions.map((q) => q.questionText))
      .toEqual(['API QUESTION ONE', 'API QUESTION TWO']);
    expect(JSON.stringify(questions)).not.toContain('LOCAL');
  });

  it('renders the API option text, not the local one', async () => {
    const questions = await load();
    expect(questions[0]!.options.map((o) => o.text))
      .toEqual(['API OPTION A', 'API OPTION B', 'API OPTION C']);
  });

  it('takes the API arity — three options where the bank had two', async () => {
    expect((await load())[0]!.options).toHaveLength(3);
  });

  it('NEVER requests the local asset', async () => {
    await load();
    http.expectNone('assets/data/quiz.json');
    http.expectNone('/assets/data/quiz.json');
  });
});

describe('C. the declared API type wins over anything the bank implies', () => {
  it('uses multiple and trueFalse as declared', async () => {
    const questions = await load();
    expect(questions[0]!.type).toBe(QuestionType.MultipleAnswer);
    expect(questions[1]!.type).toBe(QuestionType.TrueFalse);
  });
});

describe('E. no correctness or explanation reaches the rendered questions', () => {
  it('carries no `correct` on any option, though the bank had them', async () => {
    for (const question of await load()) {
      for (const option of question.options) {
        expect('correct' in option).toBe(false);
      }
    }
  });

  it('carries no explanation, though the bank had one', async () => {
    // ONE load: a second call is served from the shared cache and issues no
    // request, which would leave expectOne with nothing to match.
    const questions = await load();
    for (const question of questions) {
      expect(question.explanation).toBeUndefined();
    }
    expect(JSON.stringify(questions)).not.toContain('LOCAL EXPLANATION');
  });
});

describe('the API is the only source — failure does NOT fall back', () => {
  it('yields no questions when /questions fails, rather than the bank\'s', async () => {
    const sig = signal<QuizQuestion[]>([]);
    const promise = loader.fetchQuizQuestions(QUIZ, sig, () => undefined);
    http.expectOne(`${BASE}/quizzes/${QUIZ}/questions`)
      .flush('boom', { status: 500, statusText: 'Server Error' });

    const questions = await promise;
    expect(questions).toEqual([]);
    expect(JSON.stringify(questions)).not.toContain('LOCAL');
  });

  it('yields no questions when the API has none, even though the bank does', async () => {
    // The substitution S4 must never make: an API question absent, a local one
    // present, and the local one quietly rendered in its place.
    const questions = await load({ quizId: QUIZ, questions: [] });
    expect(questions).toEqual([]);
  });

  it('does not read the quiz-data cache on the content path at all', async () => {
    bankSpy.mockClear();
    await load();
    expect(bankSpy).not.toHaveBeenCalled();
  });
});

/**
 * THE SECOND CONTENT PATH: QuizDataService.getQuestionsForQuiz.
 *
 * The loader above is not the only way questions reach the screen.
 * `getQuestionsForQuiz` has roughly nine live consumers — qqc-ql-stream,
 * cqc-orchestrator, cqc-question-nav, quiz-setup-data — and it used to read
 * `quiz.questions` off the object `getQuiz()` returns, i.e. off the bundled
 * asset.
 *
 * A census caught it; no test would have. Both sources carry the SAME
 * questions today, so the app looks identical whichever it reads — the
 * dependency would only have surfaced the day the asset was deleted, which is
 * exactly the failure mode this migration exists to remove.
 */
describe('QuizDataService.getQuestionsForQuiz sources from the API', () => {
  let dataService: import('./quizdata.service').QuizDataService;

  beforeEach(async () => {
    const { QuizDataService } = await import('./quizdata.service');
    dataService = TestBed.inject(QuizDataService);
  });

  it('returns the API questions, not the bank\'s', async () => {
    const promise = firstValueFrom(dataService.getQuestionsForQuiz(QUIZ));
    http.expectOne(`${BASE}/quizzes/${QUIZ}/questions`).flush(API_BODY);

    const questions = await promise;
    expect(questions.map((q) => q.questionText))
      .toEqual(['API QUESTION ONE', 'API QUESTION TWO']);
    expect(JSON.stringify(questions)).not.toContain('LOCAL');
  });

  it('never requests the local asset on this path', async () => {
    const promise = firstValueFrom(dataService.getQuestionsForQuiz(QUIZ));
    http.expectOne(`${BASE}/quizzes/${QUIZ}/questions`).flush(API_BODY);
    await promise;

    http.expectNone('assets/data/quiz.json');
  });

  it('does NOT stamp `correct: false` on options that carry no answer key', async () => {
    // normalizeQuestion aligned an `answer` array and stamped every option
    // from it. With no key that made each option `correct: false` — a claim
    // that it is WRONG, rather than that nobody has said.
    const promise = firstValueFrom(dataService.getQuestionsForQuiz(QUIZ));
    http.expectOne(`${BASE}/quizzes/${QUIZ}/questions`).flush(API_BODY);

    for (const question of await promise) {
      for (const option of question.options) {
        expect(option.correct).toBeUndefined();
      }
      expect(question.answer).toBeUndefined();
    }
  });

  it('FAILS rather than substituting the bank\'s questions', async () => {
    // This path rethrows — its pre-existing contract, unchanged by S4 — and
    // consumers handle it. What matters here is the negative: the failure is
    // not quietly answered with local content.
    const promise = firstValueFrom(dataService.getQuestionsForQuiz(QUIZ));
    http.expectOne(`${BASE}/quizzes/${QUIZ}/questions`)
      .flush('boom', { status: 500, statusText: 'Server Error' });

    await expect(promise).rejects.toBeDefined();
    await promise.catch((err: unknown) => {
      expect(JSON.stringify(err ?? '')).not.toContain('LOCAL');
    });
  });
});
