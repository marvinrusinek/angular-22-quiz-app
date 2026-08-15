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
import { QuizService } from '../../data/quiz.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { TimerService } from '../../features/timer/timer.service';
import { API_BASE_URL } from '../../../tokens/api-base-url.token';
import { IDLE_VERDICT_STATE } from '../../features/verdict/question-verdict.types';
import { answerStateStub } from '../../../testing/answer-state-stub';

/**
 * The MULTI-ANSWER END STATE.
 *
 * Reported on Directives Q8 ("When is creating a custom attribute directive a
 * good choice?"), which has THREE correct options and one wrong one. Selecting
 * two correct answers and then the single wrong one means every incorrect
 * option has been used up, which fires the auto-reveal. The single-answer
 * rebuild it shared did two things that are wrong for a multi-answer question:
 *
 *   - `isSelected: isClicked` deselected the user's earlier correct picks, so
 *     the selection re-published as just the clicked option and the verdict for
 *     those picks was dropped. With nothing authorized, the class path stamped
 *     `incorrect-option` — red, and `!important`, so it painted over the green
 *     background the reveal had just set.
 *   - it revealed the third correct option the user never found, in green.
 *
 * The result was three red options and one green one: the exact inverse of the
 * truth. The rule pinned here is the owner's: the user's correct picks are
 * green, their wrong picks are red, and everything unselected greys out.
 */

const QUESTION = 'When is creating a custom attribute directive a good choice?';

let service: SocAnswerProcessingService;

/** Directives Q8's shape: options 0,1,2 correct; option 3 wrong. */
function makeComp() {
  const opts = ['reuse DOM behavior', 'encapsulate cross-cutting behavior', 'keep repeated logic in one place', 'display a new section of UI'].map(
    (text, i) => ({ optionId: i + 1, text, correct: i < 3 })
  );
  let bindings = opts.map((o, i) => ({
    option: { ...o, active: true },
    index: i,
    isSelected: false,
    isCorrect: null as boolean | null,
    disabled: false
  }));
  return {
    optionsToDisplay: opts,
    optionBindings: Object.assign(() => bindings, { set: (n: any[]) => { bindings = n; } }),
    currentQuestion: () => ({ questionText: QUESTION, options: opts }),
    disabledOptionsPerQuestion: new Map<number, Set<number>>(),
    cdRef: { markForCheck: () => undefined, detectChanges: () => undefined },
    showExplanationChange: { emit: () => undefined }
  };
}

beforeEach(() => {
  sessionStorage.clear();

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
          storeFormattedExplanation: () => undefined,
          formatExplanation: (_q: any, _i: number[], t: string) => t
        }
      },
      { provide: NextButtonStateService, useValue: { setNextButtonState: () => undefined, forceEnable: () => undefined } },
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
          getPristineCorrectTextsForQuestion: () => new Set<string>(),
          scoreDirectly: () => undefined,
          ...answerStateStub(),
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
      { provide: QuestionVerdictService, useValue: { verdictFor: () => IDLE_VERDICT_STATE } }
    ]
  });

  service = TestBed.inject(SocAnswerProcessingService);
});

/** Picked options 0 and 1 earlier, just clicked 3. Correct set is {0,1,2}. */
const runMultiEndState = (comp: any) =>
  (service as any).applyAutoRevealBindings(
    comp, comp.optionBindings(), new Set([0, 1, 2]), new Set([0, 1, 3]), 3, true
  );

describe('multi-answer end state: green picks, red picks, grey leftovers', () => {
  it('keeps the correct picks selected and green', () => {
    const c = makeComp();
    runMultiEndState(c);

    for (const i of [0, 1]) {
      const b: any = c.optionBindings()[i];
      expect(b.isSelected).toBe(true);
      expect(b._autoRevealedCorrect).toBe(true);
      expect(b.cssClasses['correct-option']).toBe(true);
      // The regression: red over green, because `.incorrect-option` is
      // `!important` and beat the inline background.
      expect(b.cssClasses['incorrect-option']).toBe(false);
    }
  });

  it('paints the wrong pick red, and only the wrong pick', () => {
    const c = makeComp();
    runMultiEndState(c);

    const b: any = c.optionBindings()[3];
    expect(b.isSelected).toBe(true);
    expect(b.cssClasses['incorrect-option']).toBe(true);
    expect(b.cssClasses['correct-option']).toBe(false);
    expect(b._autoRevealedCorrect).toBe(false);
  });

  it('greys the unselected option out instead of revealing it', () => {
    const c = makeComp();
    runMultiEndState(c);

    const b: any = c.optionBindings()[2];   // correct, never picked
    expect(b.isSelected).toBe(false);
    expect(b.disabled).toBe(true);
    expect(b._autoRevealLocked).toBe(true);
    expect(b._autoRevealedCorrect).toBe(false);
    expect(b.cssClasses['correct-option']).toBe(false);
    expect(b.cssClasses['incorrect-option']).toBe(false);
  });

  it('discloses nothing about the option the user never picked', () => {
    const c = makeComp();
    runMultiEndState(c);

    // Not `false` either: "you did not pick this" must not be reported as
    // "this was wrong" — the same invariant unselected-disclosure.spec.ts pins.
    expect((c.optionBindings()[2] as any).isCorrect).toBeNull();
  });
});

describe('the single-answer reveal is untouched', () => {
  it('still reveals every correct option once the wrong ones are exhausted', () => {
    const c = makeComp();
    // No multi flag: the single-answer shape, where the reveal is the point —
    // the user eliminated every other option, so there is nothing left to give
    // away.
    (service as any).applyAutoRevealBindings(
      c, c.optionBindings(), new Set([0]), new Set([1, 2, 3]), 3
    );

    const revealed: any = c.optionBindings()[0];
    expect(revealed._autoRevealedCorrect).toBe(true);
    expect(revealed.cssClasses['correct-option']).toBe(true);
    expect(revealed._autoRevealLocked).toBeUndefined();
  });
});
