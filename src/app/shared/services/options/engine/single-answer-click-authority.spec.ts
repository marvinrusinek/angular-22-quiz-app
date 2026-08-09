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
 * "Was the option the user just clicked correct?" — the gate that decides
 * whether a single-answer question resolves, locks and reveals its FET.
 *
 * It used to answer from the bank: the clicked option's own `correct` flag,
 * falling back to matching its text against the pristine correct set across
 * several candidate question texts. The verdict answers the same question
 * directly, and it is the ONE fact a check discloses about a pick.
 *
 * `undefined` stays distinct from `false`: a pick that has not been checked is
 * not a wrong pick, so the bank scan survives as the labelled pre-verdict path.
 *
 * Fixtures below carry `correct` flags that lie in both directions.
 */

const QUESTION = 'Which operator maps values?';

let service: SocAnswerProcessingService;
let verdictState: QuestionVerdictState;

const state = (over: Partial<QuestionVerdictState>): QuestionVerdictState =>
  ({ ...IDLE_VERDICT_STATE, ...over });

/**
 * 'map' is truly the answer. `mode` decides what the local bank CLAIMS:
 *  - truthful: map correct
 *  - lying:    map wrong, Observable correct
 *  - bare:     no `correct` property anywhere
 */
const optionsFor = (mode: 'truthful' | 'lying' | 'bare') => {
  const base = [
    { optionId: 1, text: 'map' },
    { optionId: 2, text: 'Subject' },
    { optionId: 3, text: 'Observable' }
  ];
  if (mode === 'bare') return base;
  if (mode === 'truthful') return base.map((o, i) => ({ ...o, correct: i === 0 }));
  return base.map((o, i) => ({ ...o, correct: i === 2 }));
};

function makeComp(mode: 'truthful' | 'lying' | 'bare', order: 'forward' | 'reversed' = 'forward') {
  const opts = order === 'forward' ? optionsFor(mode) : [...optionsFor(mode)].reverse();
  return {
    optionsToDisplay: opts,
    optionBindings: () => opts.map((o, i) => ({ option: { ...o }, index: i })),
    currentQuestion: () => ({ questionText: QUESTION, options: opts })
  };
}

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
          // The bank the FALLBACK would consult: it claims 'Observable'.
          questions: [{ questionText: QUESTION, options: optionsFor('lying') }],
          getQuestionsInDisplayOrder: () => [{ questionText: QUESTION, options: optionsFor('lying') }],
          isShuffleEnabled: () => false,
          shuffledQuestions: [],
          getPristineCorrectTextsForQuestion: () => new Set(['Observable']),
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
      { provide: FeedbackService, useValue: { setCorrectMessage: () => '' } },
      { provide: QuestionVerdictService, useValue: { verdictFor: () => verdictState } }
    ]
  });
  service = TestBed.inject(SocAnswerProcessingService);
});

const clickIsCorrect = (c: any, index: number, isShuffled = false) =>
  (service as any).isSingleAnswerClickCorrect(c, index, 0, 0, isShuffled);

describe('the verdict for the clicked option decides', () => {
  it('reports correct when the verdict says the pick was right', () => {
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: true,
      selectedVerdicts: new Map([['map', true]])
    });

    expect(clickIsCorrect(makeComp('truthful'), 0)).toBe(true);
  });

  it('reports incorrect when the verdict says the pick was wrong', () => {
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: false,
      selectedVerdicts: new Map([['Subject', false]])
    });

    expect(clickIsCorrect(makeComp('truthful'), 1)).toBe(false);
  });

  it('overrides a bank that calls the clicked option WRONG', () => {
    // Bank: map is not correct. Verdict: it is. Verdict wins.
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: true,
      selectedVerdicts: new Map([['map', true]])
    });

    expect(clickIsCorrect(makeComp('lying'), 0)).toBe(true);
  });

  it('overrides a bank that calls the clicked option RIGHT', () => {
    // Bank: Observable is correct. Verdict: the pick was wrong. Verdict wins.
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: false,
      selectedVerdicts: new Map([['Observable', false]])
    });

    expect(clickIsCorrect(makeComp('lying'), 2)).toBe(false);
  });

  it('works when the options carry no `correct` property at all', () => {
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: true,
      selectedVerdicts: new Map([['map', true]])
    });

    expect(clickIsCorrect(makeComp('bare'), 0)).toBe(true);
  });

  it('follows the option text when the display order is reversed', () => {
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: true,
      selectedVerdicts: new Map([['map', true], ['Observable', false]])
    });

    // reversed => Observable, Subject, map
    const c = makeComp('bare', 'reversed');
    expect(clickIsCorrect(c, 2, true)).toBe(true);    // map, now last
    expect(clickIsCorrect(c, 0, true)).toBe(false);   // Observable, now first
  });
});

describe('an unchecked pick is not a wrong pick', () => {
  it.each([['idle'], ['checking'], ['error']] as const)(
    'falls back to the bank while %s',
    (phase) => {
      verdictState = state({ phase });

      // Fallback consults the bank, which here claims 'Observable' (index 2).
      expect(clickIsCorrect(makeComp('lying'), 2)).toBe(true);
      expect(clickIsCorrect(makeComp('lying'), 0)).toBe(false);
    }
  );

  it('falls back when the verdict knows a DIFFERENT pick but not this one', () => {
    verdictState = state({
      phase: 'incomplete',
      remainingCorrectCount: 1,
      selectedVerdicts: new Map([['Subject', false]])   // nothing for 'map'
    });

    // No verdict for index 0 → bank path, which calls 'Observable' correct.
    expect(clickIsCorrect(makeComp('lying'), 0)).toBe(false);
  });

  it('does not report a false positive for an unchecked wrong pick', () => {
    verdictState = state({ phase: 'checking' });

    expect(clickIsCorrect(makeComp('truthful'), 1)).toBe(false);
  });
});

describe('the misleading name is gone', () => {
  it('no longer exposes a "pristine" single-answer correctness gate', () => {
    expect((service as any).isPristineSingleCorrect).toBeUndefined();
    expect(typeof (service as any).isSingleAnswerClickCorrect).toBe('function');
  });
});
