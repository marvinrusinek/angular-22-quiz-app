import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { QqcInitializerService } from './qqc-initializer.service';
import { API_BASE_URL } from '../../../tokens/api-base-url.token';

/**
 * Which question a deep link points at.
 *
 * This parser turns the route's 1-based `:index` into the app's 0-based index,
 * and its result is written straight to `QuizService.currentQuestionIndex`.
 *
 * The bug it exists to prevent: the upper bound was checked unconditionally,
 * including on a cold load where `totalQuestions` is still 0 because the
 * questions have not arrived. Every index then failed `index > 0` and was
 * rewritten to 1. A deep link to /quiz/question/forms/6 set the app's current
 * index to 0, so the heading rendered question 1 while the URL said question 6
 * — visible only after the first click, when the heading recomputed and read
 * the overwritten index. Deep links to question 1 were unaffected, which is
 * why it survived so long.
 *
 * The URL is the authority for which question is displayed. When the count is
 * unknown there is nothing to validate against, so the param must stand.
 */

// jsdom has no structuredClone; QuizDataLoaderService uses it at construction.
if (typeof (globalThis as any).structuredClone !== 'function') {
  (globalThis as any).structuredClone = (v: unknown) => JSON.parse(JSON.stringify(v));
}

let initializer: QqcInitializerService;

beforeEach(() => {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } },
      { provide: API_BASE_URL, useValue: 'https://api.test/api' },
      QqcInitializerService
    ]
  });
  initializer = TestBed.inject(QqcInitializerService);
});

const parse = (rawParam: string | null, totalQuestions: number) =>
  initializer.handleRouteChangeParsing({ rawParam, totalQuestions });

describe('a deep link survives a cold load', () => {
  it('keeps question 6 when the question count has not arrived yet', () => {
    // THE REGRESSION. totalQuestions is 0 during a cold load; this used to
    // collapse to 0 and silently move the user to question 1.
    expect(parse('6', 0)).toBe(5);
  });

  it('keeps question 6 once the count IS known', () => {
    expect(parse('6', 10)).toBe(5);
  });

  it('is unaffected for question 1 — the case that always worked', () => {
    expect(parse('1', 0)).toBe(0);
    expect(parse('1', 10)).toBe(0);
  });

  it('treats a missing or non-numeric count as unknown rather than zero-length', () => {
    expect(parse('4', Number.NaN)).toBe(3);
    expect(parse('4', undefined as unknown as number)).toBe(3);
  });
});

describe('the bound still applies once the count is known', () => {
  it('rejects an index past the end', () => {
    expect(parse('11', 10)).toBe(0);
  });

  it('rejects zero and negatives regardless of the count', () => {
    expect(parse('0', 10)).toBe(0);
    expect(parse('0', 0)).toBe(0);
    expect(parse('-3', 10)).toBe(0);
    expect(parse('-3', 0)).toBe(0);
  });

  it('falls back to the first question for a non-numeric param', () => {
    expect(parse('abc', 10)).toBe(0);
    expect(parse(null, 10)).toBe(0);
  });
});
