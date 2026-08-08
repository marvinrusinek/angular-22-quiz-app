import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { API_BASE_URL } from '../tokens/api-base-url.token';
import { QuestionType } from '../models/question-type.enum';
import { TopicQuizTypeRegistry } from '../services/api/topic-quiz-type-registry.service';
import {
  declaredIsMultiAnswer,
  isDeclaredTrueFalse,
  resolveIsMultiAnswer
} from './question-type-authority';
import type { QuizQuestion } from '../models/QuizQuestion.model';

/**
 * Question TYPE must not be a function of the answer key.
 *
 * The runtime used to decide single-vs-multiple by counting options with
 * `correct: true` — in roughly fifty places. That works only while the bank
 * lives in the browser, which is precisely what is being removed. Worse, most
 * of those sites wrote `type === MultipleAnswer || correctCount > 1`, so the
 * local flags could still OVERRIDE an explicit type.
 *
 * These tests are adversarial on purpose: every fixture below has local
 * `correct` flags that CONTRADICT the declared type. If local correctness ever
 * becomes authoritative again, they fail. A test where the two agree would
 * pass either way and prove nothing.
 */

const BASE = 'https://api.test/api';
const QUIZ = 'rxjs';

/** A question whose local flags say MULTI (three correct options). */
function locallyMulti(type?: QuestionType): QuizQuestion {
  return {
    questionText: 'Which operators exist?',
    explanation: '',
    type,
    options: [
      { optionId: 1, text: 'map', correct: true },
      { optionId: 2, text: 'filter', correct: true },
      { optionId: 3, text: 'tap', correct: true }
    ]
  } as unknown as QuizQuestion;
}

/** A question whose local flags say SINGLE (one correct option). */
function locallySingle(type?: QuestionType): QuizQuestion {
  return {
    questionText: 'Which operator maps values?',
    explanation: '',
    type,
    options: [
      { optionId: 1, text: 'map', correct: true },
      { optionId: 2, text: 'Subject' }
    ]
  } as unknown as QuizQuestion;
}

describe('an explicit type beats contradicting local correctness', () => {
  it('declared multiple wins over a local count of one', () => {
    expect(declaredIsMultiAnswer(locallySingle(QuestionType.MultipleAnswer))).toBe(true);
    expect(resolveIsMultiAnswer(locallySingle(QuestionType.MultipleAnswer), false)).toBe(true);
  });

  it('declared single wins over a local count of three', () => {
    expect(declaredIsMultiAnswer(locallyMulti(QuestionType.SingleAnswer))).toBe(false);
    expect(resolveIsMultiAnswer(locallyMulti(QuestionType.SingleAnswer), true)).toBe(false);
  });

  it('declared trueFalse wins over a misleading local count', () => {
    const q = locallyMulti(QuestionType.TrueFalse);
    expect(declaredIsMultiAnswer(q)).toBe(false);
    expect(resolveIsMultiAnswer(q, true)).toBe(false);
  });
});

describe('trueFalse survives as its own type', () => {
  it('is not collapsed into single-answer on the question', () => {
    const q = locallySingle(QuestionType.TrueFalse);
    expect(q.type).toBe(QuestionType.TrueFalse);
    expect(isDeclaredTrueFalse(q)).toBe(true);
  });

  it('answers the narrower cardinality question as single-SELECTION', () => {
    // Consumers that only render radio-vs-checkbox want this; consumers that
    // need the distinction read `type` directly, as the test above does.
    expect(declaredIsMultiAnswer(locallySingle(QuestionType.TrueFalse))).toBe(false);
  });

  it('a declared single is NOT reported as trueFalse', () => {
    expect(isDeclaredTrueFalse(locallySingle(QuestionType.SingleAnswer))).toBe(false);
  });
});

describe('unknown is not single', () => {
  it('reports null rather than guessing when no type is declared', () => {
    expect(declaredIsMultiAnswer(locallyMulti())).toBeNull();
    expect(declaredIsMultiAnswer(null)).toBeNull();
  });

  it('defers to the caller fallback only when undeclared', () => {
    expect(resolveIsMultiAnswer(locallyMulti(), true)).toBe(true);
    expect(resolveIsMultiAnswer(locallyMulti(), false)).toBe(false);
  });
});

describe('the registry stamps declared types onto locally-loaded questions', () => {
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

  function loadTypes(): void {
    registry.load(QUIZ).subscribe();
    http.expectOne(`${BASE}/quizzes/${QUIZ}/questions`).flush({
      quizId: QUIZ,
      questions: [
        { questionText: 'Which operators exist?', type: 'single', difficulty: null, options: [{ text: 'map' }] },
        { questionText: 'Which operator maps values?', type: 'multiple', difficulty: null, options: [{ text: 'map' }] },
        { questionText: 'Observables are lazy.', type: 'trueFalse', difficulty: null, options: [{ text: 'True' }] }
      ]
    });
  }

  it('overwrites a locally-inferred type with the declared one', () => {
    loadTypes();
    // Local flags say multi (3 correct); the API says single.
    const questions = [locallyMulti(), locallySingle()];
    registry.applyDeclaredTypes(questions);

    expect(questions[0].type).toBe(QuestionType.SingleAnswer);
    expect(questions[1].type).toBe(QuestionType.MultipleAnswer);
  });

  it('preserves trueFalse rather than mapping it to single', () => {
    loadTypes();
    const q = { questionText: 'Observables are lazy.', options: [] } as unknown as QuizQuestion;
    registry.applyDeclaredTypes([q]);

    expect(q.type).toBe(QuestionType.TrueFalse);
  });

  it('matches by question TEXT, so shuffling cannot swap types', () => {
    loadTypes();
    // Same questions, reversed display order.
    const shuffled = [locallySingle(), locallyMulti()];
    registry.applyDeclaredTypes(shuffled);

    // 'Which operator maps values?' is declared multiple wherever it sits.
    expect(shuffled[0].type).toBe(QuestionType.MultipleAnswer);
    expect(shuffled[1].type).toBe(QuestionType.SingleAnswer);
  });

  it('is whitespace- and case-insensitive on the text key', () => {
    loadTypes();
    const q = { questionText: '  WHICH   Operators   Exist?  ', options: [] } as unknown as QuizQuestion;
    registry.applyDeclaredTypes([q]);

    expect(q.type).toBe(QuestionType.SingleAnswer);
  });

  it('leaves a question the API does not know completely alone', () => {
    loadTypes();
    const q = { questionText: 'Never seen before', options: [] } as unknown as QuizQuestion;
    registry.applyDeclaredTypes([q]);

    expect(q.type).toBeUndefined();
  });

  it('stamps nothing when the type request failed', () => {
    registry.load(QUIZ).subscribe();
    http.expectOne(`${BASE}/quizzes/${QUIZ}/questions`)
      .flush({ error: 'down' }, { status: 500, statusText: 'Server Error' });

    const q = locallyMulti();
    registry.applyDeclaredTypes([q]);

    // Undeclared, so callers keep their count-based fallback rather than
    // silently treating an outage as "every question is single-answer".
    expect(q.type).toBeUndefined();
    expect(declaredIsMultiAnswer(q)).toBeNull();
  });

  it('drops types on clear so they cannot leak into the next quiz', () => {
    loadTypes();
    registry.clear();

    const q = locallyMulti();
    registry.applyDeclaredTypes([q]);
    expect(q.type).toBeUndefined();
  });
});
