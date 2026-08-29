import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { OptionClickHandlerService } from './option-click-handler.service';
import { API_BASE_URL } from '../../../tokens/api-base-url.token';

/**
 * UNKNOWN CORRECTNESS MUST STAY UNKNOWN (pre-S5a).
 *
 * `computeMultiAnswerClickState` used to collapse "the correct set is not
 * known yet" and "zero correct answers are outstanding" into the same
 * `remaining: 0`, because `Math.max(correctIndices.length - correctSelected, 0)`
 * evaluates to 0 either way when `correctIndices` is empty. The one caller
 * that reaches this function without a verdict already authorizing anything
 * (`SocAnswerProcessingService.applyMultiAnswerDisableState`, when the pre-
 * verdict `authorized` fact is null) then read `remaining === 0` as "this
 * question is complete" and marked it resolved after the very first click —
 * reproduced live under the true S5a simulation (`quizInitialState` emptied
 * at both real population sites), where the bank-derived `correctIndices`
 * fallback has nothing to report before the terminal verdict lands.
 *
 * These tests would FAIL against the old unconditional
 * `Math.max(correctIndices.length - correctSelected, 0)` implementation,
 * because it returns `0`, not `null`, for every case here.
 */

if (typeof (globalThis as any).structuredClone !== 'function') {
  (globalThis as any).structuredClone = (v: unknown) => JSON.parse(JSON.stringify(v));
}

let service: OptionClickHandlerService;

beforeEach(() => {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } },
      { provide: API_BASE_URL, useValue: 'https://api.test/api' }
    ]
  });
  service = TestBed.inject(OptionClickHandlerService);
});

describe('computeMultiAnswerClickState — correct-set-known tri-state', () => {
  it('reports remaining as unknown (null), not zero, when the correct set is empty on the first click', () => {
    const state = service.computeMultiAnswerClickState(0, new Set([0]), []);

    expect(state.remaining).toBeNull();
    // Not zero — the old bug's exact symptom: an empty correctIndices array
    // must never read as "nothing left to find".
    expect(state.remaining).not.toBe(0);
  });

  it('reports remaining as unknown even with no selections yet', () => {
    const state = service.computeMultiAnswerClickState(0, new Set(), []);

    expect(state.remaining).toBeNull();
  });

  it('reports a genuine positive remaining count once the correct set is known and incomplete', () => {
    const state = service.computeMultiAnswerClickState(0, new Set([0]), [0, 1, 2]);

    expect(state.remaining).toBe(2);
  });

  it('reports remaining === 0 only once the correct set is known and every correct option is selected', () => {
    const state = service.computeMultiAnswerClickState(2, new Set([0, 1, 2]), [0, 1, 2]);

    expect(state.remaining).toBe(0);
  });

  it('does not let a known-empty correct-index array on a 0-option question mimic completion', () => {
    // Distinguishes "the API says there are zero correct options" (does not
    // happen in this app, but the type must not silently assume it) from
    // "we do not know yet" — both currently produce the same empty-array
    // input, and this fix intentionally treats that input as unknown rather
    // than trying to tell the two apart, per the architectural rule that
    // unknown must never collapse into a definite result.
    const state = service.computeMultiAnswerClickState(0, new Set(), []);

    expect(state.remaining).toBeNull();
  });
});

/**
 * SOURCE 3 REMOVED (Stage 14 / S5a).
 *
 * `resolveCorrectIndices` used to fall back to a scan of `quizService.quizInitialState`
 * — the bundled answer-key bank — when the passed question's own options and
 * `quizService._questions` had no `.correct` flags. Proven redundant under a
 * true S5a simulation: with `quizInitialState` emptied, every one of 581
 * captured calls across the full multi-answer/revisit/restart/timer battery
 * returned empty from every source, and all 20 tests passed identically to the
 * control run where the removed source had been firing on every call.
 *
 * These tests would FAIL against the old Source-3-dependent implementation
 * whenever `quizInitialState` holds the only copy of the correct answer for a
 * question whose live options and `_questions` cross-reference don't carry it.
 */
describe('resolveCorrectIndices — no quizInitialState dependency', () => {
  const questionText = 'What does dependency injection provide?';

  function withQuizService(setup: (quizSvc: any) => void): void {
    const quizSvc: any = (service as any).quizService;
    setup(quizSvc);
  }

  it('resolves correct indices from the question options themselves (Source 1) without touching quizInitialState', () => {
    withQuizService((quizSvc) => {
      quizSvc._questions = [];
      quizSvc.quizInitialState = [];
    });

    const question: any = {
      questionText,
      options: [
        { text: 'A', correct: false },
        { text: 'B', correct: true },
        { text: 'C', correct: false }
      ]
    };

    const result = service.resolveCorrectIndices(question, 0, false, 'single');

    expect(result.correctIndices).toEqual([1]);
    expect(result.correctCount).toBe(1);
  });

  it('does NOT recover correctness from quizInitialState when it is the only source that has it (proves Source 3 is gone)', () => {
    const question: any = {
      questionText,
      // Live options carry no correctness — matches the /questions API shape.
      options: [{ text: 'A' }, { text: 'B' }, { text: 'C' }]
    };

    withQuizService((quizSvc) => {
      quizSvc._questions = [];
      // Only quizInitialState knows the answer. The old Source 3 would have
      // found it here; the fix must not.
      quizSvc.quizInitialState = [{
        quizId: 'q1',
        milestone: '', summary: '', image: '',
        questions: [{
          questionText,
          options: [{ text: 'A', correct: false }, { text: 'B', correct: true }, { text: 'C', correct: false }]
        }]
      }];
    });

    const result = service.resolveCorrectIndices(question, 0, false, 'single');

    expect(result.correctIndices).toEqual([]);
    expect(result.correctCount).toBe(0);
  });

  it('stays empty (unknown), not a false definite result, when no source has correctness at all — true S5a shape', () => {
    withQuizService((quizSvc) => {
      quizSvc._questions = [];
      quizSvc.quizInitialState = [];
    });

    const question: any = {
      questionText,
      options: [{ text: 'A' }, { text: 'B' }, { text: 'C' }]
    };

    const result = service.resolveCorrectIndices(question, 0, false, 'single');

    expect(result.correctIndices).toEqual([]);
    expect(result.correctCount).toBe(0);
  });

  it('an unknown correctIndices result from resolveCorrectIndices feeds computeMultiAnswerClickState as unknown, not zero-remaining (full pipeline)', () => {
    withQuizService((quizSvc) => {
      quizSvc._questions = [];
      quizSvc.quizInitialState = [];
    });

    const question: any = {
      questionText,
      options: [{ text: 'A' }, { text: 'B' }, { text: 'C' }]
    };

    const { correctIndices } = service.resolveCorrectIndices(question, 0, true, 'multiple');
    const state = service.computeMultiAnswerClickState(0, new Set([0]), correctIndices);

    expect(state.remaining).toBeNull();
    expect(state.isClickedCorrect).toBeNull();
  });

  it('a genuinely known multi-answer correct set (Source 1 available) still resolves and completes normally', () => {
    withQuizService((quizSvc) => {
      quizSvc._questions = [];
      quizSvc.quizInitialState = [];
    });

    const question: any = {
      questionText,
      options: [
        { text: 'A', correct: true },
        { text: 'B', correct: false },
        { text: 'C', correct: true }
      ]
    };

    const { correctIndices } = service.resolveCorrectIndices(question, 0, true, 'multiple');
    expect(correctIndices).toEqual([0, 2]);

    const partial = service.computeMultiAnswerClickState(0, new Set([0]), correctIndices);
    expect(partial.remaining).toBe(1);

    const complete = service.computeMultiAnswerClickState(2, new Set([0, 2]), correctIndices);
    expect(complete.remaining).toBe(0);
    expect(complete.isClickedCorrect).toBe(true);
  });
});
