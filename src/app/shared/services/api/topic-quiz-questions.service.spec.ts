import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { API_BASE_URL } from '../../tokens/api-base-url.token';
import {
  TopicQuizQuestionsError,
  TopicQuizQuestionsService,
  type TopicQuizQuestionView
} from './topic-quiz-questions.service';

/**
 * Topic Quiz question loading from the API.
 *
 * The properties worth protecting: the request carries no identifiers, the
 * response cannot smuggle correctness through to a consumer, and failure is
 * closed — there is no path back to the bundled bank.
 */

const BASE = 'https://api.test/api';
const QUIZ = 'rxjs';
const URL = `${BASE}/quizzes/${QUIZ}/questions`;

const RESPONSE = {
  quizId: QUIZ,
  questions: [
    {
      questionText: 'Which operator maps values?',
      type: 'single',
      difficulty: 'beginner',
      options: [{ text: 'map' }, { text: 'filter' }]
    },
    {
      questionText: 'Select every operator',
      type: 'multiple',
      difficulty: null,
      options: [{ text: 'map' }, { text: 'filter' }, { text: 'Observable' }]
    },
    {
      questionText: 'Is a Subject also an Observable?',
      type: 'trueFalse',
      difficulty: 'advanced',
      options: [{ text: 'True' }, { text: 'False' }]
    }
  ]
};

let http: HttpTestingController;
let service: TopicQuizQuestionsService;

beforeEach(() => {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: API_BASE_URL, useValue: BASE }
    ]
  });
  http = TestBed.inject(HttpTestingController);
  service = TestBed.inject(TopicQuizQuestionsService);
});

afterEach(() => http.verify());

/** Load and flush, returning the mapped views. */
function load(body: unknown = RESPONSE): TopicQuizQuestionView[] {
  let views: readonly TopicQuizQuestionView[] = [];
  service.loadQuestions(QUIZ).subscribe({
    next: (v) => (views = v),
    error: () => undefined
  });
  http.expectOne({ method: 'GET', url: URL }).flush(body as object);
  return [...views];
}

describe('the request', () => {
  it('GETs the public questions endpoint with no identifiers', () => {
    service.loadQuestions(QUIZ).subscribe({ error: () => undefined });

    const req = http.expectOne({ method: 'GET', url: URL });
    expect(req.request.method).toBe('GET');
    expect(req.request.body).toBeNull();
    // Identity is the quizId in the path. Nothing else is sent.
    expect(req.request.urlWithParams).toBe(URL);

    req.flush(RESPONSE);
  });

  it('encodes the quiz id rather than interpolating it raw', () => {
    service.loadQuestions('a b/c').subscribe({ error: () => undefined });

    const req = http.expectOne((r) => r.url.startsWith(`${BASE}/quizzes/`));
    expect(req.request.url).toBe(`${BASE}/quizzes/a%20b%2Fc/questions`);
    req.flush({ quizId: 'a b/c', questions: RESPONSE.questions });
  });

  it('refuses an empty quiz id without calling the API', () => {
    let error: unknown;
    service.loadQuestions('').subscribe({ error: (e) => (error = e) });

    expect(error).toBeInstanceOf(TopicQuizQuestionsError);
    http.expectNone(() => true);
  });
});

describe('the mapped questions', () => {
  it('preserves text, declared type and difficulty in source order', () => {
    const views = load();

    expect(views.length).toBe(3);
    expect(views.map((v) => v.questionText)).toEqual([
      'Which operator maps values?',
      'Select every operator',
      'Is a Subject also an Observable?'
    ]);
    expect(views.map((v) => v.type)).toEqual(['single', 'multiple', 'trueFalse']);
    expect(views.map((v) => v.difficulty)).toEqual(['beginner', null, 'advanced']);
  });

  it('preserves exact option text and order', () => {
    expect(load()[1]!.options.map((o) => o.text)).toEqual(['map', 'filter', 'Observable']);
  });

  it('exposes ONLY text on an option', () => {
    const option = load()[0]!.options[0]!;
    expect(Object.keys(option)).toEqual(['text']);
  });

  it('exposes only the five public fields on a question', () => {
    // `correctCount` joined them deliberately (S2): the cardinality behind the
    // "(N answers are correct)" banner. Identity is still absent — see below.
    expect(Object.keys(load()[0]!).sort())
      .toEqual(['correctCount', 'difficulty', 'options', 'questionText', 'type']);
  });
});

describe('the response cannot smuggle correctness through', () => {
  it('drops a `correct` flag if the server ever sent one', () => {
    // Field-by-field mapping, not a spread — so an unexpected field cannot
    // reach a consumer even if the endpoint regressed.
    const views = load({
      quizId: QUIZ,
      questions: [{
        questionText: 'Q?',
        type: 'single',
        difficulty: null,
        options: [{ text: 'A', correct: true }, { text: 'B', correct: false }]
      }]
    });

    expect(views[0]!.options[0]).toEqual({ text: 'A' });

    // STRICTER than the substring ban this replaces, which `correctCount` now
    // trips for the wrong reason. Cardinality is allowed; IDENTITY is not — so
    // assert on the shape rather than on the letters:
    //   every option carries `text` and nothing else, and
    //   no correctness flag survives anywhere in the mapped views.
    for (const view of views) {
      for (const option of view.options) {
        expect(Object.keys(option)).toEqual(['text']);
      }
    }
    const wire = JSON.stringify(views);
    expect(wire).not.toContain('"correct"');
    expect(wire).not.toContain('isCorrect');
    expect(wire).not.toContain('true');
    expect(wire).not.toContain('false');
  });

  it('drops explanation and identifier fields', () => {
    const views = load({
      quizId: QUIZ,
      questions: [{
        questionText: 'Q?',
        type: 'single',
        difficulty: null,
        explanation: 'LEAKED',
        questionId: 'q-1',
        options: [{ text: 'A', optionId: 7 }]
      }]
    });

    const raw = JSON.stringify(views);
    expect(raw).not.toContain('LEAKED');
    expect(raw).not.toContain('questionId');
    expect(raw).not.toContain('optionId');
  });
});

describe('failure is closed', () => {
  const expectError = (body: unknown, status = 200) => {
    let error: unknown;
    service.loadQuestions(QUIZ).subscribe({ error: (e) => (error = e) });
    const req = http.expectOne({ method: 'GET', url: URL });
    if (status === 200) req.flush(body as object);
    else req.flush(body as object, { status, statusText: 'Error' });
    expect(error).toBeInstanceOf(TopicQuizQuestionsError);
  };

  it('a network failure errors rather than falling back', () => {
    let error: unknown;
    service.loadQuestions(QUIZ).subscribe({ error: (e) => (error = e) });
    http.expectOne({ method: 'GET', url: URL }).error(new ProgressEvent('network error'));

    expect(error).toBeInstanceOf(TopicQuizQuestionsError);
  });

  it('a 500 errors', () => expectError({ message: 'boom' }, 500));
  it('a missing questions array errors', () => expectError({ quizId: QUIZ }));

  it('an UNDECLARED question type errors rather than being guessed', () => {
    // The local path inferred type by counting correct options. Guessing here
    // would need the answer key, so an unknown type is a hard failure.
    expectError({
      quizId: QUIZ,
      questions: [{ questionText: 'Q?', type: 'mystery', difficulty: null, options: [{ text: 'A' }] }]
    });
  });

  it('a question with no options errors', () => {
    expectError({
      quizId: QUIZ,
      questions: [{ questionText: 'Q?', type: 'single', difficulty: null, options: [] }]
    });
  });

  it('an option with no text errors', () => {
    expectError({
      quizId: QUIZ,
      questions: [{ questionText: 'Q?', type: 'single', difficulty: null, options: [{ text: '' }] }]
    });
  });

  it('does not leak server error detail to the caller', () => {
    let error: unknown;
    service.loadQuestions(QUIZ).subscribe({ error: (e) => (error = e) });
    http.expectOne({ method: 'GET', url: URL })
      .flush({ message: 'stack trace from server' }, { status: 400, statusText: 'Bad Request' });

    expect((error as Error).message).toBe('Could not load questions');
    expect(JSON.stringify(error)).not.toContain('stack trace');
  });
});
