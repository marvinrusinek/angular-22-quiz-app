import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { API_BASE_URL } from '@shared/tokens/api-base-url.token';
import { TopicQuizTypeRegistry } from './topic-quiz-type-registry.service';
import { QuizService } from '@shared/services/data/quiz.service';
import { setQuizDataCache } from '@shared/quiz-data-cache';
import type { Quiz } from '@shared/models/Quiz.model';

/**
 * Explicit type REACHING the runtime.
 *
 * The registry is only useful if something populates it and something reads
 * it. `QuizService.initializeData` populates it on quiz entry; the resolver in
 * `answer.component` reads it. These tests cover the population half and the
 * decision rule, which is where a silent regression would hide: if the load
 * stopped firing, every lookup would miss, every consumer would fall back to
 * counting correct options, and the whole suite would still be green.
 *
 * The local bank below LIES about the type — its correct-option counts
 * disagree with the API's declared types in both directions — so a fallback to
 * counting produces the opposite answer and the tests fail.
 */

const BASE = 'https://api.test/api';
const QUIZ = 'rxjs';
const URL = `${BASE}/quizzes/${QUIZ}/questions`;

// Locally: ONE correct option → a count-based rule says 'single'.
// The API declares it 'multiple'.
const LOOKS_SINGLE_IS_MULTI = 'Select every operator';
// Locally: TWO correct options → a count-based rule says 'multiple'.
// The API declares it 'single'.
const LOOKS_MULTI_IS_SINGLE = 'Which operator maps values?';

const QUESTIONS = [
  {
    questionText: LOOKS_SINGLE_IS_MULTI,
    explanation: 'e',
    options: [{ text: 'map', correct: true }, { text: 'filter' }]
  },
  {
    questionText: LOOKS_MULTI_IS_SINGLE,
    explanation: 'e',
    options: [{ text: 'map', correct: true }, { text: 'of', correct: true }]
  }
];

const BANK = [{ quizId: QUIZ, milestone: 'RxJS', questions: QUESTIONS }] as unknown as Quiz[];

const API_RESPONSE = {
  quizId: QUIZ,
  questions: [
    { questionText: LOOKS_SINGLE_IS_MULTI, type: 'multiple', difficulty: null, options: [{ text: 'map' }, { text: 'filter' }] },
    { questionText: LOOKS_MULTI_IS_SINGLE, type: 'single', difficulty: null, options: [{ text: 'map' }, { text: 'of' }] }
  ]
};

if (typeof (globalThis as any).structuredClone !== 'function') {
  (globalThis as any).structuredClone = (value: unknown) => JSON.parse(JSON.stringify(value));
}

let http: HttpTestingController;
let registry: TopicQuizTypeRegistry;
let quizService: QuizService;

/** The exact rule answer.component applies. */
const resolveType = (questionText: string, options: readonly { correct?: boolean }[]) => {
  const declared = registry.isMultiAnswer(questionText);
  if (declared !== null) return declared ? 'multiple' : 'single';
  return options.filter((o) => o.correct === true).length > 1 ? 'multiple' : 'single';
};

beforeEach(() => {
  setQuizDataCache(JSON.parse(JSON.stringify(BANK)) as Quiz[], []);

  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: API_BASE_URL, useValue: BASE },
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } }
    ]
  });

  http = TestBed.inject(HttpTestingController);
  registry = TestBed.inject(TopicQuizTypeRegistry);
  quizService = TestBed.inject(QuizService);
  (quizService as any).quizId = QUIZ;
});

afterEach(() => {
  for (const req of http.match((r) => r.url.endsWith('/questions'))) req.flush(API_RESPONSE);
  http.verify();
  setQuizDataCache([], []);
});

describe('entering a quiz populates the registry', () => {
  it('initializeData requests this quiz\'s declared types', () => {
    quizService.initializeData();

    const req = http.expectOne({ method: 'GET', url: URL });
    expect(req.request.method).toBe('GET');
    req.flush(API_RESPONSE);

    expect(registry.ready()).toBe(true);
  });

  it('does not refetch when the same quiz is re-entered', () => {
    quizService.initializeData();
    http.expectOne({ method: 'GET', url: URL }).flush(API_RESPONSE);

    quizService.initializeData();
    quizService.initializeData();

    http.expectNone({ method: 'GET', url: URL });
  });
});

describe('the declared type OVERRULES the local correct-option count', () => {
  beforeEach(() => {
    quizService.initializeData();
    http.expectOne({ method: 'GET', url: URL }).flush(API_RESPONSE);
  });

  it('a question the bank makes look SINGLE resolves as multiple', () => {
    const q = QUESTIONS[0]!;
    // A count-based rule would say 'single' here — one correct option.
    expect(q.options.filter((o) => (o as { correct?: boolean }).correct === true).length).toBe(1);

    expect(resolveType(q.questionText, q.options)).toBe('multiple');
  });

  it('a question the bank makes look MULTIPLE resolves as single', () => {
    const q = QUESTIONS[1]!;
    // A count-based rule would say 'multiple' here — two correct options.
    expect(q.options.filter((o) => (o as { correct?: boolean }).correct === true).length).toBe(2);

    expect(resolveType(q.questionText, q.options)).toBe('single');
  });

  it('resolves correctly regardless of question ORDER (shuffle-safe)', () => {
    // Identity is question TEXT, so a shuffled display order changes nothing.
    for (const q of [...QUESTIONS].reverse()) {
      const expected = q.questionText === LOOKS_SINGLE_IS_MULTI ? 'multiple' : 'single';
      expect(resolveType(q.questionText, q.options)).toBe(expected);
    }
  });
});

describe('a registry MISS falls back rather than defaulting', () => {
  it('falls back to the count while the request is still in flight', () => {
    quizService.initializeData();

    // Mid-flight: the registry knows nothing yet.
    expect(registry.isMultiAnswer(LOOKS_MULTI_IS_SINGLE)).toBeNull();
    // …so the existing count-based rule applies, NOT a silent 'single'.
    expect(resolveType(LOOKS_MULTI_IS_SINGLE, QUESTIONS[1]!.options)).toBe('multiple');

    http.expectOne({ method: 'GET', url: URL }).flush(API_RESPONSE);
  });

  it('falls back for a question the API never mentioned', () => {
    quizService.initializeData();
    http.expectOne({ method: 'GET', url: URL }).flush({ quizId: QUIZ, questions: [] });

    expect(resolveType(LOOKS_MULTI_IS_SINGLE, QUESTIONS[1]!.options)).toBe('multiple');
  });

  it('a FAILED load falls back instead of breaking the quiz', () => {
    quizService.initializeData();
    http.expectOne({ method: 'GET', url: URL }).error(new ProgressEvent('network error'));

    // Type is not correctness — an unavailable API must not break rendering
    // during this transitional slice.
    expect(registry.ready()).toBe(false);
    expect(resolveType(LOOKS_SINGLE_IS_MULTI, QUESTIONS[0]!.options)).toBe('single');
  });
});

describe('trueFalse', () => {
  it('is treated as single-SELECTION, not as multiple', () => {
    quizService.initializeData();
    http.expectOne({ method: 'GET', url: URL }).flush({
      quizId: QUIZ,
      questions: [{
        questionText: 'Is a Subject also an Observable?',
        type: 'trueFalse', difficulty: null,
        options: [{ text: 'True' }, { text: 'False' }]
      }]
    });

    // `type` here drives radio-vs-checkbox, which is a selection concern.
    expect(registry.typeOf('Is a Subject also an Observable?')).toBe('trueFalse');
    expect(registry.isMultiAnswer('Is a Subject also an Observable?')).toBe(false);
  });
});
