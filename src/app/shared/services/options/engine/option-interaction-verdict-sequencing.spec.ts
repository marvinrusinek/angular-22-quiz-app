import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { SelectedOptionService } from '../../state/selectedoption.service';
import { QuestionVerdictService } from '../../features/verdict/question-verdict.service';
import { QuizService } from '../../data/quiz.service';
import { setQuizDataCache } from '../../../quiz-data-cache';
import type { Quiz } from '../../../models/Quiz.model';

/**
 * Verdict submission SEQUENCING.
 *
 * The click pipeline used to record the verdict during a later change-detection
 * pass (`ngDoCheck` → `syncUiSelectedTexts`), which is AFTER the click's own
 * correctness decisions had already run. Every reader therefore saw an `idle`
 * verdict and fell back to reading `option.correct` directly.
 *
 * The submission now happens inside `OptionInteractionService.handleOptionClick`
 * between phase 2 (selection computed) and phase 3 (correctness effects), so a
 * real verdict is available to the effects that need it.
 *
 * These tests pin the properties that make that safe: ONE submission per real
 * selection change, none from rendering, and no duplicate when the later sync
 * publishes the same set.
 */

const MULTI = 'Select every operator';   // correct: map, filter

const BANK = [
  {
    quizId: 'rxjs',
    milestone: 'RxJS',
    questions: [
      {
        questionText: MULTI,
        explanation: 'map and filter are operators.',
        options: [
          { text: 'map', correct: true },
          { text: 'filter', correct: true },
          { text: 'Observable' }
        ]
      }
    ]
  }
] as unknown as Quiz[];

// jsdom here has no structuredClone; QuizService uses it at construction.
if (typeof (globalThis as any).structuredClone !== 'function') {
  (globalThis as any).structuredClone = (value: unknown) => JSON.parse(JSON.stringify(value));
}

let selectedOptionService: SelectedOptionService;
let verdicts: QuestionVerdictService;
let checkSpy: jest.SpyInstance;

beforeEach(() => {
  setQuizDataCache(JSON.parse(JSON.stringify(BANK)) as Quiz[], []);

  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } }
    ]
  });
  const quizService = TestBed.inject(QuizService);
  (quizService as any).quizId = 'rxjs';
  // Stated explicitly through the setter. These specs used to set only the
  // SIGNAL and let QuizService's constructor seed the backing array from the
  // mocked bank. S4 removed that constructor-time seed (it was handing every
  // session the FIRST quiz in the bank regardless of route), so a spec that
  // needs questions now has to say so.
  quizService.questions = JSON.parse(JSON.stringify(BANK[0]!.questions)) as never;

  selectedOptionService = TestBed.inject(SelectedOptionService);
  verdicts = TestBed.inject(QuestionVerdictService);
  checkSpy = jest.spyOn(verdicts, 'checkAnswer');
});

afterEach(() => {
  checkSpy.mockRestore();
  setQuizDataCache([], []);
});

/** What the click path and the later ngDoCheck sync both call. */
const publish = (texts: string[]) =>
  selectedOptionService.setUiSelectedTextsForQuestion(0, texts);

describe('one submission per real selection change', () => {
  it('a selection submits exactly once', () => {
    publish(['map']);
    expect(checkSpy).toHaveBeenCalledTimes(1);
  });

  it('the LATER ngDoCheck sync publishing the SAME set does not resubmit', () => {
    publish(['map']);
    expect(checkSpy).toHaveBeenCalledTimes(1);

    // ngDoCheck runs on every change-detection pass and republishes the same
    // set. The equality guard must swallow it.
    publish(['map']);
    publish(['map']);
    publish(['map']);

    expect(checkSpy).toHaveBeenCalledTimes(1);
  });

  it('set ORDER does not count as a change', () => {
    publish(['map', 'filter']);
    expect(checkSpy).toHaveBeenCalledTimes(1);

    publish(['filter', 'map']);
    expect(checkSpy).toHaveBeenCalledTimes(1);
  });

  it('a SECOND real selection change submits exactly once more', () => {
    publish(['map']);
    publish(['map', 'filter']);

    expect(checkSpy).toHaveBeenCalledTimes(2);
  });

  it('a DESELECTION is a real change and submits once', () => {
    publish(['map', 'filter']);
    publish(['map']);

    expect(checkSpy).toHaveBeenCalledTimes(2);
  });

  it('rendering/revisiting without a new selection submits nothing', () => {
    // No selection has been made at all — pure render traffic. Submitting here
    // would fire a check for every question the user merely looks at, which
    // becomes a wasted network round trip once the verdict comes from the API.
    publish([]);
    publish([]);
    expect(checkSpy).not.toHaveBeenCalled();
  });

  it('DESELECTING BACK TO EMPTY is a real change and submits exactly once', () => {
    publish(['map']);
    expect(checkSpy).toHaveBeenCalledTimes(1);

    // Distinct from the fresh-render case above: something WAS selected, so
    // clearing it changes the answer and the verdict must be updated.
    publish([]);
    expect(checkSpy).toHaveBeenCalledTimes(2);
    expect(checkSpy).toHaveBeenLastCalledWith('rxjs', MULTI, []);

    // …and republishing the now-empty set does not submit again.
    publish([]);
    expect(checkSpy).toHaveBeenCalledTimes(2);
  });
});

describe('identity used for submission', () => {
  it('submits with quizId + exact questionText, and option TEXTS only', () => {
    publish(['map']);

    expect(checkSpy).toHaveBeenCalledWith('rxjs', MULTI, expect.arrayContaining(['map']));

    // No id, index or opaque reference anywhere in the call.
    const [, , texts] = checkSpy.mock.calls[0]!;
    for (const value of texts as unknown[]) {
      expect(typeof value).toBe('string');
    }
  });
});

describe('the verdict is available to correctness-dependent readers', () => {
  it('records an incomplete verdict for a partial multi selection', () => {
    publish(['map']);

    const state = verdicts.verdictFor('rxjs', MULTI);
    expect(state.phase).toBe('incomplete');
    expect(state.remainingCorrectCount).toBe(1);
    // Verdicts cover the user's own pick only.
    expect(verdicts.verdictForOption('rxjs', MULTI, 'map')).toBe(true);
    expect(verdicts.verdictForOption('rxjs', MULTI, 'filter')).toBeNull();
  });

  it('records a resolved verdict once every correct option is selected', () => {
    publish(['map', 'filter']);

    const state = verdicts.verdictFor('rxjs', MULTI);
    expect(state.phase).toBe('resolved');
    expect(state.isResolvedCorrect).toBe(true);
  });

  it('SUPERSET rule: all correct plus an incorrect pick still resolves correct', () => {
    publish(['map', 'filter', 'Observable']);

    const state = verdicts.verdictFor('rxjs', MULTI);
    expect(state.phase).toBe('resolved');
    expect(state.isResolvedCorrect).toBe(true);
  });

  it('an incorrect-only selection stays incomplete and does not reduce the count', () => {
    publish(['Observable']);

    const state = verdicts.verdictFor('rxjs', MULTI);
    expect(state.phase).toBe('incomplete');
    expect(state.remainingCorrectCount).toBe(2);
  });
});

describe('failure containment', () => {
  it('a rejected check does not throw into the caller', () => {
    // An unknown option text is rejected by the adapter.
    expect(() => publish(['no such option'])).not.toThrow();
  });

  it('keeps the last confirmed verdict when a later check fails', () => {
    publish(['map']);
    expect(verdicts.verdictFor('rxjs', MULTI).remainingCorrectCount).toBe(1);

    publish(['no such option']);

    // Phase moves to error; the confirmed verdict for the real pick survives.
    const state = verdicts.verdictFor('rxjs', MULTI);
    expect(state.phase).toBe('error');
    expect(state.selectedVerdicts.get('map')).toBe(true);
  });
});
