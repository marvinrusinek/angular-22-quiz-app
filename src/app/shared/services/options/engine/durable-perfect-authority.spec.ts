import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { SocAnswerProcessingService } from './soc-answer-processing.service';
import { QuestionVerdictService } from '../../features/verdict/question-verdict.service';
import { QuizService } from '../../data/quiz.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { TimerService } from '../../features/timer/timer.service';
import { API_BASE_URL } from '../../../tokens/api-base-url.token';
import { IDLE_VERDICT_STATE, type QuestionVerdictState } from '../../features/verdict/question-verdict.types';

/**
 * "Is the durable selection perfect?" — the flag behind the all-correct
 * repaint, the FET emission and the binding respread on a multi-answer click.
 *
 * It used to rebuild the correct set from the bank
 * (getPristineCorrectTextsForQuestion) and compare the user's selections
 * against it. The answer key decided an active UI state.
 *
 * PERFECT is deliberately stricter than the verdict's own correct/incorrect.
 * Topic Quiz resolves multi-answer on the audited SUPERSET rule, so
 * `isResolvedCorrect` alone would call "2 correct + 1 wrong" perfect — which
 * drops the red incorrect repaint on revisit that the no-incorrect guard
 * exists to preserve. Both halves now come from the user's own selections.
 *
 * The selection set is the durable indices UNION the cross-visit snapshot;
 * that union is load-bearing for completing a question on revisit, and these
 * tests pin it.
 */

const QUESTION = 'Select every operator';

let service: SocAnswerProcessingService;
let verdictState: QuestionVerdictState;
let uiSelected: string[];

const state = (over: Partial<QuestionVerdictState>): QuestionVerdictState =>
  ({ ...IDLE_VERDICT_STATE, ...over });

/** The bank claims map+filter — consulted only by the no-verdict fallback. */
const BANK_QUESTION = {
  questionText: QUESTION,
  options: [
    { optionId: 1, text: 'map', correct: true },
    { optionId: 2, text: 'filter', correct: true },
    { optionId: 3, text: 'Observable' },
    { optionId: 4, text: 'Subject' }
  ]
};

/** Bindings in display order; `correct` flags are never consulted on the authorized path. */
const bindings = () => BANK_QUESTION.options.map((o, i) => ({ option: { ...o }, index: i }));

beforeEach(() => {
  verdictState = IDLE_VERDICT_STATE;
  uiSelected = [];

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
          getPristineCorrectTextsForQuestion: () => new Set(['map', 'filter']),
          quizReset$: of(undefined)
        }
      },
      {
        provide: SelectedOptionService,
        useValue: {
          uiSelectedTextsForQuestion: () => new Set(uiSelected),
          // TimerService subscribes to this at construction.
          stopTimer$: of(undefined),
          selectedOptionsMap: new Map(),
          clickConfirmedDotStatus: new Map()
        }
      },
      { provide: TimerService, useValue: { stopTimer: () => undefined, resetTimer: () => undefined } },
      { provide: QuestionVerdictService, useValue: { verdictFor: () => verdictState } }
    ]
  });
  service = TestBed.inject(SocAnswerProcessingService);
});

const comp = () => ({
  optionBindings: () => bindings(),
  currentQuestion: () => BANK_QUESTION
});

/** Invoke the private helper exactly as the multi-answer click flow does. */
const durablePerfect = (durable: number[], effective: number[] = []) =>
  (service as any).computeAllCorrectInDurable(comp(), 0, 0, new Set(durable), effective);

describe('perfect means every answer AND nothing wrong', () => {
  it('is true when both correct options are selected and nothing else', () => {
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: true,
      correctOptionTexts: ['map', 'filter'],
      selectedVerdicts: new Map([['map', true], ['filter', true]])
    });

    expect(durablePerfect([0, 1])).toBe(true);
  });

  it('is FALSE for two correct plus one wrong, despite a correct verdict', () => {
    // THE SUPERSET TRAP. isResolvedCorrect is true under the audited rule; the
    // red incorrect repaint on revisit depends on this staying false.
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: true,
      correctOptionTexts: ['map', 'filter'],
      selectedVerdicts: new Map([['map', true], ['filter', true], ['Observable', false]])
    });

    expect(durablePerfect([0, 1, 2])).toBe(false);
  });

  it('is false on a partial selection', () => {
    verdictState = state({
      phase: 'incomplete',
      remainingCorrectCount: 1,
      selectedVerdicts: new Map([['map', true]])
    });

    expect(durablePerfect([0])).toBe(false);
  });

  it('is false on a wrong-only selection', () => {
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: false,
      selectedVerdicts: new Map([['Observable', false]])
    });

    expect(durablePerfect([2])).toBe(false);
  });

  it('is false when nothing is selected', () => {
    verdictState = state({ phase: 'incomplete', remainingCorrectCount: 2 });

    expect(durablePerfect([])).toBe(false);
  });
});

describe('the local answer key cannot decide this', () => {
  it('follows the verdict when the bank says perfect but the verdict says incomplete', () => {
    // Both bank-correct options selected — the OLD comparison returned true.
    verdictState = state({
      phase: 'incomplete',
      remainingCorrectCount: 1,
      selectedVerdicts: new Map([['map', true], ['filter', true]])
    });

    expect(durablePerfect([0, 1])).toBe(false);
  });

  it('is perfect on options the bank marks wrong, when the verdict says so', () => {
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: true,
      correctOptionTexts: ['Observable', 'Subject'],
      selectedVerdicts: new Map([['Observable', true], ['Subject', true]])
    });

    expect(durablePerfect([2, 3])).toBe(true);
  });

  it('never consults the passed correct-index set on the authorized path', () => {
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: true,
      correctOptionTexts: ['map', 'filter'],
      selectedVerdicts: new Map([['map', true], ['filter', true]])
    });

    // Deliberately empty AND deliberately wrong — neither changes the answer.
    expect(durablePerfect([0, 1], [])).toBe(true);
    expect(durablePerfect([0, 1], [2, 3])).toBe(true);
  });
});

describe('the durable + revisit-snapshot union is preserved', () => {
  it('completes from the snapshot alone', () => {
    // durableSet resets on navigation; on a revisit it holds only the click.
    uiSelected = ['map', 'filter'];
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: true,
      correctOptionTexts: ['map', 'filter'],
      selectedVerdicts: new Map([['map', true], ['filter', true]])
    });

    expect(durablePerfect([])).toBe(true);
  });

  it('completes from the union when each half is partial', () => {
    uiSelected = ['filter'];                 // remembered from the first visit
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: true,
      correctOptionTexts: ['map', 'filter'],
      selectedVerdicts: new Map([['map', true], ['filter', true]])
    });

    expect(durablePerfect([0])).toBe(true);  // just-clicked 'map'
  });

  it('is unaffected by the same option appearing in both halves', () => {
    uiSelected = ['map', 'filter'];
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: true,
      correctOptionTexts: ['map', 'filter'],
      selectedVerdicts: new Map([['map', true], ['filter', true]])
    });

    expect(durablePerfect([0, 1])).toBe(true);
  });

  it('sees a wrong pick that lives only in the snapshot', () => {
    uiSelected = ['Observable'];
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: true,
      correctOptionTexts: ['map', 'filter'],
      selectedVerdicts: new Map([['map', true], ['filter', true], ['Observable', false]])
    });

    expect(durablePerfect([0, 1])).toBe(false);
  });
});

describe('with no verdict, the previous comparison still answers', () => {
  it.each([['idle'], ['checking'], ['error']] as const)(
    'falls back to the pristine comparison while %s',
    (phase) => {
      verdictState = state({ phase });

      expect(durablePerfect([0, 1])).toBe(true);
      expect(durablePerfect([0])).toBe(false);
    }
  );

  it('keeps the no-incorrect guard in the fallback too', () => {
    verdictState = state({ phase: 'idle' });

    expect(durablePerfect([0, 1, 2])).toBe(false);
  });
});

describe('selection order does not matter', () => {
  it('gives the same answer whichever order the options were picked', () => {
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: true,
      correctOptionTexts: ['map', 'filter'],
      selectedVerdicts: new Map([['filter', true], ['map', true]])
    });

    expect(durablePerfect([1, 0])).toBe(true);
  });
});
