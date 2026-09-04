import { TestBed } from '@angular/core/testing';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';

import { API_BASE_URL } from '../../tokens/api-base-url.token';
import { TopicQuizMetadataService } from './topic-quiz-metadata.service';

/**
 * Facts come from `GET /quizzes` and from nowhere else — with ONE bundled
 * exception, added to fix the "Topic Quiz tiles take 10-15s to appear on a
 * cold backend" regression: `QUIZ_CATALOG_METADATA`, a safe, metadata-only,
 * no-question/no-answer snapshot that seeds every signal on construction so
 * tiles paint before `GET /quizzes` ever answers (see the constant's own doc
 * comment for the security boundary). `load()`'s response still overwrites
 * it wholesale the moment it lands.
 *
 * The point of the "failed load" tests below is still the NEGATIVE half —
 * proving nothing is fabricated for a quiz the bundled catalog doesn't know
 * about either — but a KNOWN quiz id now correctly keeps showing the bundled
 * placeholder after a failure (never blanks to nothing), which is the whole
 * point of seeding it in the first place. `'rxjs'` is a real bundled entry,
 * so the failure tests use a quiz id absent from the catalog to prove the
 * genuinely-unknown case.
 */

const BASE = 'http://api.test/api';
/** Not in QUIZ_CATALOG_METADATA — proves the truly-unknown case, not just an offline one. */
const UNKNOWN_QUIZ_ID = 'not-a-real-quiz-xyz';

describe('TopicQuizMetadataService', () => {
  let http: HttpTestingController;
  let service: TopicQuizMetadataService;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: BASE },
        TopicQuizMetadataService
      ]
    });
    http = TestBed.inject(HttpTestingController);
    service = TestBed.inject(TopicQuizMetadataService);
  });

  afterEach(() => http.verify());

  function flush(body: Record<string, unknown>): void {
    http.expectOne(`${BASE}/quizzes`).flush(body);
  }

  it('reads facts from the metadata endpoint', () => {
    service.load().subscribe();
    flush({
      quizzes: [
        { quizId: 'rxjs', milestone: 'RxJS', facts: ['A', 'B'], questionCount: 10 },
        { quizId: 'signals', milestone: 'Signals', facts: ['C'], questionCount: 10 }
      ]
    });

    expect(service.factsFor('rxjs')).toEqual(['A', 'B']);
    expect(service.factsFor('signals')).toEqual(['C']);
  });

  it('a quiz with no facts yields an empty list, not undefined', () => {
    service.load().subscribe();
    flush({ quizzes: [{ quizId: 'rxjs', milestone: 'RxJS', questionCount: 10 }] });
    expect(service.factsFor('rxjs')).toEqual([]);
  });

  it('an unknown quiz yields nothing', () => {
    service.load().subscribe();
    flush({ quizzes: [{ quizId: 'rxjs', facts: ['A'] }] });
    expect(service.factsFor('nope')).toEqual([]);
    expect(service.factsFor(null)).toEqual([]);
    expect(service.factsFor(undefined)).toEqual([]);
  });

  it('drops blank and non-string entries rather than rendering them', () => {
    service.load().subscribe();
    flush({ quizzes: [{ quizId: 'rxjs', facts: ['A', '', '   ', 42, null, 'B'] }] });
    expect(service.factsFor('rxjs')).toEqual(['A', 'B']);
  });

  it('FAILS SOFT: a network error yields no facts for an unknown quiz and does NOT throw', () => {
    let errored = false;
    let completed = false;
    service.load().subscribe({
      error: () => { errored = true; },
      complete: () => { completed = true; }
    });
    http.expectOne(`${BASE}/quizzes`).error(new ProgressEvent('network error'));

    expect(errored).toBe(false);
    expect(completed).toBe(true);
    expect(service.factsFor(UNKNOWN_QUIZ_ID)).toEqual([]);
  });

  it('FAILS SOFT, BUT NOT BLANK: a network error keeps the bundled catalog\'s facts for a KNOWN quiz', () => {
    service.load().subscribe();
    http.expectOne(`${BASE}/quizzes`).error(new ProgressEvent('network error'));
    expect(service.factsFor('rxjs').length).toBeGreaterThan(0);
  });

  it('a malformed body is tolerated as "no facts"', () => {
    service.load().subscribe();
    flush({});
    expect(service.factsFor('rxjs')).toEqual([]);
  });

  it('loads at most ONCE, however many callers ask', () => {
    service.load().subscribe();
    service.load().subscribe();
    service.load().subscribe();
    flush({ quizzes: [{ quizId: 'rxjs', facts: ['A'] }] });
    // http.verify() in afterEach proves no second request was issued.
    expect(service.factsFor('rxjs')).toEqual(['A']);
  });

  it('asks the METADATA endpoint — never /questions', () => {
    service.load().subscribe();
    const req = http.expectOne(`${BASE}/quizzes`);
    expect(req.request.method).toBe('GET');
    expect(req.request.url).not.toContain('/questions');
    req.flush({ quizzes: [] });
  });
});

/**
 * Imagery moved to the metadata endpoint alongside facts.
 *
 * The consumers apply `api || bundled`, so the meaningful contract here is that
 * an ABSENT image reports '' rather than undefined — that is what lets the
 * transitional fallback trigger, and what will degrade to "no background" once
 * the asset is deleted.
 */
describe('TopicQuizMetadataService — imagery', () => {
  let http: HttpTestingController;
  let service: TopicQuizMetadataService;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: BASE },
        TopicQuizMetadataService
      ]
    });
    http = TestBed.inject(HttpTestingController);
    service = TestBed.inject(TopicQuizMetadataService);
  });

  afterEach(() => http.verify());

  it('serves the image from the metadata response', () => {
    service.load().subscribe();
    http.expectOne(`${BASE}/quizzes`).flush({
      quizzes: [{ quizId: 'rxjs', image: 'https://cdn.test/rxjs.png', facts: [] }]
    });
    expect(service.imageFor('rxjs')).toBe('https://cdn.test/rxjs.png');
  });

  it('reports an EMPTY STRING when the server gives no image', () => {
    service.load().subscribe();
    http.expectOne(`${BASE}/quizzes`).flush({ quizzes: [{ quizId: 'rxjs', facts: [] }] });
    // '' is what makes `api || bundled` fall through to the transitional value.
    expect(service.imageFor('rxjs')).toBe('');
    expect(service.imageFor('unknown')).toBe('');
    expect(service.imageFor(null)).toBe('');
  });

  it('ignores blank and non-string images rather than serving them', () => {
    service.load().subscribe();
    http.expectOne(`${BASE}/quizzes`).flush({
      quizzes: [
        { quizId: 'a', image: '   ' },
        { quizId: 'b', image: 42 },
        { quizId: 'c', image: 'https://cdn.test/c.png' }
      ]
    });
    expect(service.imageFor('a')).toBe('');
    expect(service.imageFor('b')).toBe('');
    expect(service.imageFor('c')).toBe('https://cdn.test/c.png');
  });

  it('a failed load leaves an UNKNOWN quiz\'s imagery empty — consumers fall back, never crash', () => {
    service.load().subscribe();
    http.expectOne(`${BASE}/quizzes`).error(new ProgressEvent('offline'));
    expect(service.imageFor(UNKNOWN_QUIZ_ID)).toBe('');
  });

  it('a failed load keeps a KNOWN quiz\'s bundled-catalog imagery, never blanks it', () => {
    service.load().subscribe();
    http.expectOne(`${BASE}/quizzes`).error(new ProgressEvent('offline'));
    expect(service.imageFor('rxjs')).not.toBe('');
  });

  it('facts and imagery arrive from the SAME single request', () => {
    service.load().subscribe();
    http.expectOne(`${BASE}/quizzes`).flush({
      quizzes: [{ quizId: 'rxjs', image: 'https://cdn.test/rxjs.png', facts: ['A'] }]
    });
    expect(service.imageFor('rxjs')).toBe('https://cdn.test/rxjs.png');
    expect(service.factsFor('rxjs')).toEqual(['A']);
  });
});

/**
 * Difficulty (S6d) — the field achievement evaluation reads to group quizzes,
 * replacing getQuizData()'s answer-bearing bundled bank as that source.
 *
 * Unlike image/milestone, an entry is captured even when its difficulty is
 * absent: achievement evaluation enumerates this map's KEYS as the full known-
 * quiz set (mirroring what iterating the bundled Quiz[] array used to give it),
 * so a quiz missing difficulty must still exist in the map, just with a null
 * value that no `inDifficulty` filter will ever match.
 */
describe('TopicQuizMetadataService — difficulty', () => {
  let http: HttpTestingController;
  let service: TopicQuizMetadataService;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: BASE },
        TopicQuizMetadataService
      ]
    });
    http = TestBed.inject(HttpTestingController);
    service = TestBed.inject(TopicQuizMetadataService);
  });

  afterEach(() => http.verify());

  it('reads difficulty from the metadata endpoint', () => {
    service.load().subscribe();
    http.expectOne(`${BASE}/quizzes`).flush({
      quizzes: [
        { quizId: 'rxjs', difficulty: 'intermediate' },
        { quizId: 'signals', difficulty: 'beginner' }
      ]
    });
    const byQuiz = service.difficultyByQuiz();
    expect(byQuiz.get('rxjs')).toBe('intermediate');
    expect(byQuiz.get('signals')).toBe('beginner');
  });

  it('still records the quiz (as null) when difficulty is absent — the key must exist', () => {
    service.load().subscribe();
    http.expectOne(`${BASE}/quizzes`).flush({ quizzes: [{ quizId: 'rxjs' }] });
    const byQuiz = service.difficultyByQuiz();
    expect(byQuiz.has('rxjs')).toBe(true);
    expect(byQuiz.get('rxjs')).toBeNull();
  });

  it('a failed load leaves an UNKNOWN quiz absent from the difficulty map, never throws', () => {
    service.load().subscribe();
    http.expectOne(`${BASE}/quizzes`).error(new ProgressEvent('offline'));
    expect(service.difficultyByQuiz().has(UNKNOWN_QUIZ_ID)).toBe(false);
  });

  it('a failed load keeps the bundled catalog\'s difficulty map, never blanks it', () => {
    service.load().subscribe();
    http.expectOne(`${BASE}/quizzes`).error(new ProgressEvent('offline'));
    expect(service.difficultyByQuiz().size).toBeGreaterThan(0);
  });

  it('difficulty arrives from the SAME single request as facts/imagery/milestone', () => {
    service.load().subscribe();
    http.expectOne(`${BASE}/quizzes`).flush({
      quizzes: [{ quizId: 'rxjs', milestone: 'RxJS', image: 'https://cdn.test/rxjs.png', facts: ['A'], difficulty: 'advanced' }]
    });
    expect(service.difficultyByQuiz().get('rxjs')).toBe('advanced');
    expect(service.milestoneFor('rxjs')).toBe('RxJS');
  });
});

/**
 * Question count (S6h) — the field QuizGuard reads for index validation,
 * replacing QuizDataService.getCachedQuizById(...).questions.length (the
 * bundled bank) as that source.
 *
 * Like difficulty, an entry is captured even when the count is absent —
 * QuizGuard distinguishes "quiz unknown to metadata" (key absent) from
 * "quiz known but no count reported" (key present, value null), and treats
 * both as "can't validate, defer to the resolver."
 */
describe('TopicQuizMetadataService — question count', () => {
  let http: HttpTestingController;
  let service: TopicQuizMetadataService;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: BASE },
        TopicQuizMetadataService
      ]
    });
    http = TestBed.inject(HttpTestingController);
    service = TestBed.inject(TopicQuizMetadataService);
  });

  afterEach(() => http.verify());

  it('reads question count from the metadata endpoint', () => {
    service.load().subscribe();
    http.expectOne(`${BASE}/quizzes`).flush({
      quizzes: [
        { quizId: 'rxjs', questionCount: 12 },
        { quizId: 'signals', questionCount: 8 }
      ]
    });
    const byQuiz = service.questionCountByQuiz();
    expect(byQuiz.get('rxjs')).toBe(12);
    expect(byQuiz.get('signals')).toBe(8);
  });

  it('still records the quiz (as null) when questionCount is absent — the key must exist', () => {
    service.load().subscribe();
    http.expectOne(`${BASE}/quizzes`).flush({ quizzes: [{ quizId: 'rxjs' }] });
    const byQuiz = service.questionCountByQuiz();
    expect(byQuiz.has('rxjs')).toBe(true);
    expect(byQuiz.get('rxjs')).toBeNull();
  });

  it('treats a negative or non-finite questionCount as null rather than a bogus number', () => {
    service.load().subscribe();
    http.expectOne(`${BASE}/quizzes`).flush({
      quizzes: [
        { quizId: 'a', questionCount: -1 },
        { quizId: 'b', questionCount: Number.NaN }
      ]
    });
    const byQuiz = service.questionCountByQuiz();
    expect(byQuiz.get('a')).toBeNull();
    expect(byQuiz.get('b')).toBeNull();
  });

  it('a zero questionCount is preserved as 0, not coerced to null', () => {
    service.load().subscribe();
    http.expectOne(`${BASE}/quizzes`).flush({ quizzes: [{ quizId: 'rxjs', questionCount: 0 }] });
    expect(service.questionCountByQuiz().get('rxjs')).toBe(0);
  });

  it('a failed load leaves an UNKNOWN quiz absent from the question-count map, never throws', () => {
    service.load().subscribe();
    http.expectOne(`${BASE}/quizzes`).error(new ProgressEvent('offline'));
    expect(service.questionCountByQuiz().has(UNKNOWN_QUIZ_ID)).toBe(false);
  });

  it('a failed load keeps the bundled catalog\'s question-count map, never blanks it', () => {
    service.load().subscribe();
    http.expectOne(`${BASE}/quizzes`).error(new ProgressEvent('offline'));
    expect(service.questionCountByQuiz().size).toBeGreaterThan(0);
  });

  it('question count arrives from the SAME single request as facts/imagery/milestone/difficulty', () => {
    service.load().subscribe();
    http.expectOne(`${BASE}/quizzes`).flush({
      quizzes: [{ quizId: 'rxjs', milestone: 'RxJS', difficulty: 'advanced', questionCount: 12 }]
    });
    expect(service.questionCountByQuiz().get('rxjs')).toBe(12);
    expect(service.difficultyByQuiz().get('rxjs')).toBe('advanced');
    expect(service.milestoneFor('rxjs')).toBe('RxJS');
  });
});
