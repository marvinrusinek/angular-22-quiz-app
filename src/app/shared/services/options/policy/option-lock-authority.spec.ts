import { TestBed } from '@angular/core/testing';

import { OptionLockPolicyService } from './option-lock-policy.service';
import { QuizService } from '../../data/quiz.service';
import { QuestionVerdictService } from '../../features/verdict/question-verdict.service';
import { QuestionType } from '../../../models/question-type.enum';
import { IDLE_VERDICT_STATE, type QuestionVerdictState } from '../../features/verdict/question-verdict.types';
import type { OptionBindings } from '../../../models/OptionBindings.model';

/**
 * WHO DECIDES WHICH OPTIONS LOCK.
 *
 * The policy used to rebuild the correct set from `quizInitialState` whenever no
 * verdict had been recorded. Under the API adapter the phase is `checking` for
 * the whole in-flight window after every click, so that path ran during ordinary
 * play and locked options from the ANSWER KEY before the server had answered.
 *
 * The invariant these tests defend:
 *
 *     a SELECTED option may be locked from its own verdict
 *     an UNSELECTED option's correctness is UNKNOWN until a terminal phase
 *
 * Every fixture below ships a local answer key that LIES — each option carries a
 * `correct` flag inverted from the truth. Any assertion that tracks those flags
 * would be reading the bank, which is exactly what must no longer happen.
 */

const QUESTION = 'Which are RxJS operators?';
/** 'map' and 'filter' are truly correct; 'Subject' and 'Observable' are not. */
const TEXTS = ['map', 'Subject', 'filter', 'Observable'];
const TRULY_CORRECT = ['map', 'filter'];

let service: OptionLockPolicyService;
let verdictState: QuestionVerdictState;

const state = (over: Partial<QuestionVerdictState>): QuestionVerdictState =>
  ({ ...IDLE_VERDICT_STATE, ...over });

/** Bindings whose `correct` flags are INVERTED relative to the truth. */
function makeBindings(selected: string[] = [], mode: 'lying' | 'bare' = 'lying'): OptionBindings[] {
  return TEXTS.map((text, i) => {
    const option: any = { optionId: i + 1, text, active: true };
    if (mode === 'lying') option.correct = !TRULY_CORRECT.includes(text);
    return {
      option,
      index: i,
      isSelected: selected.includes(text),
      isCorrect: null,
      disabled: false
    } as unknown as OptionBindings;
  });
}

/** The real caller's policy: lock once a correct pick exists, or all are in. */
const computeShouldLock = (
  _type: QuestionType,
  hasCorrectSelection: boolean,
  allCorrectSelected: boolean
) => hasCorrectSelection || allCorrectSelected;

function run(bindings: OptionBindings[], type = QuestionType.MultipleAnswer) {
  return service.updateLockedIncorrectOptions({
    bindings,
    forceDisableAll: false,
    resolvedType: type,
    computeShouldLockIncorrectOptions: computeShouldLock
  });
}

const lockedTexts = (bindings: OptionBindings[]) =>
  bindings.filter((b) => b.disabled).map((b) => (b.option as any).text).sort();

beforeEach(() => {
  verdictState = IDLE_VERDICT_STATE;

  TestBed.configureTestingModule({
    providers: [
      OptionLockPolicyService,
      {
        provide: QuizService,
        useValue: {
          quizId: 'rxjs',
          currentQuestionIndex: 0,
          getQuestionsInDisplayOrder: () => [{ questionText: QUESTION }],
          questions: [{ questionText: QUESTION }],
          isShuffleEnabled: () => false,
          shuffledQuestions: [],
          // Present and lying. If the policy ever reads it again, the
          // no-early-lock tests below fail.
          quizInitialState: [{
            quizId: 'rxjs',
            questions: [{
              questionText: QUESTION,
              options: TEXTS.map((text, i) => ({
                optionId: i + 1, text, correct: !TRULY_CORRECT.includes(text)
              }))
            }]
          }]
        }
      },
      { provide: QuestionVerdictService, useValue: { verdictFor: () => verdictState } }
    ]
  });
  service = TestBed.inject(OptionLockPolicyService);
});

describe('nothing is authorized yet', () => {
  it('locks nothing while a check is in flight, despite a lying bank', () => {
    // THE LIVE WINDOW. Under the API adapter every click sits in `checking`
    // until the response lands. The bank claims Subject+Observable are the
    // answers and both are picked, so the old path would have called this
    // complete and locked the rest.
    verdictState = state({ phase: 'checking' });
    const bindings = makeBindings(['Subject', 'Observable']);

    const res = run(bindings);

    expect(res.allCorrectSelectedForLock).toBe(false);
    expect(lockedTexts(bindings)).toEqual([]);
  });

  it('locks nothing while idle', () => {
    const bindings = makeBindings([]);
    const res = run(bindings);

    expect(res.shouldLockIncorrectOptions).toBe(false);
    expect(lockedTexts(bindings)).toEqual([]);
  });

  it('locks nothing after an error', () => {
    verdictState = state({ phase: 'error' });
    const bindings = makeBindings(['map']);

    run(bindings);

    expect(lockedTexts(bindings)).toEqual([]);
  });

  it('never marks a binding correct from the bank', () => {
    verdictState = state({ phase: 'checking' });
    const bindings = makeBindings(['map', 'filter']);

    run(bindings);

    // `isCorrect` is verdict-only now. The bank says Subject/Observable are
    // correct; nothing may have been stamped from it.
    expect(bindings.every((b) => b.isCorrect === null)).toBe(true);
  });

  it('works when options carry no `correct` property at all', () => {
    // The shape the API actually returns.
    verdictState = state({ phase: 'checking' });
    const bindings = makeBindings(['map'], 'bare');

    expect(() => run(bindings)).not.toThrow();
    expect(lockedTexts(bindings)).toEqual([]);
  });
});

describe('the verdict decides locking', () => {
  it('does not lock on a pick the bank calls correct but the verdict calls wrong', () => {
    // 'Subject' carries correct:true in the lying bank.
    verdictState = state({
      phase: 'incomplete',
      remainingCorrectCount: 2,
      selectedVerdicts: new Map([['Subject', false]])
    });
    const bindings = makeBindings(['Subject']);

    const res = run(bindings);

    expect(res.hasCorrectSelectionForLock).toBe(false);
    expect(lockedTexts(bindings)).toEqual([]);
  });

  it('recognises a correct pick the bank calls wrong', () => {
    // 'map' carries correct:false in the lying bank; the verdict says right.
    verdictState = state({
      phase: 'incomplete',
      remainingCorrectCount: 1,
      selectedVerdicts: new Map([['map', true]])
    });
    const bindings = makeBindings(['map']);

    const res = run(bindings);

    expect(res.hasCorrectSelectionForLock).toBe(true);
  });

  it('leaves an UNSELECTED correct option unknown while incomplete', () => {
    // 'filter' is truly correct and untouched. It must not be revealed or
    // treated as known — that is the answer key leaking through the lock.
    verdictState = state({
      phase: 'incomplete',
      remainingCorrectCount: 1,
      selectedVerdicts: new Map([['map', true]])
    });
    const bindings = makeBindings(['map']);

    run(bindings);

    const filter = bindings.find((b) => (b.option as any).text === 'filter')!;
    expect(filter.isCorrect).toBeNull();
    expect(filter.disabled).toBe(false);
  });

  it('keeps a partial multi-answer interactive', () => {
    verdictState = state({
      phase: 'incomplete',
      remainingCorrectCount: 1,
      selectedVerdicts: new Map([['map', true]])
    });
    const bindings = makeBindings(['map']);

    const res = run(bindings);

    expect(res.allCorrectSelectedForLock).toBe(false);
    expect(bindings.filter((b) => !b.isSelected).every((b) => !b.disabled)).toBe(true);
  });
});

describe('terminal phases authorize the full reveal', () => {
  it('locks everything on a perfect resolved multi-answer', () => {
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: true,
      correctOptionTexts: ['map', 'filter'],
      selectedVerdicts: new Map([['map', true], ['filter', true]])
    });
    const bindings = makeBindings(['map', 'filter']);

    const res = run(bindings);

    expect(res.allCorrectSelectedForLock).toBe(true);
    expect(lockedTexts(bindings)).toEqual(['Observable', 'Subject', 'filter', 'map']);
  });

  it('leaves the picked options unlocked when resolved but imperfect', () => {
    // Superset rule: all correct picked PLUS a wrong one. The user must still
    // be able to unselect the wrong pick, so only unpicked options lock.
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: true,
      correctOptionTexts: ['map', 'filter'],
      selectedVerdicts: new Map([['map', true], ['filter', true], ['Observable', false]])
    });
    const bindings = makeBindings(['map', 'filter', 'Observable']);

    run(bindings);

    expect(lockedTexts(bindings)).toEqual(['Subject']);
  });

  it('reveals and locks on an EXPIRED question', () => {
    verdictState = state({
      phase: 'expired',
      correctOptionTexts: ['map', 'filter'],
      selectedVerdicts: new Map()
    });
    const bindings = makeBindings([]);

    run(bindings);

    const filter = bindings.find((b) => (b.option as any).text === 'filter')!;
    expect(filter.isCorrect).toBe(true);
  });

  it('reveals the truth, not the bank, on a terminal phase', () => {
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: true,
      correctOptionTexts: ['map', 'filter'],
      selectedVerdicts: new Map([['map', true], ['filter', true]])
    });
    const bindings = makeBindings(['map', 'filter']);

    run(bindings);

    const byText = (t: string) => bindings.find((b) => (b.option as any).text === t)!;
    expect(byText('map').isCorrect).toBe(true);
    expect(byText('filter').isCorrect).toBe(true);
    // The lying bank marks these correct; the verdict does not.
    expect(byText('Subject').isCorrect).toBe(false);
    expect(byText('Observable').isCorrect).toBe(false);
  });
});

describe('single-answer', () => {
  it('locks the whole question once the verdict confirms the pick', () => {
    // A resolved single-answer pick with nothing wrong selected is PERFECT, and
    // the perfect branch disables every option including the chosen one. The
    // "keep the selected one alive" branch is for the not-yet-perfect case.
    // Pinned as pre-existing behaviour, unchanged by the authority migration.
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: true,
      correctOptionTexts: ['map'],
      selectedVerdicts: new Map([['map', true]])
    });
    const bindings = makeBindings(['map']);

    run(bindings, QuestionType.SingleAnswer);

    expect(lockedTexts(bindings)).toEqual(['Observable', 'Subject', 'filter', 'map']);
  });

  it('does not lock while the single-answer check is still in flight', () => {
    verdictState = state({ phase: 'checking' });
    const bindings = makeBindings(['map']);

    run(bindings, QuestionType.SingleAnswer);

    expect(lockedTexts(bindings)).toEqual([]);
  });
});

describe('force-disable is unaffected', () => {
  it('locks every option regardless of verdict or bank', () => {
    const bindings = makeBindings(['map']);

    const res = service.updateLockedIncorrectOptions({
      bindings,
      forceDisableAll: true,
      resolvedType: QuestionType.MultipleAnswer,
      computeShouldLockIncorrectOptions: computeShouldLock
    });

    expect(res.shouldLockIncorrectOptions).toBe(true);
    expect(lockedTexts(bindings)).toEqual(['Observable', 'Subject', 'filter', 'map']);
  });
});
