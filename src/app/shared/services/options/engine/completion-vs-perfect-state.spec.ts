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
 * COMPLETION is not PERFECT.
 *
 * One boolean, the old `_multiAnswerPerfect` union, carried five meanings: superset
 * completion, true perfect, single-answer resolved, an auto-reveal render
 * signal, and the navigation-clear gate. Writers disagreed about which they
 * meant, which is why the last attempt to move it broke revisit rendering in a
 * way that took a bisect to even locate.
 *
 * The two precise states are now written alongside it. These tests pin the
 * distinction that the single boolean could not express:
 *
 *     completion — every required correct option selected; wrong extras OK
 *     perfect    — completion AND nothing incorrect selected
 *
 * Readers still read the legacy union, so behaviour is unchanged by design.
 * This proves the vocabulary is right before anything is migrated onto it.
 */

const QUESTION = 'Which are RxJS operators?';
const IDX = 0;

let service: SocAnswerProcessingService;
let quiz: any;

function makeComp() {
  const opts = ['map', 'Subject', 'filter', 'Observable'].map((text, i) => ({
    optionId: i + 1,
    text,
    correct: text === 'map' || text === 'filter'
  }));
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
          quizId: 'rxjs',
          questions: [{ questionText: QUESTION, options: [] }],
          getQuestionsInDisplayOrder: () => [{ questionText: QUESTION, options: [] }],
          getCurrentQuestionIndex: () => 0,
          isShuffleEnabled: () => false,
          shuffledQuestions: [],
          quizInitialState: [],
          totalQuestions: () => 1,
          getPristineCorrectTextsForQuestion: () => new Set<string>(),
          scoreDirectly: () => undefined,
          // The three states under test.
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
  quiz = TestBed.inject(QuizService);
});

const completion = () => quiz.multiAnswerCompletion.get(IDX);
const perfect = () => quiz.multiAnswerPerfect.get(IDX);
const resolved = () => quiz.questionResolved.get(IDX);

/** 'map'(0) and 'filter'(2) are the correct pair; 'Subject'(1) is wrong. */
const disablePass = (clicked: number, durable: number[]) =>
  (service as any).applyMultiAnswerDisableState(
    makeComp(), clicked, IDX, IDX, new Set(durable), [0, 2]
  );

describe('the click records the answer but never completes the question', () => {
  it('does NOT complete on the click, even with every correct option picked', () => {
    // `remaining === 0` here is bank-derived: the check is still in flight on
    // this click, so nothing has authorized a completion. The arrival handler
    // owns it — see multi-completion-arrival.spec.ts.
    disablePass(2, [0, 2]);

    expect(completion()).toBeUndefined();
    expect(perfect()).toBeUndefined();
  });

  it('does NOT complete on the click when a wrong option is also picked', () => {
    disablePass(2, [0, 1, 2]);   // map + Subject(wrong) + filter

    expect(completion()).toBeUndefined();
    expect(perfect()).toBeUndefined();
  });

  it('a partial selection is neither', () => {
    disablePass(0, [0]);         // one of two correct

    expect(completion()).toBeUndefined();
    expect(perfect()).toBeUndefined();
  });

  it('a wrong pick alone is neither', () => {
    disablePass(1, [1]);

    expect(completion()).toBeUndefined();
    expect(perfect()).toBeUndefined();
  });
});

describe('single-answer resolution does not pollute multi-answer state', () => {
  it('the SINGLE path is RESOLVED but neither complete nor perfect', () => {
    (service as any).scoreAndOpenFet(makeComp(), IDX, IDX, false);

    // The distinction the old union could not express: a single-answer question
    // is answered without any multi-answer question being finished.
    expect(resolved()).toBe(true);
    expect(completion()).toBeUndefined();
    expect(perfect()).toBeUndefined();
  });

  it('the MULTI path records RESOLVED, and defers completion to the verdict', () => {
    (service as any).scoreAndOpenFet(makeComp(), IDX, IDX, true);

    expect(resolved()).toBe(true);
    expect(completion()).toBeUndefined();
  });
});

describe('resolved is implied by completion, never the reverse', () => {
  it('answering a multi-answer question resolves it immediately', () => {
    disablePass(2, [0, 2]);

    // Resolved needs no correctness — the user answered. Completion waits.
    expect(resolved()).toBe(true);
    expect(completion()).toBeUndefined();
  });

  it('a partial selection resolves nothing', () => {
    disablePass(0, [0]);

    expect(resolved()).toBeUndefined();
    expect(completion()).toBeUndefined();
    expect(perfect()).toBeUndefined();
  });

  it('an earlier wrong pick still resolves, and never claims perfect', () => {
    disablePass(2, [0, 1, 2]);

    expect(resolved()).toBe(true);
    expect(perfect()).toBeUndefined();
  });

  it('COMPLETION never outruns RESOLVED', () => {
    for (const durable of [[0], [1], [0, 2], [0, 1, 2]]) {
      quiz.multiAnswerCompletion.clear();
      quiz.multiAnswerPerfect.clear();
      quiz.questionResolved.clear();
      disablePass(durable[durable.length - 1], durable);

      if (completion() === true) expect(resolved()).toBe(true);
      if (perfect() === true) expect(completion()).toBe(true);
    }
  });
});

describe('auto-reveal does not manufacture completion', () => {
  it('leaves every state untouched — it is a render concern, not an answer', () => {
    const c = makeComp();
    // Auto-reveal paints via `_autoRevealedCorrect` on the binding and
    // deliberately records no answer state, so a question the user got WRONG is
    // never marked finished. Pinning that here because a comment claiming the
    // opposite previously misdirected a whole migration.
    (service as any).applyAutoRevealBindings(
      c, c.optionBindings(), new Set([0, 2]), new Set<number>(), 1
    );

    expect(resolved()).toBeUndefined();
    expect(completion()).toBeUndefined();
    expect(perfect()).toBeUndefined();
    expect((c.optionBindings()[0] as any)._autoRevealedCorrect).toBe(true);
  });
});

describe('the durable session mirror still records completion', () => {
  it('writes the session key so a revisit in the same session rehydrates', () => {
    // The in-memory maps do not survive a reload; `question-resolution` falls
    // back to this key. Its name is historical — it records completion.
    disablePass(2, [0, 1, 2]);

    expect(sessionStorage.getItem('multi_perfect_' + IDX)).toBe('true');
  });

  it('perfect is never true while completion is false', () => {
    // The invariant that makes the split coherent: perfect is strictly
    // stronger, so it can never outrun completion.
    for (const scenario of [[0], [1], [0, 2], [0, 1, 2]]) {
      quiz.multiAnswerCompletion.clear();
      quiz.multiAnswerPerfect.clear();
      disablePass(scenario[scenario.length - 1], scenario);

      if (perfect() === true) expect(completion()).toBe(true);
    }
  });
});
