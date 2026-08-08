import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { API_BASE_URL } from '../../tokens/api-base-url.token';
import { TopicQuizTypeRegistry } from './topic-quiz-type-registry.service';

/**
 * Question TYPE from the API.
 *
 * The property that matters: an unknown type must read as `null`, never as a
 * default. Treating absence as "single" would silently turn multi-answer
 * questions into single-answer ones while the request is still in flight.
 */

const BASE = 'https://api.test/api';
const QUIZ = 'rxjs';
const URL = `${BASE}/quizzes/${QUIZ}/questions`;

const SINGLE = 'Which operator maps values?';
const MULTI = 'Select every operator';
const TF = 'Is a Subject also an Observable?';

const RESPONSE = {
  quizId: QUIZ,
  questions: [
    { questionText: SINGLE, type: 'single', difficulty: null, options: [{ text: 'map' }, { text: 'of' }] },
    { questionText: MULTI, type: 'multiple', difficulty: null, options: [{ text: 'map' }, { text: 'filter' }] },
    { questionText: TF, type: 'trueFalse', difficulty: null, options: [{ text: 'True' }, { text: 'False' }] }
  ]
};

let http: HttpTestingController;
let registry: TopicQuizTypeRegistry;

beforeEach(() => {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: API_BASE_URL, useValue: BASE }
    ]
  });
  http = TestBed.inject(HttpTestingController);
  registry = TestBed.inject(TopicQuizTypeRegistry);
});

afterEach(() => http.verify());

function loadAndFlush(body: unknown = RESPONSE): void {
  registry.load(QUIZ).subscribe();
  http.expectOne({ method: 'GET', url: URL }).flush(body as object);
}

describe('declared types', () => {
  it('records each question\'s declared type', () => {
    loadAndFlush();

    expect(registry.typeOf(SINGLE)).toBe('single');
    expect(registry.typeOf(MULTI)).toBe('multiple');
    expect(registry.typeOf(TF)).toBe('trueFalse');
    expect(registry.ready()).toBe(true);
  });

  it('answers isMultiAnswer from the declared type', () => {
    loadAndFlush();

    expect(registry.isMultiAnswer(MULTI)).toBe(true);
    expect(registry.isMultiAnswer(SINGLE)).toBe(false);
    // trueFalse is a single-selection question wearing a label.
    expect(registry.isMultiAnswer(TF)).toBe(false);
  });

  it('matches question text ignoring case and surrounding whitespace', () => {
    loadAndFlush();
    expect(registry.typeOf('  SELECT   every OPERATOR  ')).toBe('multiple');
  });
});

describe('unknown is NOT a default', () => {
  it('returns null before the response arrives', () => {
    registry.load(QUIZ).subscribe();

    // Mid-flight: answering "single" here would silently downgrade a
    // multi-answer question.
    expect(registry.typeOf(MULTI)).toBeNull();
    expect(registry.isMultiAnswer(MULTI)).toBeNull();
    expect(registry.ready()).toBe(false);

    http.expectOne({ method: 'GET', url: URL }).flush(RESPONSE);
  });

  it('returns null for a question the API did not mention', () => {
    loadAndFlush();
    expect(registry.typeOf('Not in this quiz')).toBeNull();
    expect(registry.isMultiAnswer('Not in this quiz')).toBeNull();
  });

  it('returns null for empty or missing text', () => {
    loadAndFlush();
    expect(registry.typeOf('')).toBeNull();
    expect(registry.typeOf(null)).toBeNull();
    expect(registry.typeOf(undefined)).toBeNull();
  });
});

describe('failure leaves the registry empty rather than throwing', () => {
  it('a network failure does not reject the caller', () => {
    let errored = false;
    registry.load(QUIZ).subscribe({ error: () => (errored = true) });
    http.expectOne({ method: 'GET', url: URL }).error(new ProgressEvent('network error'));

    // Type is not correctness — an unavailable API must not break the quiz
    // during this transitional slice.
    expect(errored).toBe(false);
    expect(registry.ready()).toBe(false);
    expect(registry.typeOf(MULTI)).toBeNull();
  });

  it('a malformed payload leaves it empty', () => {
    registry.load(QUIZ).subscribe();
    http.expectOne({ method: 'GET', url: URL }).flush({ quizId: QUIZ });

    expect(registry.ready()).toBe(false);
    expect(registry.typeOf(MULTI)).toBeNull();
  });
});

describe('lifecycle', () => {
  it('loads once per quiz however many times entry is called', () => {
    registry.load(QUIZ).subscribe();
    http.expectOne({ method: 'GET', url: URL }).flush(RESPONSE);

    registry.load(QUIZ).subscribe();
    registry.load(QUIZ).subscribe();

    http.expectNone({ method: 'GET', url: URL });
    expect(registry.typeOf(MULTI)).toBe('multiple');
  });

  it('a DIFFERENT quiz refetches and does not serve stale types', () => {
    loadAndFlush();
    expect(registry.typeOf(MULTI)).toBe('multiple');

    registry.load('signals').subscribe();
    // Old types are dropped immediately, before the new response lands.
    expect(registry.typeOf(MULTI)).toBeNull();

    http.expectOne({ method: 'GET', url: `${BASE}/quizzes/signals/questions` }).flush({
      quizId: 'signals',
      questions: [{ questionText: 'What does computed() return?', type: 'single', difficulty: null, options: [{ text: 'A signal' }] }]
    });

    expect(registry.typeOf('What does computed() return?')).toBe('single');
    expect(registry.typeOf(MULTI)).toBeNull();
  });

  it('clear() drops everything', () => {
    loadAndFlush();
    registry.clear();

    expect(registry.typeOf(MULTI)).toBeNull();
    expect(registry.ready()).toBe(false);
  });

  it('stores type strings only — no options, correctness or explanation', () => {
    // Feed a response carrying fields the registry must not retain.
    registry.load(QUIZ).subscribe();
    http.expectOne({ method: 'GET', url: URL }).flush({
      quizId: QUIZ,
      questions: [{
        questionText: MULTI,
        type: 'multiple',
        difficulty: null,
        explanation: 'LEAKED',
        options: [{ text: 'map', correct: true }]
      }]
    });

    // Inspect what was actually retained. The registry is not a question
    // store and must not become a second correctness authority.
    const stored = [...(registry as unknown as { types: Map<string, string> }).types.values()];
    expect(stored).toEqual(['multiple']);
    expect(JSON.stringify(stored)).not.toContain('LEAKED');

    // And the public surface offers no way to ask for anything else. Every
    // name here answers "what TYPE is this question?" in some form —
    // `applyDeclaredTypes` writes the type onto locally-loaded questions and
    // `questionTypeOf` returns it as the app's enum. If a name ever appears
    // that could return options, correctness or an explanation, this fails.
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(registry)).sort())
      .toEqual([
        'applyDeclaredTypes', 'clear', 'constructor', 'isMultiAnswer',
        'key', 'load', 'questionTypeOf', 'typeOf'
      ]);
  });
});
