import { buildHeadingInputs } from './heading-inputs';
import { shouldShowFet } from './heading-model';

/**
 * A REVISIT IS NOT A REVEAL.
 *
 * `shouldShowFet` lets a timeout override its revisit guard on purpose: a
 * question timing out under the user's nose must show its explanation even
 * though `isNavigatingToPrevious` is still stale-true from the navigation that
 * brought them there.
 *
 * But the timer counts down to a per-question signed deadline, and returning to
 * a question whose deadline has already passed expires it ON ARRIVAL
 * (`TimerService.expireImmediately`). That fired the same signal, so pressing
 * Previous — or just coming back to the browser tab — replaced the question
 * text with the explanation. Reported on Directives Q8, where the heading
 * briefly showed the question and then flipped.
 *
 * The two expiries now answer different signals, and only the live one reveals.
 */

const IDX = 7;
const QUESTION = 'When is creating a custom attribute directive a good choice?';

/** Everything the heading reads, with the timer's two expiry facts injectable. */
function deps(expiredIdx: number, expiredOnArrivalIdx: number) {
  return {
    idx: IDX,
    quizService: {
      getQuestionsInDisplayOrder: () => {
        const q = { questionText: QUESTION, options: [{}, {}, {}, {}] };
        return Object.assign([], { [IDX]: q, length: IDX + 1 });
      },
      getPristineCorrectTextsForQuestion: () => new Set(['a', 'b', 'c']),
      isMultiAnswerComplete: () => false
    },
    explanationTextService: {
      formattedExplanations: { [IDX]: { explanation: 'Custom attribute directives shine for…' } },
      fetByIndex: new Map<number, string>(),
      timeoutFetByIndex: new Map<number, string>(),
      fetBypassForQuestion: new Map<number, boolean>([[IDX, true]])
    },
    timerService: {
      expiredForQuestionIndexSig: () => expiredIdx,
      expiredOnArrivalSig: () => expiredOnArrivalIdx
    },
    selectedOptionService: { selectedOptionsMap: new Map() },
    quizStateService: {
      hasUserInteracted: () => true,      // they answered it on the first visit
      wasInteractedThisVisit: () => false // …but not on this one
    },
    quizNavigationService: { isNavigatingToPreviousSig: () => true },
    quizQuestionManagerService: { getNumberOfCorrectAnswersText: () => '' },
    feedbackPolicyService: { feedbackMode: () => 'immediate' },
    questionVerdictService: undefined
  };
}

// The heading also requires options to be on screen; jsdom has none.
const withOptions = (i: any) => ({ ...i, optionsReady: true });

describe('returning to a question whose deadline has passed', () => {
  it('is not reported as a live timeout', () => {
    const inputs = buildHeadingInputs(deps(IDX, IDX) as any)!;

    expect(inputs.isTimedOut).toBe(false);
  });

  it('keeps the question text in the heading', () => {
    const inputs = withOptions(buildHeadingInputs(deps(IDX, IDX) as any)!);

    expect(shouldShowFet(inputs)).toBe(false);
  });
});

describe('a question that times out while the user is watching', () => {
  it('is still reported as a live timeout', () => {
    const inputs = buildHeadingInputs(deps(IDX, -1) as any)!;

    expect(inputs.isTimedOut).toBe(true);
  });

  it('still reveals its explanation, overriding the stale nav-back flag', () => {
    const inputs = withOptions(buildHeadingInputs(deps(IDX, -1) as any)!);

    expect(shouldShowFet(inputs)).toBe(true);
  });
});

describe('another question timing out says nothing about this one', () => {
  it('leaves this question on its question text', () => {
    const inputs = withOptions(buildHeadingInputs(deps(IDX + 1, -1) as any)!);

    expect(inputs.isTimedOut).toBe(false);
    expect(shouldShowFet(inputs)).toBe(false);
  });
});
