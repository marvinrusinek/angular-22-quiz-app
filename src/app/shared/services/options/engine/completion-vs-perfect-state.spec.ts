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

/**
 * COMPLETION is not PERFECT.
 *
 * One boolean, `_multiAnswerPerfect`, carried at least five meanings: superset
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
          _multiAnswerPerfect: new Map<number, boolean>(),
          multiAnswerCompletion: new Map<number, boolean>(),
          multiAnswerPerfect: new Map<number, boolean>(),
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
const legacyUnion = () => quiz._multiAnswerPerfect.get(IDX);

/** 'map'(0) and 'filter'(2) are the correct pair; 'Subject'(1) is wrong. */
const disablePass = (clicked: number, durable: number[]) =>
  (service as any).applyMultiAnswerDisableState(
    makeComp(), clicked, IDX, IDX, new Set(durable), [0, 2]
  );

describe('completion tolerates a wrong extra; perfect does not', () => {
  it('all correct PLUS a wrong pick counts as completion, not perfect', () => {
    disablePass(2, [0, 1, 2]);   // map + Subject(wrong) + filter

    expect(completion()).toBe(true);
    // This writer only ever meant completion. Claiming perfect here would grey
    // out the wrong pick instead of leaving its red repaint.
    expect(perfect()).toBeUndefined();
  });

  it('all correct with nothing wrong is completion too', () => {
    disablePass(2, [0, 2]);

    expect(completion()).toBe(true);
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
  it('the SINGLE path leaves both multi states untouched', () => {
    (service as any).scoreAndOpenFet(makeComp(), IDX, IDX, false);

    // Despite writing the legacy union — whose name says "multiAnswerPerfect" —
    // resolving one single-answer pick is not a multi-answer fact.
    expect(completion()).toBeUndefined();
    expect(perfect()).toBeUndefined();
    expect(legacyUnion()).toBe(true);
  });

  it('the MULTI path records completion', () => {
    (service as any).scoreAndOpenFet(makeComp(), IDX, IDX, true);

    expect(completion()).toBe(true);
    expect(legacyUnion()).toBe(true);
  });
});

describe('the legacy union still sees everything', () => {
  it('is set by a completion writer, so existing readers are unaffected', () => {
    disablePass(2, [0, 1, 2]);

    expect(legacyUnion()).toBe(true);
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
