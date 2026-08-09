import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { SharedOptionClickService } from './shared-option-click.service';
import { QuestionVerdictService } from '../../features/verdict/question-verdict.service';
import { QuizService } from '../../data/quiz.service';
import { TimerService } from '../../features/timer/timer.service';
import { API_BASE_URL } from '../../../tokens/api-base-url.token';
import { IDLE_VERDICT_STATE, type QuestionVerdictState } from '../../features/verdict/question-verdict.types';

/**
 * Stopping the countdown once every required answer is in.
 *
 * This used to rebuild the correct-index set from the bank
 * (isOptionCorrect over the canonical options) and check that each index was
 * in the durable selection set. That is a full answer set reconstructed in the
 * browser to answer a single yes/no question.
 *
 * The question it actually asks is the SUPERSET one — "is every required
 * correct answer selected?" — not perfection. The old check had no
 * "and nothing wrong" clause, so a correct-plus-extra selection stopped the
 * timer. `allCorrectSelectedFromVerdict` asks exactly that, so the timing is
 * unchanged.
 *
 * Fixtures below carry `correct` flags that lie, or none at all.
 */

const QUESTION = 'Select every operator';

let service: SharedOptionClickService;
let verdictState: QuestionVerdictState;
let stopped: number;

const state = (over: Partial<QuestionVerdictState>): QuestionVerdictState =>
  ({ ...IDLE_VERDICT_STATE, ...over });

/** The bank claims map+filter — only the no-verdict fallback consults it. */
const BANK_QUESTION = {
  questionText: QUESTION,
  options: [
    { optionId: 1, text: 'map', correct: true },
    { optionId: 2, text: 'filter', correct: true },
    { optionId: 3, text: 'Observable' }
  ]
};

beforeEach(() => {
  verdictState = IDLE_VERDICT_STATE;
  stopped = 0;

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
          questions: [BANK_QUESTION],
          getQuestionsInDisplayOrder: () => [BANK_QUESTION],
          isShuffleEnabled: () => false,
          shuffledQuestions: [],
          // SelectedOptionService subscribes to this at construction.
          quizReset$: of(undefined)
        }
      },
      { provide: TimerService, useValue: { stopTimer: () => { stopped++; } } },
      { provide: QuestionVerdictService, useValue: { verdictFor: () => verdictState } }
    ]
  });
  service = TestBed.inject(SharedOptionClickService);
});

const comp = () => ({ currentQuestion: () => BANK_QUESTION });

/** Invoke the private helper the click flow calls. */
const maybeStop = (durable: number[], effective: number[] = []) =>
  (service as any).maybeStopTimerWhenAllCorrect(comp(), 0, effective, new Set(durable));

describe('the verdict decides when the countdown stops', () => {
  it('stops once every required correct answer is selected', () => {
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: true,
      correctOptionTexts: ['map', 'filter'],
      selectedVerdicts: new Map([['map', true], ['filter', true]])
    });

    maybeStop([0, 1]);
    expect(stopped).toBe(1);
  });

  it('keeps running on a partial multi-answer selection', () => {
    verdictState = state({
      phase: 'incomplete',
      remainingCorrectCount: 1,
      selectedVerdicts: new Map([['map', true]])
    });

    maybeStop([0]);
    expect(stopped).toBe(0);
  });

  it('stops on a correct-plus-extra selection, exactly as before', () => {
    // SUPERSET, not perfect. The old check had no "nothing wrong" clause, so
    // adding one here would stop the timer later than today.
    verdictState = state({
      phase: 'incomplete',
      remainingCorrectCount: 0,
      selectedVerdicts: new Map([['map', true], ['filter', true], ['Observable', false]])
    });

    maybeStop([0, 1, 2]);
    expect(stopped).toBe(1);
  });

  it('keeps running on a wrong-only selection', () => {
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: false,
      selectedVerdicts: new Map([['Observable', false]])
    });

    maybeStop([2]);
    expect(stopped).toBe(0);
  });
});

describe('the local answer key cannot stop the clock', () => {
  it('does not stop when the bank says complete but the verdict says incomplete', () => {
    // Both bank-correct options are in the durable set, so the OLD code would
    // have stopped. The verdict disagrees, and it wins.
    verdictState = state({
      phase: 'incomplete',
      remainingCorrectCount: 1,
      selectedVerdicts: new Map([['map', true], ['filter', true]])
    });

    maybeStop([0, 1]);
    expect(stopped).toBe(0);
  });

  it('stops on options the bank marks wrong, when the verdict says complete', () => {
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: true,
      correctOptionTexts: ['Observable'],
      selectedVerdicts: new Map([['Observable', true]])
    });

    maybeStop([2]);
    expect(stopped).toBe(1);
  });

  it('does not need the passed correct-index set at all', () => {
    // effectiveCorrectIndices deliberately empty AND wrong — the authorized
    // path never consults it.
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: true,
      correctOptionTexts: ['map', 'filter'],
      selectedVerdicts: new Map([['map', true], ['filter', true]])
    });

    maybeStop([0, 1], []);
    expect(stopped).toBe(1);
  });
});

describe('with no verdict, the previous behaviour is preserved', () => {
  it.each([['idle'], ['checking'], ['error']] as const)(
    'falls back to the existing check while %s',
    (phase) => {
      // Under the API adapter the completing click is momentarily `checking`;
      // stopping a round trip later would change the elapsed time a frozen
      // revisit shows.
      verdictState = state({ phase });

      maybeStop([0, 1]);
      expect(stopped).toBe(1);
    }
  );

  it('still does not stop on a partial selection with no verdict', () => {
    verdictState = state({ phase: 'idle' });

    maybeStop([0]);
    expect(stopped).toBe(0);
  });
});

describe('selection order is irrelevant', () => {
  it('stops regardless of the order the answers were picked in', () => {
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: true,
      correctOptionTexts: ['map', 'filter'],
      selectedVerdicts: new Map([['filter', true], ['map', true]])
    });

    maybeStop([1, 0]);
    expect(stopped).toBe(1);
  });
});
