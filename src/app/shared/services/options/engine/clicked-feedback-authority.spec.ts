import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { SocAnswerProcessingService } from './soc-answer-processing.service';
import { FeedbackService } from '../../features/feedback/feedback.service';
import { QuestionVerdictService } from '../../features/verdict/question-verdict.service';
import { QuizService } from '../../data/quiz.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { TimerService } from '../../features/timer/timer.service';
import { API_BASE_URL } from '../../../tokens/api-base-url.token';
import { IDLE_VERDICT_STATE, type QuestionVerdictState } from '../../features/verdict/question-verdict.types';

/**
 * The feedback shown for the option the user just clicked.
 *
 * It used to decide correctness by testing the clicked index for membership of
 * a full correct-index set — a fact about EVERY option, used to answer a
 * question about ONE. The verdict discloses precisely that one: what the
 * user's own selection was worth.
 *
 * `undefined` (no verdict recorded yet) is kept distinct from `false`, so a
 * pick that has not been checked is never rendered as wrong.
 *
 * Fixtures pass deliberately misleading correct-index sets; on the authorized
 * path they must make no difference.
 */

const QUESTION = 'Select every operator';

let service: SocAnswerProcessingService;
let verdictState: QuestionVerdictState;

const state = (over: Partial<QuestionVerdictState>): QuestionVerdictState =>
  ({ ...IDLE_VERDICT_STATE, ...over });

const OPTIONS = [
  { optionId: 1, text: 'map', correct: true },
  { optionId: 2, text: 'filter', correct: true },
  { optionId: 3, text: 'Observable' }
];

beforeEach(() => {
  verdictState = IDLE_VERDICT_STATE;

  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } },
      { provide: API_BASE_URL, useValue: 'https://api.test/api' },
      {
        provide: QuizService,
        useValue: {
          quizId: 'rxjs',
          questions: [{ questionText: QUESTION, options: OPTIONS }],
          getQuestionsInDisplayOrder: () => [{ questionText: QUESTION, options: OPTIONS }],
          isShuffleEnabled: () => false,
          shuffledQuestions: [],
          totalQuestions: () => 1,
          quizReset$: of(undefined)
        }
      },
      {
        provide: SelectedOptionService,
        useValue: {
          uiSelectedTextsForQuestion: () => new Set<string>(),
          stopTimer$: of(undefined),
          selectedOptionsMap: new Map(),
          clickConfirmedDotStatus: new Map()
        }
      },
      { provide: TimerService, useValue: { stopTimer: () => undefined, resetTimer: () => undefined } },
      { provide: FeedbackService, useValue: { setCorrectMessage: () => 'correct message' } },
      { provide: QuestionVerdictService, useValue: { verdictFor: () => verdictState } }
    ]
  });
  service = TestBed.inject(SocAnswerProcessingService);
});

/** A component stand-in exposing only what the feedback builder reads. */
function comp(options = OPTIONS) {
  return {
    optionsToDisplay: options,
    optionBindings: () => options.map((o) => ({ option: { ...o } })),
    currentQuestion: () => ({ questionText: QUESTION, options }),
    cdRef: { markForCheck: () => undefined },
    _feedbackDisplay: null as any
  };
}

/** Invoke the private builder and read the correctness it stamped. */
function clickedCorrect(
  c: any,
  index: number,
  effectiveCorrectIndices: number[]
): boolean {
  (service as any).buildMultiAnswerFeedbackDisplay(
    c, index, { option: c.optionsToDisplay[index] }, effectiveCorrectIndices, 'feedback'
  );
  return c._feedbackDisplay.config.selectedOption.correct;
}

describe('the clicked option carries its own verdict', () => {
  it('renders a correct pick as correct', () => {
    verdictState = state({
      phase: 'incomplete',
      remainingCorrectCount: 1,
      selectedVerdicts: new Map([['map', true]])
    });

    expect(clickedCorrect(comp(), 0, [])).toBe(true);
  });

  it('renders a wrong pick as incorrect', () => {
    verdictState = state({
      phase: 'incomplete',
      remainingCorrectCount: 2,
      selectedVerdicts: new Map([['Observable', false]])
    });

    expect(clickedCorrect(comp(), 2, [0, 1, 2])).toBe(false);
  });

  it('still marks the completing pick correct', () => {
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: true,
      correctOptionTexts: ['map', 'filter'],
      selectedVerdicts: new Map([['map', true], ['filter', true]])
    });

    expect(clickedCorrect(comp(), 1, [])).toBe(true);
  });
});

describe('the correct-index set no longer decides', () => {
  it('ignores a set that claims the clicked option is wrong', () => {
    verdictState = state({
      phase: 'incomplete',
      remainingCorrectCount: 1,
      selectedVerdicts: new Map([['map', true]])
    });

    // Set deliberately excludes index 0 — the old code would have said false.
    expect(clickedCorrect(comp(), 0, [1, 2])).toBe(true);
  });

  it('ignores a set that claims the clicked option is right', () => {
    verdictState = state({
      phase: 'incomplete',
      remainingCorrectCount: 2,
      selectedVerdicts: new Map([['Observable', false]])
    });

    // Set deliberately includes index 2 — the old code would have said true.
    expect(clickedCorrect(comp(), 2, [0, 1, 2])).toBe(false);
  });

  it('ignores a LYING local `correct` flag on the clicked option', () => {
    const lying = [
      { optionId: 1, text: 'map', correct: false },
      { optionId: 2, text: 'filter', correct: true },
      { optionId: 3, text: 'Observable', correct: true }
    ];
    verdictState = state({
      phase: 'incomplete',
      remainingCorrectCount: 1,
      selectedVerdicts: new Map([['map', true]])
    });

    expect(clickedCorrect(comp(lying), 0, [])).toBe(true);
  });

  it('works on options with no `correct` property at all', () => {
    const bare = [
      { optionId: 1, text: 'map' },
      { optionId: 2, text: 'filter' },
      { optionId: 3, text: 'Observable' }
    ];
    verdictState = state({
      phase: 'incomplete',
      remainingCorrectCount: 1,
      selectedVerdicts: new Map([['map', true]])
    });

    expect(clickedCorrect(comp(bare), 0, [])).toBe(true);
  });
});

describe('with no verdict for the pick, the previous behaviour stands', () => {
  it.each([['idle'], ['checking'], ['error']] as const)(
    'falls back to the passed set while %s',
    (phase) => {
      // undefined is NOT false: an unchecked pick must not render as wrong.
      verdictState = state({ phase });

      expect(clickedCorrect(comp(), 0, [0, 1])).toBe(true);
      expect(clickedCorrect(comp(), 2, [0, 1])).toBe(false);
    }
  );

  it('falls back when the verdict knows OTHER picks but not this one', () => {
    verdictState = state({
      phase: 'incomplete',
      remainingCorrectCount: 1,
      selectedVerdicts: new Map([['filter', true]])   // nothing for 'map'
    });

    expect(clickedCorrect(comp(), 0, [0, 1])).toBe(true);
  });
});

describe('identity is textual, not positional', () => {
  it('follows the option text when the display order is reversed', () => {
    const reversed = [...OPTIONS].reverse();   // Observable, filter, map
    verdictState = state({
      phase: 'incomplete',
      remainingCorrectCount: 1,
      selectedVerdicts: new Map([['map', true], ['Observable', false]])
    });

    expect(clickedCorrect(comp(reversed), 2, [])).toBe(true);    // map, now last
    expect(clickedCorrect(comp(reversed), 0, [])).toBe(false);   // Observable, now first
  });
});
