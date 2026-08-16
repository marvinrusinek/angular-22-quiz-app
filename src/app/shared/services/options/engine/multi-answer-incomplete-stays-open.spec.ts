import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { SocAnswerProcessingService } from './soc-answer-processing.service';
import { ExplanationTextService } from '../../features/explanation/explanation-text.service';
import { FeedbackService } from '../../features/feedback/feedback.service';
import { NextButtonStateService } from '../../state/next-button-state.service';
import { QuestionVerdictService } from '../../features/verdict/question-verdict.service';
import { SelectionMessageService } from '../../features/selection-message/selection-message.service';
import { SharedOptionExplanationService } from '../../features/shared-option/shared-option-explanation.service';
import { QuizService } from '../../data/quiz.service';
import { QuizStateService } from '../../state/quizstate.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { TimerService } from '../../features/timer/timer.service';
import { API_BASE_URL } from '../../../tokens/api-base-url.token';
import { IDLE_VERDICT_STATE } from '../../features/verdict/question-verdict.types';
import type { QuestionVerdictState } from '../../features/verdict/question-verdict.types';
import { answerStateStub } from '../../../testing/answer-state-stub';
import { norm } from '../../../utils/text-norm';

/**
 * A WRONG PICK MUST NOT END A MULTI-ANSWER QUESTION.
 *
 * The all-incorrects-exhausted auto-reveal fires when every WRONG option has
 * been selected. On a single-answer question that is genuinely terminal — the
 * lone survivor is the answer. On a multi-answer question it is not: the
 * options still unpicked are the correct ones the user has not found.
 *
 * DI Q3 and Directives Q8 have three correct options and exactly ONE wrong one,
 * so the user's FIRST click on that wrong option exhausted the incorrects.
 * `applyMultiAnswerLockBindings` then set `disabled: !wasPicked` on every
 * correct option, and the question became unanswerable on the first click. That
 * shipped (main d3d13ee7 / gh-pages 1d3580c).
 *
 * The gate is authorized completion, under the superset rule: every correct
 * option selected, extra wrong picks tolerated. Nothing here counts `correct`
 * flags to decide it, and UNKNOWN (idle/checking/error) is not completion — it
 * must leave the question open, which is the ordinary state at click time under
 * the API adapter.
 */

const QUESTION = 'When is creating a custom attribute directive a good choice?';

/** Directives Q8's shape: options 0,1,2 correct; option 3 wrong. */
const TEXTS = [
  'reuse DOM behavior',
  'encapsulate cross-cutting behavior',
  'keep repeated logic in one place',
  'display a new section of UI'
];
const CORRECT_TEXTS = new Set(TEXTS.slice(0, 3).map((t) => norm(t)));

let service: SocAnswerProcessingService;
let verdictState: QuestionVerdictState;
let nextButtonEnabled: boolean;
let timerStopped: boolean;
let errorSpy: jest.SpyInstance;

afterEach(() => errorSpy?.mockRestore());

function state(patch: Partial<QuestionVerdictState>): QuestionVerdictState {
  return { ...IDLE_VERDICT_STATE, ...patch } as QuestionVerdictState;
}

/**
 * `clicked` is the durable click set for the question. The component shape
 * mirrors makeComp() in multi-answer-end-state.spec.ts.
 */
function makeComp(clicked: number[]) {
  const opts = TEXTS.map((text, i) => ({ optionId: i + 1, text, correct: i < 3 }));
  let bindings = opts.map((o, i) => ({
    option: { ...o, active: true },
    index: i,
    isSelected: clicked.includes(i),
    isCorrect: null as boolean | null,
    disabled: false
  }));
  return {
    optionsToDisplay: opts,
    optionBindings: Object.assign(() => bindings, { set: (n: any[]) => { bindings = n; } }),
    currentQuestion: () => ({ questionText: QUESTION, options: opts }),
    disabledOptionsPerQuestion: new Map<number, Set<number>>(),
    _multiSelectByQuestion: new Map<number, Set<number>>([[0, new Set(clicked)]]),
    cdRef: { markForCheck: () => undefined, detectChanges: () => undefined },
    showExplanationChange: { emit: () => undefined },
    emitExplanation: () => undefined
  };
}

/**
 * Run the auto-reveal exactly as a click on `index` would.
 *
 * The production method wraps everything in a try/catch that only console.errors,
 * so a stub gap would look identical to the gate doing its job — every
 * "stays open" assertion below would pass for the wrong reason. The spy makes
 * that impossible: a swallowed throw fails the test.
 */
const fire = (comp: any, index: number) => {
  (service as any).triggerAllIncorrectsExhaustedAutoReveal(comp, index, 0, 0);
  expect(errorSpy).not.toHaveBeenCalled();
};

beforeEach(() => {
  sessionStorage.clear();
  verdictState = IDLE_VERDICT_STATE;
  nextButtonEnabled = false;
  timerStopped = false;
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } },
      { provide: API_BASE_URL, useValue: 'https://api.test/api' },
      {
        provide: ExplanationTextService,
        useValue: {
          fetBypassForQuestion: new Map<number, boolean>(),
          _fetLocked: true,
          unlockExplanation: () => undefined,
          lockExplanation: () => undefined,
          storeFormattedExplanation: () => undefined,
          setExplanationText: () => undefined,
          emitFormatted: () => undefined,
          setShouldDisplayExplanation: () => undefined,
          setIsExplanationTextDisplayed: () => undefined,
          formatExplanation: (_q: any, _i: number[], t: string) => t
        }
      },
      { provide: QuizStateService, useValue: { setDisplayState: () => undefined } },
      {
        provide: NextButtonStateService,
        useValue: {
          setNextButtonState: (v: boolean) => { nextButtonEnabled = v; },
          forceEnable: () => undefined
        }
      },
      { provide: SelectionMessageService, useValue: { forceNextButtonMessage: () => undefined } },
      { provide: SharedOptionExplanationService, useValue: { resolveExplanationText: () => 'fet' } },
      {
        provide: QuizService,
        useValue: {
          quizId: 'directives',
          questions: [{ questionText: QUESTION, options: [] }],
          getQuestionsInDisplayOrder: () => [{ questionText: QUESTION, options: [] }],
          getCurrentQuestionIndex: () => 0,
          isShuffleEnabled: () => false,
          shuffledQuestions: [],
          quizInitialState: [],
          totalQuestions: () => 1,
          getPristineCorrectTextsForQuestion: () => CORRECT_TEXTS,
          ...answerStateStub(),
          quizReset$: of(undefined)
        }
      },
      {
        provide: SelectedOptionService,
        useValue: {
          uiSelectedTextsForQuestion: () => new Set<string>(),
          getSelectedOptionsForQuestion: () => [],
          stopTimer$: of(undefined),
          selectedOptionsMap: new Map(),
          clickConfirmedDotStatus: new Map()
        }
      },
      {
        provide: TimerService,
        useValue: { stopTimer: () => { timerStopped = true; }, resetTimer: () => undefined }
      },
      { provide: FeedbackService, useValue: { setCorrectMessage: () => '' } },
      { provide: QuestionVerdictService, useValue: { verdictFor: () => verdictState } }
    ]
  });

  service = TestBed.inject(SocAnswerProcessingService);
});

describe('multi-answer: an incomplete question stays open', () => {
  it('WRONG FIRST leaves every unfound correct option enabled', () => {
    // The shipped defect, in one click. Nothing is authorized yet — the check
    // is in flight — which is precisely when the old code locked the question.
    verdictState = state({ phase: 'checking', selectedOptionTexts: [TEXTS[3]] });

    const c = makeComp([3]);
    fire(c, 3);

    for (const i of [0, 1, 2]) {
      const b: any = c.optionBindings()[i];
      expect(b.disabled).toBe(false);
      expect(b._autoRevealLocked).toBeFalsy();
    }
  });

  it('WRONG FIRST does not end the question: no timer stop, no Next, no reveal', () => {
    verdictState = state({ phase: 'checking', selectedOptionTexts: [TEXTS[3]] });

    const c = makeComp([3]);
    fire(c, 3);

    expect(timerStopped).toBe(false);
    expect(nextButtonEnabled).toBe(false);
    // No correct answer is handed over, by any route.
    for (const b of c.optionBindings() as any[]) {
      expect(b._autoRevealedCorrect).toBeFalsy();
      expect(b.cssClasses?.['correct-option']).toBeFalsy();
    }
  });

  it('an AUTHORIZED incomplete verdict still leaves it open', () => {
    // remaining > 0 is the authority saying so in as many words.
    verdictState = state({ phase: 'incomplete', remainingCorrectCount: 3 });

    const c = makeComp([3]);
    fire(c, 3);

    for (const i of [0, 1, 2]) {
      expect((c.optionBindings()[i] as any).disabled).toBe(false);
    }
  });

  it('WRONG THEN PARTIAL-CORRECT is still completable', () => {
    // Two correct found, one outstanding, the wrong one already used up. This
    // is the owner-reported ordering that used to lock; the third correct
    // option must remain clickable.
    verdictState = state({ phase: 'incomplete', remainingCorrectCount: 1 });

    const c = makeComp([3, 0, 1]);
    fire(c, 1);

    expect((c.optionBindings()[2] as any).disabled).toBe(false);
    expect((c.optionBindings()[2] as any)._autoRevealLocked).toBeFalsy();
    // And it is not quietly revealed while it waits.
    expect((c.optionBindings()[2] as any)._autoRevealedCorrect).toBeFalsy();
  });

  it('UNKNOWN never counts as completion, in any of its three phases', () => {
    for (const phase of ['idle', 'checking', 'error'] as const) {
      verdictState = state({ phase });

      const c = makeComp([3]);
      fire(c, 3);

      for (const i of [0, 1, 2]) {
        expect((c.optionBindings()[i] as any).disabled).toBe(false);
      }
    }
  });

  it('the local answer key cannot authorize completion on its own', () => {
    // Every option carries `correct: true/false` in this fixture and the
    // pristine set is fully populated, so a count-based gate would have said
    // "one wrong option, all of them selected — done". The verdict says
    // otherwise and wins.
    verdictState = state({ phase: 'incomplete', remainingCorrectCount: 2 });

    const c = makeComp([3, 0]);
    fire(c, 0);

    expect((c.optionBindings()[1] as any).disabled).toBe(false);
    expect((c.optionBindings()[2] as any).disabled).toBe(false);
  });
});

describe('multi-answer: authorized completion may end it', () => {
  it('remaining === 0 lets the terminal path run', () => {
    verdictState = state({ phase: 'incomplete', remainingCorrectCount: 0 });

    const c = makeComp([0, 1, 2, 3]);
    fire(c, 3);

    expect(timerStopped).toBe(true);
    expect(nextButtonEnabled).toBe(true);
  });

  it('a resolved-correct terminal lets the terminal path run', () => {
    verdictState = state({ phase: 'resolved', isResolvedCorrect: true });

    const c = makeComp([0, 1, 2, 3]);
    fire(c, 3);

    expect(nextButtonEnabled).toBe(true);
    // The user's own picks keep their colours; nothing was left to grey.
    for (const i of [0, 1, 2]) {
      expect((c.optionBindings()[i] as any).cssClasses['correct-option']).toBe(true);
    }
    expect((c.optionBindings()[3] as any).cssClasses['incorrect-option']).toBe(true);
  });

  it('a resolved-but-INCORRECT terminal does not authorize completion', () => {
    // `isResolvedCorrect: false` is a question that ended without the correct
    // set being completed (timeout, or the authority saying so). It is terminal,
    // but it is not completion, and this gate asks for completion.
    verdictState = state({ phase: 'resolved', isResolvedCorrect: false });

    const c = makeComp([3]);
    fire(c, 3);

    for (const i of [0, 1, 2]) {
      expect((c.optionBindings()[i] as any).disabled).toBe(false);
    }
  });
});

describe('the single-answer reveal is untouched by the gate', () => {
  it('still fires with nothing authorized, because it is genuinely terminal', () => {
    // One correct option, three wrong. The user picked all three wrong ones, so
    // the survivor is the answer and there is nothing left to find. The gate
    // must not reach this path — it keys off multi-answer, not off the verdict.
    verdictState = state({ phase: 'checking' });

    const singleCorrect = new Set([norm(TEXTS[0])]);
    (TestBed.inject(QuizService) as any).getPristineCorrectTextsForQuestion = () => singleCorrect;

    const c = makeComp([1, 2, 3]);
    fire(c, 3);

    const revealed: any = c.optionBindings()[0];
    expect(revealed._autoRevealedCorrect).toBe(true);
    expect(revealed.cssClasses['correct-option']).toBe(true);
    expect(nextButtonEnabled).toBe(true);
  });
});
