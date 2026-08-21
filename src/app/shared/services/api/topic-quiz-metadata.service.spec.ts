import { TestBed } from '@angular/core/testing';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';

import { API_BASE_URL } from '../../tokens/api-base-url.token';
import { TopicQuizMetadataService } from './topic-quiz-metadata.service';

/**
 * Facts come from `GET /quizzes` and from nowhere else.
 *
 * The point of these is the NEGATIVE half: a failed or empty response must
 * leave the Results panel with nothing to show, never send anyone to the local
 * bank. That is the dependency the metadata cutover removes.
 */

const BASE = 'http://api.test/api';

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

  it('FAILS SOFT: a network error yields no facts and does NOT throw', () => {
    let errored = false;
    let completed = false;
    service.load().subscribe({
      error: () => { errored = true; },
      complete: () => { completed = true; }
    });
    http.expectOne(`${BASE}/quizzes`).error(new ProgressEvent('network error'));

    expect(errored).toBe(false);
    expect(completed).toBe(true);
    expect(service.factsFor('rxjs')).toEqual([]);
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
