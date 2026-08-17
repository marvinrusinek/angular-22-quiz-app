import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { ExplanationFormatterService } from './explanation-formatter.service';
import { QuestionVerdictService } from '../verdict/question-verdict.service';
import { IDLE_VERDICT_STATE } from '../verdict/question-verdict.types';
import type { QuestionVerdictState } from '../verdict/question-verdict.types';
import { QuizService } from '../../data/quiz.service';
import { API_BASE_URL } from '../../../tokens/api-base-url.token';
import { QuestionType } from '../../../models/question-type.enum';
import type { QuizQuestion } from '../../../models/QuizQuestion.model';

/**
 * COMPOSED FET IDENTITY IS AUTHORIZED.
 *
 * The FET the user reads is composed: "Option 2 is correct because …". The
 * body moved to the verdict in S1; the INDICES in that prefix were still
 * derived from `option.correct`, so once questions arrived from `/questions`
 * carrying no correctness there were no indices and the prefix vanished.
 *
 * Identity now comes from the verdict's `correctOptionTexts`, matched by TEXT
 * against the options AS DISPLAYED — so a shuffled quiz numbers them by what
 * the user is looking at.
 *
 * Presentation only: nothing here changes when a FET may appear.
 */

const QUIZ = 'rxjs';
const QUESTION = 'Select every operator';

let formatter: ExplanationFormatterService;
let verdictState: QuestionVerdictState;
let displayed: QuizQuestion[];

const state = (patch: Partial<QuestionVerdictState>): QuestionVerdictState =>
  ({ ...IDLE_VERDICT_STATE, ...patch }) as QuestionVerdictState;

/** Options as displayed. `correct` flags here are deliberately WRONG. */
function question(order: string[], lie = true): QuizQuestion {
  return {
    questionText: QUESTION,
    type: QuestionType.MultipleAnswer,
    options: order.map((text, i) => ({
      optionId: i + 1,
      text,
      ...(lie ? { correct: text === 'Observable' } : {})
    }))
  } as unknown as QuizQuestion;
}

beforeEach(() => {
  verdictState = IDLE_VERDICT_STATE;
  displayed = [question(['map', 'filter', 'Observable'])];

  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } },
      { provide: API_BASE_URL, useValue: 'https://api.test/api' },
      {
        provide: QuizService,
        useValue: {
          quizId: QUIZ,
          get questions() { return displayed; },
          getQuestionsInDisplayOrder: () => displayed,
          isShuffleEnabled: () => false,
          shuffledQuestions: []
        }
      },
      { provide: QuestionVerdictService, useValue: { verdictFor: () => verdictState } }
    ]
  });

  formatter = TestBed.inject(ExplanationFormatterService);
});

const indices = (idx = 0) =>
  formatter.getCorrectOptionIndices(displayed[idx]!, displayed[idx]!.options, idx);

describe('identity comes from the authorized verdict', () => {
  it('derives displayed indices from correctOptionTexts', () => {
    verdictState = state({ phase: 'expired', correctOptionTexts: ['map', 'filter'] });
    expect(indices()).toEqual([1, 2]);
  });

  it('WINS over local `correct` flags that disagree', () => {
    // The bank flags only 'Observable' (index 3). The verdict says map+filter.
    verdictState = state({ phase: 'resolved', correctOptionTexts: ['map', 'filter'] });

    const result = indices();
    expect(result).toEqual([1, 2]);
    expect(result).not.toContain(3);
  });

  it('works when options carry NO `correct` at all — the post-cutover shape', () => {
    displayed = [question(['map', 'filter', 'Observable'], false)];
    verdictState = state({ phase: 'resolved', correctOptionTexts: ['filter'] });
    expect(indices()).toEqual([2]);
  });

  it('SHUFFLE: numbers by the DISPLAYED position, not a canonical one', () => {
    // Same question, options reordered. 'filter' is now first.
    displayed = [question(['filter', 'Observable', 'map'], false)];
    verdictState = state({ phase: 'resolved', correctOptionTexts: ['map', 'filter'] });

    // filter -> 1, map -> 3
    expect(indices()).toEqual([1, 3]);
  });

  it('multi-answer yields every authorized index, in ascending order', () => {
    displayed = [question(['a', 'b', 'c', 'd'], false)];
    verdictState = state({ phase: 'resolved', correctOptionTexts: ['d', 'a', 'c'] });
    expect(indices()).toEqual([1, 3, 4]);
  });

  it('matches on normalized text, so whitespace/case drift cannot lose an option', () => {
    displayed = [question(['  MAP  ', 'filter'], false)];
    verdictState = state({ phase: 'resolved', correctOptionTexts: ['map'] });
    expect(indices()).toEqual([1]);
  });
});

describe('nothing authorized means nothing fabricated', () => {
  it('does not use the verdict before a terminal phase', () => {
    for (const phase of ['idle', 'checking', 'incomplete', 'error'] as const) {
      verdictState = state({ phase, correctOptionTexts: ['map', 'filter'] });
      // Falls through to the legacy chain, which reads the (lying) local flag.
      // The point is only that the UNAUTHORIZED verdict was not consulted.
      expect(indices()).not.toEqual([1, 2]);
    }
  });

  it('invents no index when a terminal verdict names nothing on screen', () => {
    displayed = [question(['x', 'y', 'z'], false)];
    verdictState = state({ phase: 'resolved', correctOptionTexts: ['not-on-screen'] });

    // No authorized match and no local flags — an empty prefix is right, and
    // a fabricated index would be worse than none.
    expect(indices()).toEqual([]);
  });
});
