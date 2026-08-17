import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting
} from '@angular/common/http/testing';

import {
  questionFromApiView,
  questionsFromApiViews,
  questionTypeFromApi
} from './topic-quiz-content';
import {
  TopicQuizQuestionsService,
  type TopicQuizQuestionView
} from '../services/api/topic-quiz-questions.service';
import { API_BASE_URL } from '../tokens/api-base-url.token';
import { QuestionType } from '../models/question-type.enum';
import * as quizDataCache from '../quiz-data-cache';

/**
 * TOPIC QUIZ QUESTION CONTENT COMES FROM THE API.
 *
 * `questionText`, the option texts, the type and the order used to be read off
 * `assets/data/quiz.json` — the same objects that carried `correct` and
 * `explanation`. That is what made the bundled answer key a RENDERING
 * dependency rather than only a correctness one.
 *
 * The mapper here is the seam. What it must NOT produce is as important as what
 * it must: no `correct` on any option, no `explanation`, no `answer`. Inventing
 * `correct: false` would be a claim that an option is wrong; absence is the
 * only honest representation of "the server did not say".
 */

const BASE = 'https://api.test/api';

const view = (over: Partial<TopicQuizQuestionView> = {}): TopicQuizQuestionView => ({
  questionText: 'API QUESTION',
  type: 'multiple',
  difficulty: 'advanced',
  correctCount: 2,
  options: [{ text: 'API OPTION ONE' }, { text: 'API OPTION TWO' }, { text: 'API OPTION THREE' }],
  ...over
});

describe('the mapped question carries content and nothing else', () => {
  it('takes questionText and option text from the API view', () => {
    const q = questionFromApiView(view(), 0);
    expect(q.questionText).toBe('API QUESTION');
    expect(q.options.map((o) => o.text))
      .toEqual(['API OPTION ONE', 'API OPTION TWO', 'API OPTION THREE']);
  });

  it('NEVER puts `correct` on an option', () => {
    for (const option of questionFromApiView(view(), 0).options) {
      expect('correct' in option).toBe(false);
    }
  });

  it('NEVER puts an explanation on the question', () => {
    const q = questionFromApiView(view(), 0);
    expect('explanation' in q).toBe(false);
    expect(q.explanation).toBeUndefined();
  });

  it('NEVER builds an `answer` array — that is the key by another name', () => {
    expect('answer' in questionFromApiView(view(), 0)).toBe(false);
  });

  it('emits no correctness or explanation KEY anywhere in the object', () => {
    // Asserted on keys rather than substrings: the enum value for a
    // multiple-answer question is literally `multiple_answer`, so a substring
    // ban on "answer" would fail on the TYPE and prove nothing about the key.
    const keysDeep = (v: unknown, out: string[] = []): string[] => {
      if (v === null || typeof v !== 'object') return out;
      if (Array.isArray(v)) { for (const i of v) keysDeep(i, out); return out; }
      for (const [k, nested] of Object.entries(v)) { out.push(k); keysDeep(nested, out); }
      return out;
    };

    const keys = new Set(keysDeep(questionsFromApiViews([view(), view({ type: 'single' })])));
    for (const banned of ['correct', 'isCorrect', 'explanation', 'answer', 'selectedOptions']) {
      expect(keys.has(banned)).toBe(false);
    }
    // Not vacuous — the content keys really are there.
    expect(keys.has('questionText')).toBe(true);
    expect(keys.has('text')).toBe(true);
  });
});

describe('C. the declared API type wins', () => {
  it('maps each server type to the app enum, keeping trueFalse distinct', () => {
    expect(questionTypeFromApi('single')).toBe(QuestionType.SingleAnswer);
    expect(questionTypeFromApi('multiple')).toBe(QuestionType.MultipleAnswer);
    expect(questionTypeFromApi('trueFalse')).toBe(QuestionType.TrueFalse);
  });

  it('a MULTIPLE question with one correct option stays multiple', () => {
    // The count never decides the type — that inference is what the
    // type-authority work removed.
    expect(questionFromApiView(view({ type: 'multiple', correctCount: 1 }), 0).type)
      .toBe(QuestionType.MultipleAnswer);
  });

  it('a SINGLE question with three correct options stays single', () => {
    expect(questionFromApiView(view({ type: 'single', correctCount: 3 }), 0).type)
      .toBe(QuestionType.SingleAnswer);
  });
});

describe('order and option identity', () => {
  it('preserves the server order', () => {
    const qs = questionsFromApiViews([
      view({ questionText: 'FIRST' }), view({ questionText: 'SECOND' }), view({ questionText: 'THIRD' })
    ]);
    expect(qs.map((q) => q.questionText)).toEqual(['FIRST', 'SECOND', 'THIRD']);
  });

  it('assigns option ids on the legacy positional scheme', () => {
    // (qIdx + 1) * 100 + (oIdx + 1) — kept so anything still keyed on an option
    // id survives the cutover. Local render ids only; the server is text-keyed.
    expect(questionFromApiView(view(), 0).options.map((o) => o.optionId)).toEqual([101, 102, 103]);
    expect(questionFromApiView(view(), 2).options.map((o) => o.optionId)).toEqual([301, 302, 303]);
  });

  it('gives every option a displayOrder matching its position', () => {
    expect(questionFromApiView(view(), 0).options.map((o) => o.displayOrder)).toEqual([0, 1, 2]);
  });
});

describe('E. a quiz renders with no local bank present at all', () => {
  it('produces usable questions from views alone', () => {
    const spy = jest.spyOn(quizDataCache, 'getQuizData');
    const qs = questionsFromApiViews([view(), view({ type: 'trueFalse', questionText: 'T/F?' })]);

    expect(qs).toHaveLength(2);
    expect(qs[0]!.options.length).toBeGreaterThan(0);
    expect(qs[1]!.type).toBe(QuestionType.TrueFalse);
    // The mapper is pure — it cannot consult the bank even if one exists.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('the questions request is shared, not duplicated', () => {
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
    service = TestBed.inject(TopicQuizQuestionsService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('issues ONE request for two consumers of the same quiz', () => {
    // The type registry and the content loader both want this payload. Two
    // requests would be a wasted round trip and a chance for them to disagree.
    const seen: unknown[] = [];
    service.loadQuestions('rxjs').subscribe((v) => seen.push(v));
    service.loadQuestions('rxjs').subscribe((v) => seen.push(v));

    http.expectOne(`${BASE}/quizzes/rxjs/questions`).flush({
      quizId: 'rxjs',
      questions: [{ questionText: 'Q', type: 'single', difficulty: null, correctCount: 1, options: [{ text: 'A' }] }]
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(seen[1]);
  });

  it('replays the cached response to a LATE subscriber without refetching', () => {
    service.loadQuestions('rxjs').subscribe();
    http.expectOne(`${BASE}/quizzes/rxjs/questions`).flush({
      quizId: 'rxjs',
      questions: [{ questionText: 'Q', type: 'single', difficulty: null, correctCount: 1, options: [{ text: 'A' }] }]
    });

    let late: readonly TopicQuizQuestionView[] | null = null;
    service.loadQuestions('rxjs').subscribe((v) => { late = v; });
    expect(late).not.toBeNull();
    http.expectNone(`${BASE}/quizzes/rxjs/questions`);
  });

  it('keeps quizzes separate', () => {
    service.loadQuestions('rxjs').subscribe();
    service.loadQuestions('signals').subscribe();
    http.expectOne(`${BASE}/quizzes/rxjs/questions`).flush({ quizId: 'rxjs', questions: [] });
    http.expectOne(`${BASE}/quizzes/signals/questions`).flush({ quizId: 'signals', questions: [] });
  });

  it('does NOT cache a failure — the next attempt re-requests', () => {
    // A cached rejection would make one flaky response permanent for the session.
    service.loadQuestions('rxjs').subscribe({ next: () => undefined, error: () => undefined });
    http.expectOne(`${BASE}/quizzes/rxjs/questions`)
      .flush('boom', { status: 500, statusText: 'Server Error' });

    service.loadQuestions('rxjs').subscribe({ next: () => undefined, error: () => undefined });
    http.expectOne(`${BASE}/quizzes/rxjs/questions`).flush({ quizId: 'rxjs', questions: [] });
  });
});
