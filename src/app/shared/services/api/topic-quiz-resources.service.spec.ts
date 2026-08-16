import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting
} from '@angular/common/http/testing';

import { TopicQuizResourcesService } from './topic-quiz-resources.service';
import { API_BASE_URL } from '../../tokens/api-base-url.token';
import * as quizDataCache from '../../quiz-data-cache';
import type { Resource } from '../../models/Resource.model';

/**
 * Results-page resource links, from the API.
 *
 * These links were the LAST piece of the quiz bank with no source outside
 * `assets/data/quiz.json`, which is what made them a blocker for deleting that
 * asset. The property that matters most here is therefore negative: a failure
 * must produce an empty list, never a read of the local bank.
 *
 * They are also supplemental — an optional panel on a results page — so unlike
 * `TopicQuizQuestionsService` this one does not fail closed. A results screen
 * that goes blank because a documentation link would not load is a worse
 * outcome than a missing panel.
 */

const BASE = 'https://api.test/api';

let service: TopicQuizResourcesService;
let http: HttpTestingController;

beforeEach(() => {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: API_BASE_URL, useValue: BASE }
    ]
  });
  service = TestBed.inject(TopicQuizResourcesService);
  http = TestBed.inject(HttpTestingController);
});

afterEach(() => http.verify());

const expectOne = (quizId: string) =>
  http.expectOne(`${BASE}/quizzes/${quizId}/resources`);

function collect(quizId: string): { value: Resource[] | null } {
  const out: { value: Resource[] | null } = { value: null };
  service.loadResources(quizId).subscribe((r) => { out.value = r; });
  return out;
}

describe('loading resources', () => {
  it('requests the quiz\'s resources endpoint', () => {
    collect('rxjs');
    expect(expectOne('rxjs').request.method).toBe('GET');
  });

  it('maps title, url and host', () => {
    const got = collect('rxjs');
    expectOne('rxjs').flush({
      quizId: 'rxjs',
      resources: [{ title: 'RxJS docs', url: 'https://rxjs.dev', host: 'RxJS website' }]
    });
    expect(got.value).toEqual([
      { title: 'RxJS docs', url: 'https://rxjs.dev', host: 'RxJS website' }
    ]);
  });

  it('PRESERVES SERVER ORDER — it does not sort', () => {
    // The endpoint orders by `display_order`, which is the source array order.
    // Re-sorting here would silently reorder the rendered panel.
    const got = collect('router');
    expectOne('router').flush({
      quizId: 'router',
      resources: [
        { title: 'Zebra', url: 'https://z.test', host: 'Z' },
        { title: 'Apple', url: 'https://a.test', host: 'A' },
        { title: 'Mango', url: 'https://m.test', host: 'M' }
      ]
    });
    expect(got.value!.map((r) => r.title)).toEqual(['Zebra', 'Apple', 'Mango']);
  });

  it('encodes the quiz id', () => {
    collect('a b/c');
    http.expectOne(`${BASE}/quizzes/a%20b%2Fc/resources`).flush({ quizId: 'a b/c', resources: [] });
  });

  it('does not call the API for an empty quiz id', () => {
    const got = collect('');
    expect(got.value).toEqual([]);
    http.expectNone(`${BASE}/quizzes//resources`);
  });
});

describe('a quiz with no resources', () => {
  it('yields an empty list', () => {
    const got = collect('signals');
    expectOne('signals').flush({ quizId: 'signals', resources: [] });
    expect(got.value).toEqual([]);
  });
});

describe('failure is supplemental, not fatal', () => {
  it('yields an empty list on a server error rather than erroring', () => {
    let errored = false;
    const got: { value: Resource[] | null } = { value: null };
    service.loadResources('rxjs').subscribe({
      next: (r) => { got.value = r; },
      error: () => { errored = true; }
    });
    expectOne('rxjs').flush('boom', { status: 500, statusText: 'Server Error' });

    expect(errored).toBe(false);
    expect(got.value).toEqual([]);
  });

  it('yields an empty list on 404', () => {
    const got = collect('nope');
    expectOne('nope').flush('missing', { status: 404, statusText: 'Not Found' });
    expect(got.value).toEqual([]);
  });

  it('yields an empty list on a network failure', () => {
    const got = collect('rxjs');
    expectOne('rxjs').error(new ProgressEvent('network error'));
    expect(got.value).toEqual([]);
  });

  it('drops malformed items instead of rendering blanks', () => {
    const got = collect('rxjs');
    expectOne('rxjs').flush({
      quizId: 'rxjs',
      resources: [
        { title: 'Good', url: 'https://good.test', host: 'G' },
        { title: '', url: 'https://no-title.test', host: 'X' },
        { title: 'No url', url: '', host: 'X' },
        null,
        { title: 'No host', url: 'https://no-host.test' }
      ]
    });
    expect(got.value).toEqual([
      { title: 'Good', url: 'https://good.test', host: 'G' },
      { title: 'No host', url: 'https://no-host.test', host: '' }
    ]);
  });

  it('yields an empty list when the body is not the expected shape', () => {
    const got = collect('rxjs');
    expectOne('rxjs').flush({ quizId: 'rxjs' });
    expect(got.value).toEqual([]);
  });
});

describe('THE LOCAL BANK IS NEVER READ', () => {
  it('does not touch the quiz-data cache on success', () => {
    const spy = jest.spyOn(quizDataCache, 'getQuizData');
    collect('rxjs');
    expectOne('rxjs').flush({
      quizId: 'rxjs',
      resources: [{ title: 'A', url: 'https://a.test', host: 'A' }]
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('does not touch the quiz-data cache on FAILURE — empty is not a fallback', () => {
    // The whole point of the slice. An error path that reached for the local
    // bank would pass every test and then break the day the asset is deleted.
    const spy = jest.spyOn(quizDataCache, 'getQuizData');
    const got = collect('rxjs');
    expectOne('rxjs').flush('boom', { status: 500, statusText: 'Server Error' });

    expect(got.value).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('issues no request to any local asset path', () => {
    collect('rxjs');
    expectOne('rxjs').flush({ quizId: 'rxjs', resources: [] });
    http.expectNone('assets/data/quiz.json');
    http.expectNone('/assets/data/quiz.json');
  });
});
