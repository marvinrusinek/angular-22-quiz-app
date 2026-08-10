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
 * The multi-answer disable/lock mutation.
 *
 * It used to receive a full correct-index set and read every answer off it —
 * including options the user had never touched — to decide what to disable,
 * what to stamp as correct, and when the question was complete.
 *
 * The verdict supplies strictly less: a selection carries its own verdict, the
 * count of still-missing correct answers arrives without naming them, and the
 * full set appears only once the question is terminal.
 *
 * The invariant under test throughout: WHILE INCOMPLETE, AN UNSELECTED OPTION
 * MUST NOT BECOME DISTINGUISHABLE. Every fixture below therefore passes a
 * deliberately WRONG `effectiveCorrectIndices`, so any test that still reflects
 * the answer key is reading the bank rather than the verdict.
 */

const QUESTION = 'Which are RxJS operators?';

/** 'map' and 'filter' are truly correct; 'Subject' and 'Observable' are not. */
const OPTION_TEXTS = ['map', 'Subject', 'filter', 'Observable'];
const TRUE_CORRECT = [0, 2];

/** A set that names the WRONG options, to prove the verdict path ignores it. */
const LYING_INDICES = [1, 3];

let service: SocAnswerProcessingService;
let verdictState: QuestionVerdictState;

const state = (over: Partial<QuestionVerdictState>): QuestionVerdictState =>
  ({ ...IDLE_VERDICT_STATE, ...over });

/** `mode` decides what the local bank CLAIMS about each option. */
function makeComp(mode: 'truthful' | 'lying' | 'bare' = 'lying', order: 'forward' | 'reversed' = 'forward') {
  const texts = order === 'forward' ? [...OPTION_TEXTS] : [...OPTION_TEXTS].reverse();
  const opts = texts.map((text, i) => {
    const trulyCorrect = TRUE_CORRECT.map((c) => OPTION_TEXTS[c]).includes(text);
    if (mode === 'bare') return { optionId: i + 1, text };
    if (mode === 'truthful') return { optionId: i + 1, text, correct: trulyCorrect };
    return { optionId: i + 1, text, correct: !trulyCorrect };  // inverted
  });

  let bindings = opts.map((o, i) => ({
    option: { ...o, active: true },
    index: i,
    isSelected: false,
    isCorrect: null as boolean | null,
    disabled: false
  }));

  return {
    optionsToDisplay: opts,
    optionBindings: Object.assign(() => bindings, { set: (next: any[]) => { bindings = next; } }),
    currentQuestion: () => ({ questionText: QUESTION, options: opts }),
    disabledOptionsPerQuestion: new Map<number, Set<number>>(),
    cdRef: { markForCheck: () => undefined, detectChanges: () => undefined },
    get bindings() { return bindings; },
    indexOfText: (t: string) => texts.indexOf(t)
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
          questions: [{ questionText: QUESTION, options: [] }],
          getQuestionsInDisplayOrder: () => [{ questionText: QUESTION, options: [] }],
          getCurrentQuestionIndex: () => 0,
          isShuffleEnabled: () => false,
          shuffledQuestions: [],
          quizInitialState: [],
          totalQuestions: () => 1,
          getPristineCorrectTextsForQuestion: () => new Set<string>(),
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
      { provide: QuestionVerdictService, useValue: { verdictFor: () => verdictState } }
    ]
  });
  service = TestBed.inject(SocAnswerProcessingService);
});

/** Drive the mutation with a deliberately misleading local correct set. */
const run = (c: any, clickedIndex: number, durable: number[], correctIdxs = LYING_INDICES) =>
  (service as any).applyMultiAnswerDisableState(
    c, clickedIndex, 0, 0, new Set(durable), correctIdxs
  );

/** Partial play: user picked 'map' (correct); 'filter' is still outstanding. */
const partialVerdict = () => state({
  phase: 'incomplete',
  selectedOptionTexts: ['map'],
  selectedVerdicts: new Map([['map', true]]),
  remainingCorrectCount: 1
});

describe('while incomplete, an unselected option reveals nothing', () => {
  it('leaves untouched options with UNKNOWN correctness, not false', () => {
    verdictState = partialVerdict();
    const c = makeComp();
    const { bindingUpdates } = run(c, 0, [0]);

    expect(bindingUpdates[0].isCorrect).toBe(true);     // the user's own pick
    expect(bindingUpdates[1].isCorrect).toBeNull();     // untouched
    expect(bindingUpdates[2].isCorrect).toBeNull();     // untouched AND correct
    expect(bindingUpdates[3].isCorrect).toBeNull();
  });

  it('does not distinguish the outstanding correct option from a wrong one', () => {
    verdictState = partialVerdict();
    const c = makeComp();
    const { bindingUpdates } = run(c, 0, [0]);

    // 'filter' (correct, unselected) must be indistinguishable from
    // 'Subject' (incorrect, unselected) in every field.
    const filterUpd = bindingUpdates[2];
    const subjectUpd = bindingUpdates[1];
    expect(filterUpd.isCorrect).toEqual(subjectUpd.isCorrect);
    expect(filterUpd.disabled).toEqual(subjectUpd.disabled);
    expect(filterUpd.optionOverrides.correct).toEqual(subjectUpd.optionOverrides.correct);
    expect(filterUpd.optionOverrides.highlight).toEqual(subjectUpd.optionOverrides.highlight);
    expect(filterUpd.optionOverrides.showIcon).toEqual(subjectUpd.optionOverrides.showIcon);
  });

  it('clears the bank flag off the option copy instead of passing it through', () => {
    verdictState = partialVerdict();
    const c = makeComp('truthful');   // bank would happily say 'filter' is correct
    const { bindingUpdates } = run(c, 0, [0]);

    expect(bindingUpdates[2].optionOverrides.correct).toBeUndefined();
  });

  it('highlight and showIcon follow SELECTION only', () => {
    verdictState = partialVerdict();
    const c = makeComp();
    const { bindingUpdates } = run(c, 0, [0]);

    expect(bindingUpdates[0].optionOverrides.highlight).toBe(true);
    for (const bi of [1, 2, 3]) {
      expect(bindingUpdates[bi].optionOverrides.highlight).toBe(false);
      expect(bindingUpdates[bi].optionOverrides.showIcon).toBe(false);
    }
  });

  it('does not mark the question complete while answers are outstanding', () => {
    verdictState = partialVerdict();
    const c = makeComp();
    const { clickState } = run(c, 0, [0]);

    expect(clickState.remaining).toBe(1);
    expect(TestBed.inject(QuizService)._multiAnswerPerfect.get(0)).toBeUndefined();
  });

  it('never names the outstanding answers in the click state', () => {
    verdictState = partialVerdict();
    const c = makeComp();
    const { clickState } = run(c, 0, [0]);

    expect(clickState.correctIndices1Based).toEqual([]);
  });
});

describe('a wrong pick discloses only itself', () => {
  it('disables the wrong pick and nothing else', () => {
    verdictState = state({
      phase: 'incomplete',
      selectedOptionTexts: ['Subject'],
      selectedVerdicts: new Map([['Subject', false]]),
      remainingCorrectCount: 2
    });
    const c = makeComp();
    const { clickState, bindingUpdates } = run(c, 1, [1]);

    expect(clickState.isClickedCorrect).toBe(false);
    expect(bindingUpdates[1].disabled).toBe(true);
    expect(bindingUpdates[0].disabled).toBe(false);
    expect(bindingUpdates[2].disabled).toBe(false);
    expect(bindingUpdates[3].disabled).toBe(false);
  });

  it('still says nothing about the correct options', () => {
    verdictState = state({
      phase: 'incomplete',
      selectedOptionTexts: ['Subject'],
      selectedVerdicts: new Map([['Subject', false]]),
      remainingCorrectCount: 2
    });
    const c = makeComp();
    const { bindingUpdates } = run(c, 1, [1]);

    expect(bindingUpdates[0].isCorrect).toBeNull();
    expect(bindingUpdates[2].isCorrect).toBeNull();
  });
});

describe('completion is authorized disclosure', () => {
  const resolved = () => state({
    phase: 'resolved',
    isResolvedCorrect: true,
    selectedOptionTexts: ['map', 'filter'],
    selectedVerdicts: new Map([['map', true], ['filter', true]]),
    correctOptionTexts: ['map', 'filter'],
    remainingCorrectCount: 0
  });

  it('greys out the losers and keeps the winners enabled', () => {
    verdictState = resolved();
    const c = makeComp();
    const { clickState, bindingUpdates } = run(c, 2, [0, 2]);

    expect(clickState.remaining).toBe(0);
    expect(bindingUpdates[0].disabled).toBe(false);
    expect(bindingUpdates[2].disabled).toBe(false);
    expect(bindingUpdates[1].disabled).toBe(true);
    expect(bindingUpdates[3].disabled).toBe(true);
  });

  it('marks the question complete', () => {
    verdictState = resolved();
    run(makeComp(), 2, [0, 2]);

    expect(TestBed.inject(QuizService)._multiAnswerPerfect.get(0)).toBe(true);
  });

  it('reveals the correct set from the verdict, ignoring the lying local set', () => {
    verdictState = resolved();
    const { clickState } = run(makeComp(), 2, [0, 2]);

    // LYING_INDICES is [1,3]; the verdict says [0,2] → 1-based [1,3].
    // Identical shape, so assert the CONTENT is the verdict's.
    expect(clickState.correctIndices1Based).toEqual([1, 3]);
    expect(clickState.correctSelected).toBe(2);
    expect(clickState.incorrectSelected).toBe(0);
  });
});

describe('superset: extra wrong picks still count as complete', () => {
  const supersetVerdict = () => state({
    phase: 'resolved',
    isResolvedCorrect: true,
    selectedOptionTexts: ['map', 'filter', 'Subject'],
    selectedVerdicts: new Map([['map', true], ['filter', true], ['Subject', false]]),
    correctOptionTexts: ['map', 'filter'],
    remainingCorrectCount: 0
  });

  it('completes even though a wrong option is also selected', () => {
    verdictState = supersetVerdict();
    const { clickState } = run(makeComp(), 2, [0, 1, 2]);

    expect(clickState.remaining).toBe(0);
    expect(TestBed.inject(QuizService)._multiAnswerPerfect.get(0)).toBe(true);
  });

  it('keeps the wrong selection distinguishable from the right ones', () => {
    verdictState = supersetVerdict();
    const { clickState, bindingUpdates } = run(makeComp(), 2, [0, 1, 2]);

    expect(clickState.correctSelected).toBe(2);
    expect(clickState.incorrectSelected).toBe(1);
    expect(bindingUpdates[1].isCorrect).toBe(false);
    expect(bindingUpdates[0].isCorrect).toBe(true);
  });
});

describe('the verdict outranks the local answer key', () => {
  it('ignores a bank that inverts every flag', () => {
    verdictState = partialVerdict();
    const c = makeComp('lying');   // bank says Subject+Observable are correct
    const { clickState, bindingUpdates } = run(c, 0, [0]);

    expect(clickState.isClickedCorrect).toBe(true);   // bank called 'map' wrong
    expect(bindingUpdates[1].isCorrect).toBeNull();   // bank called 'Subject' right
    expect(bindingUpdates[3].isCorrect).toBeNull();
  });

  it('works when the options carry no `correct` property at all', () => {
    verdictState = partialVerdict();
    const { clickState, bindingUpdates } = run(makeComp('bare'), 0, [0]);

    expect(clickState.isClickedCorrect).toBe(true);
    expect(bindingUpdates[0].isCorrect).toBe(true);
  });

  it('ignores a misleading effectiveCorrectIndices entirely', () => {
    verdictState = partialVerdict();
    // Name EVERY index as correct — if it leaked, nothing would stay unknown.
    const { bindingUpdates } = run(makeComp('bare'), 0, [0], [0, 1, 2, 3]);

    expect(bindingUpdates[1].isCorrect).toBeNull();
    expect(bindingUpdates[2].isCorrect).toBeNull();
    expect(bindingUpdates[3].isCorrect).toBeNull();
  });

  it('resolves by option TEXT, so display order does not matter', () => {
    verdictState = partialVerdict();
    const c = makeComp('bare', 'reversed');   // Observable, filter, Subject, map
    const mapIdx = c.indexOfText('map');
    const { clickState, bindingUpdates } = run(c, mapIdx, [mapIdx]);

    expect(clickState.isClickedCorrect).toBe(true);
    expect(bindingUpdates[mapIdx].isCorrect).toBe(true);
    expect(bindingUpdates[c.indexOfText('filter')].isCorrect).toBeNull();
  });
});

describe('an unchecked question falls back rather than guessing', () => {
  it.each([['idle'], ['checking'], ['error']] as const)(
    'uses the local set while %s',
    (phase) => {
      verdictState = state({ phase });
      const c = makeComp();
      // Fallback consults effectiveCorrectIndices, here the truthful [0, 2].
      const { clickState } = run(c, 0, [0], TRUE_CORRECT);

      expect(clickState.isClickedCorrect).toBe(true);
      expect(clickState.remaining).toBe(1);
    }
  );

  it('falls back when the verdict cannot answer for the clicked option', () => {
    // Knows about a DIFFERENT pick, nothing for the one just clicked.
    verdictState = state({
      phase: 'incomplete',
      selectedOptionTexts: ['Subject'],
      selectedVerdicts: new Map([['Subject', false]]),
      remainingCorrectCount: 2
    });
    const c = makeComp();
    const { clickState } = run(c, 0, [0], TRUE_CORRECT);

    // Index 0 is 'map', which the fallback set calls correct.
    expect(clickState.isClickedCorrect).toBe(true);
  });

  it('does not treat an unchecked pick as a wrong pick', () => {
    verdictState = state({ phase: 'checking' });
    const c = makeComp();
    const { bindingUpdates } = run(c, 0, [0], TRUE_CORRECT);

    expect(bindingUpdates[0].disabled).toBe(false);
  });
});
