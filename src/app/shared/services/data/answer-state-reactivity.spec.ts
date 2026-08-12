import { TestBed } from '@angular/core/testing';
import { computed, effect } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { QuizService } from './quiz.service';
import { API_BASE_URL } from '../../tokens/api-base-url.token';

/**
 * ASYNC ANSWER STATE MUST BE OBSERVABLE.
 *
 * `questionResolved` / `multiAnswerCompletion` / `multiAnswerPerfect` were plain
 * Maps. That was survivable while every writer ran on the click: the selection
 * signals changed in the same turn, so OnPush consumers re-rendered and happened
 * to read the new value on the way past.
 *
 * Completion now arrives ASYNCHRONOUSLY from the authorized verdict. A plain Map
 * mutated inside a subscription notifies nobody — the state was correct and the
 * view never looked again. That is precisely what broke the option-item render
 * migration: grey-out, the visible score and the FET gate all read state that
 * had already arrived.
 *
 * The tests below would FAIL against the plain-Map implementation, because a
 * computed over it would never recompute.
 */

// jsdom has no structuredClone; QuizService clones the quiz bundle on construction.
(globalThis as any).structuredClone ??= (v: unknown) => JSON.parse(JSON.stringify(v));

let quiz: QuizService;

beforeEach(() => {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } },
      { provide: API_BASE_URL, useValue: 'https://api.test/api' }
    ]
  });
  quiz = TestBed.inject(QuizService);
});

describe('an async write is observed by a computed consumer', () => {
  it('recomputes when completion arrives later', () => {
    const view = TestBed.runInInjectionContext(() =>
      computed(() => quiz.isMultiAnswerComplete(2))
    );
    expect(view()).toBe(false);

    // The arrival path writes from a subscription callback — no click, no
    // input change, nothing else to trigger change detection.
    quiz.markMultiAnswerComplete(2);

    expect(view()).toBe(true);
  });

  it('recomputes when resolved arrives later', () => {
    const view = TestBed.runInInjectionContext(() =>
      computed(() => quiz.isQuestionResolved(1))
    );
    expect(view()).toBe(false);

    quiz.markQuestionResolved(1);

    expect(view()).toBe(true);
  });

  it('recomputes when perfect arrives later', () => {
    const view = TestBed.runInInjectionContext(() =>
      computed(() => quiz.isMultiAnswerPerfect(0))
    );
    expect(view()).toBe(false);

    quiz.markMultiAnswerPerfect(0);

    expect(view()).toBe(true);
  });

  it('notifies an effect, which is how a rendered view finds out', () => {
    const seen: boolean[] = [];
    TestBed.runInInjectionContext(() => {
      effect(() => { seen.push(quiz.isMultiAnswerComplete(3)); });
    });
    TestBed.flushEffects();
    expect(seen).toEqual([false]);

    quiz.markMultiAnswerComplete(3);
    TestBed.flushEffects();

    expect(seen).toEqual([false, true]);
  });
});

describe('reactivity did not make the state lazy', () => {
  it('a synchronous read in the same turn sees the write', () => {
    quiz.markQuestionResolved(4);

    expect(quiz.isQuestionResolved(4)).toBe(true);
  });

  it('a repeated identical write does not churn the signal', () => {
    let runs = 0;
    const view = TestBed.runInInjectionContext(() =>
      computed(() => { runs++; return quiz.isQuestionResolved(5); })
    );
    view();
    quiz.markQuestionResolved(5);
    view();
    const after = runs;

    quiz.markQuestionResolved(5);   // same value again
    view();

    expect(runs).toBe(after);
  });
});

describe('clearing is reactive too', () => {
  it('clearing one question notifies consumers', () => {
    const view = TestBed.runInInjectionContext(() =>
      computed(() => quiz.isMultiAnswerComplete(6))
    );
    quiz.markMultiAnswerComplete(6);
    expect(view()).toBe(true);

    quiz.clearAnswerStateAt(6);

    expect(view()).toBe(false);
  });

  it('clearing one question clears all three states together', () => {
    quiz.markQuestionResolved(7);
    quiz.markMultiAnswerComplete(7);
    quiz.markMultiAnswerPerfect(7);

    quiz.clearAnswerStateAt(7);

    expect(quiz.isQuestionResolved(7)).toBe(false);
    expect(quiz.isMultiAnswerComplete(7)).toBe(false);
    expect(quiz.isMultiAnswerPerfect(7)).toBe(false);
  });

  it('a full reset notifies and clears every question', () => {
    const view = TestBed.runInInjectionContext(() =>
      computed(() => quiz.isQuestionResolved(8))
    );
    quiz.markQuestionResolved(8);
    quiz.markQuestionResolved(9);
    expect(view()).toBe(true);

    quiz.clearAllAnswerState();

    expect(view()).toBe(false);
    expect(quiz.isQuestionResolved(9)).toBe(false);
  });

  it('clearing an absent question does not churn the signal', () => {
    let runs = 0;
    const view = TestBed.runInInjectionContext(() =>
      computed(() => { runs++; return quiz.isQuestionResolved(10); })
    );
    view();
    const before = runs;

    quiz.clearAnswerStateAt(10);   // nothing was set
    view();

    expect(runs).toBe(before);
  });
});

describe('the states stay independent, per the hierarchy', () => {
  it('a single-answer question resolves without any multi state', () => {
    quiz.markQuestionResolved(11);

    expect(quiz.isQuestionResolved(11)).toBe(true);
    expect(quiz.isMultiAnswerComplete(11)).toBe(false);
    expect(quiz.isMultiAnswerPerfect(11)).toBe(false);
  });

  it('each question is keyed independently', () => {
    quiz.markMultiAnswerComplete(12);

    expect(quiz.isMultiAnswerComplete(12)).toBe(true);
    expect(quiz.isMultiAnswerComplete(13)).toBe(false);
  });
});
