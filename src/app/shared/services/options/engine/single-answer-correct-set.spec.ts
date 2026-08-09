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
import { IDLE_VERDICT_STATE } from '../../features/verdict/question-verdict.types';

/**
 * Locking a single-answer question after a correct pick.
 *
 * The binding update needs to know which option is correct so it can disable
 * the rest. It used to rediscover that by scanning the bank for `correct`
 * flags — answering a question that had already been answered, since this code
 * runs ONLY when the clicked option was judged correct, and a single-answer
 * question has exactly one correct option (multi-answer clicks are routed away
 * before this point).
 *
 * So the correct set is the click. That is not an approximation; it is the
 * same set, derived from what the user did rather than from the answer key.
 *
 * It also fixes a latent break: with correctness absent from the options — the
 * shape /questions returns — the old scan produced an EMPTY set, and
 * `disabled: !isCorrectBinding` would then have disabled every option
 * including the user's correct pick.
 */

const QUESTION = 'Which operator maps values?';

let service: SocAnswerProcessingService;

/** Options carrying flags that lie, or none at all when `bare`. */
const optionsFor = (mode: 'lying' | 'bare' | 'truthful') => {
  const base = [
    { optionId: 1, text: 'map' },
    { optionId: 2, text: 'Subject' },
    { optionId: 3, text: 'Observable' }
  ];
  if (mode === 'bare') return base;
  if (mode === 'truthful') {
    return base.map((o, i) => ({ ...o, correct: i === 0 }));
  }
  // LYING: the bank claims the LAST option is the answer.
  return base.map((o, i) => ({ ...o, correct: i === 2 }));
};

function makeComp(mode: 'lying' | 'bare' | 'truthful') {
  const opts = optionsFor(mode);
  let bindings = opts.map((o, i) => ({
    option: { ...o, active: true },
    index: i,
    isSelected: false,
    disabled: false
  }));
  return {
    optionsToDisplay: opts,
    optionBindings: Object.assign(() => bindings, {
      set: (next: any[]) => { bindings = next; }
    }),
    currentQuestion: () => ({ questionText: QUESTION, options: opts }),
    getQuestionAtDisplayIndex: () => ({ questionText: QUESTION, options: opts }),
    _multiSelectByQuestion: new Map<number, Set<number>>(),
    disabledOptionsPerQuestion: new Map<number, Set<number>>(),
    cdRef: { markForCheck: () => undefined, detectChanges: () => undefined },
    emitExplanation: () => undefined,
    _feedbackDisplay: null as any,
    get bindings() { return bindings; }
  };
}

beforeEach(() => {
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
          questions: [{ questionText: QUESTION, options: optionsFor('truthful') }],
          getQuestionsInDisplayOrder: () => [{ questionText: QUESTION, options: optionsFor('truthful') }],
          isShuffleEnabled: () => false,
          shuffledQuestions: [],
          totalQuestions: () => 1,
          getPristineCorrectTextsForQuestion: () => new Set(['map']),
          _multiAnswerPerfect: new Map(),
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

/**
 * Drive the consumer of the correct set directly, with the set the migrated
 * caller now passes: the clicked index. Going through
 * handleSingleAnswerCorrect would also fire scoring and FET emission, which
 * are other concerns with their own authority chains.
 */
function lockAfterCorrectPick(c: any, index: number) {
  (service as any).applySingleAnswerCorrectBindings(c, index, 0, new Set([index]));
  return c.bindings;
}

describe('the clicked option is the correct set', () => {
  it('leaves the picked option enabled and disables the rest', () => {
    const c = makeComp('truthful');
    const bindings = lockAfterCorrectPick(c, 0);

    expect(bindings[0].disabled).toBe(false);
    expect(bindings[1].disabled).toBe(true);
    expect(bindings[2].disabled).toBe(true);
    expect(bindings[0].isSelected).toBe(true);
  });

  it('ignores a bank that names a DIFFERENT option as the answer', () => {
    // The bank claims index 2 is correct. The user picked index 0 and the
    // click was judged correct, so index 0 is what stays enabled.
    const c = makeComp('lying');
    const bindings = lockAfterCorrectPick(c, 0);

    expect(bindings[0].disabled).toBe(false);
    expect(bindings[2].disabled).toBe(true);
  });

  it('works when the options carry no `correct` property at all', () => {
    // THE LATENT BREAK. The old scan produced an empty set here, which would
    // have disabled every option — including the user's correct pick.
    const c = makeComp('bare');
    const bindings = lockAfterCorrectPick(c, 0);

    expect(bindings[0].disabled).toBe(false);
    expect(bindings.filter((b: any) => b.disabled)).toHaveLength(2);
  });

  it('locks around whichever option was picked, not a fixed position', () => {
    const c = makeComp('bare');
    const bindings = lockAfterCorrectPick(c, 2);

    expect(bindings[2].disabled).toBe(false);
    expect(bindings[0].disabled).toBe(true);
    expect(bindings[1].disabled).toBe(true);
  });

  it('keeps exactly one option enabled, whatever the flags say', () => {
    for (const mode of ['truthful', 'lying', 'bare'] as const) {
      const c = makeComp(mode);
      const bindings = lockAfterCorrectPick(c, 1);

      expect(bindings.filter((b: any) => !b.disabled)).toHaveLength(1);
      expect(bindings[1].disabled).toBe(false);
    }
  });
});

describe('the obsolete helper is gone', () => {
  it('no longer exposes a single-answer correct-set resolver', () => {
    // The concept was deleted rather than re-expressed, so the name should not
    // come back as a text/ID set under a new guise.
    expect((service as any).resolveSingleAnswerCorrectSet).toBeUndefined();
  });
});
