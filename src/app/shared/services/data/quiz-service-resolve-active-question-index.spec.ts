/**
 * Contract tests for `QuizService.resolveActiveQuestionIndex(inputIdx?)`.
 *
 * This helper was added as the canonical fix for A5 (question-index
 * resolution duplicated ~6 ways). Its priority order is:
 *
 *   1. `inputIdx` if it's a valid number >= 0
 *   2. `this.getCurrentQuestionIndex()` if valid >= 0
 *   3. `this.currentQuestionIndex` if finite >= 0
 *   4. 0
 *
 * A "moderate scope" migration in 2026-05 tried to switch 10 inline
 * `quizService.currentQuestionIndex ?? this.currentQuestionIndex()`
 * sites in option-item.component to call this helper — and it broke
 * the Next button on rapid Q1→Q2→Q1→Q2 in shuffled mode. The inline
 * pattern's service-first order was load-bearing during click-pipeline
 * race windows.
 *
 * These tests lock down the helper's behavior so any future refactor
 * stays compatible with how the 4 sites that DO use it (option-item's
 * private resolveQuestionIndex, etc.) expect it to behave.
 */
// jsdom doesn't expose structuredClone in some versions; polyfill before
// the QuizService module is loaded (its field initializer calls it).
if (typeof (globalThis as any).structuredClone !== 'function') {
  (globalThis as any).structuredClone = (v: any) => JSON.parse(JSON.stringify(v));
}

import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { QuizService } from './quiz.service';

describe('QuizService.resolveActiveQuestionIndex', () => {
  let service: QuizService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) }
        }
      ]
    });
    service = TestBed.inject(QuizService);
    // Reset signal-backed index to a known value
    service.currentQuestionIndex = 0;
  });

  // ── input-first priority ──────────────────────────────────────────

  it('returns inputIdx when input is a non-negative number (takes priority over service)', () => {
    service.currentQuestionIndex = 5;
    expect(service.resolveActiveQuestionIndex(2)).toBe(2);
  });

  it('returns inputIdx=0 (valid, takes priority)', () => {
    service.currentQuestionIndex = 3;
    expect(service.resolveActiveQuestionIndex(0)).toBe(0);
  });

  // ── input invalid → falls through to service ──────────────────────

  it('falls back to service index when input is undefined', () => {
    service.currentQuestionIndex = 4;
    expect(service.resolveActiveQuestionIndex(undefined)).toBe(4);
  });

  it('falls back to service index when input is null', () => {
    service.currentQuestionIndex = 4;
    expect(service.resolveActiveQuestionIndex(null)).toBe(4);
  });

  it('falls back to service index when input is negative', () => {
    service.currentQuestionIndex = 2;
    expect(service.resolveActiveQuestionIndex(-1)).toBe(2);
  });

  it('falls back to service index when input is NaN', () => {
    service.currentQuestionIndex = 1;
    expect(service.resolveActiveQuestionIndex(NaN)).toBe(1);
  });

  // ── no valid source → returns 0 ───────────────────────────────────

  it('returns 0 when no input and the service index is 0', () => {
    service.currentQuestionIndex = 0;
    expect(service.resolveActiveQuestionIndex()).toBe(0);
  });

  it('returns 0 when called with no args from a fresh service', () => {
    expect(service.resolveActiveQuestionIndex()).toBe(0);
  });

  // ── never throws ──────────────────────────────────────────────────

  it('does not throw on undefined input', () => {
    expect(() => service.resolveActiveQuestionIndex(undefined)).not.toThrow();
  });

  it('does not throw on null input', () => {
    expect(() => service.resolveActiveQuestionIndex(null)).not.toThrow();
  });

  it('does not throw on NaN input', () => {
    expect(() => service.resolveActiveQuestionIndex(NaN)).not.toThrow();
  });
});
