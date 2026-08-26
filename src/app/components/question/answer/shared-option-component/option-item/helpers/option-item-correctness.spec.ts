import { TestBed } from '@angular/core/testing';
import { firstValueFrom, Subject } from 'rxjs';

import {
  currentOptionCorrectness,
  hasAuthorizedCorrectSelection,
  isCurrentOptionCorrect
} from './option-item-correctness';
import { QuestionVerdictService } from '../../../../../../shared/services/features/verdict/question-verdict.service';
import { TOPIC_QUIZ_VERDICT_ADAPTER } from '../../../../../../shared/services/features/verdict/verdict-adapter';
import { setQuizDataCache } from '../../../../../../shared/quiz-data-cache';
import type { Quiz } from '../../../../../../shared/models/Quiz.model';
import type { OptionBindings } from '../../../../../../shared/models/OptionBindings.model';
import type { QuizService } from '../../../../../../shared/services/data/quiz.service';

/**
 * Per-option highlighting, sourced from QuestionVerdictService.
 *
 * THE INVARIANT UNDER TEST: while a multiple-answer question is incomplete,
 * a selected option may show its own verdict and an unselected option must
 * reveal nothing. Reading the bank directly would paint an unselected correct
 * option green before the user earned the reveal — and once the answer key
 * stops shipping to the browser there would be nothing to read.
 */

const MULTI = 'Select every operator';        // correct: map, filter
const SINGLE = 'Which answer is correct?';    // correct: A multicast observable

const BANK = [
  {
    quizId: 'rxjs',
    milestone: 'RxJS',
    questions: [
      {
        questionText: SINGLE,
        explanation: 'Because a Subject multicasts.',
        options: [
          { text: 'A multicast observable', correct: true },
          { text: 'A pipe' }
        ]
      },
      {
        questionText: MULTI,
        explanation: 'map and filter are operators.',
        options: [
          { text: 'map', correct: true },
          { text: 'filter', correct: true },
          { text: 'Observable' },
          { text: 'Subject' }
        ]
      }
    ]
  }
] as unknown as Quiz[];

let verdicts: QuestionVerdictService;

/** A QuizService stand-in exposing only what the helper reads. */
function quizServiceStub(questionText: string): QuizService {
  return {
    quizId: 'rxjs',
    getQuestionsInDisplayOrder: () => [{ questionText }],
    questions: [{ questionText }],
    isShuffleEnabled: () => false,
    shuffledQuestions: []
  } as unknown as QuizService;
}

/**
 * A binding whose option carries NO `correct` flag.
 *
 * Deliberate: if the helper ever falls back to the bank for an unselected
 * option on an incomplete question, these tests would still pass with a flag
 * present. Omitting it means the verdict service is the only possible source.
 */
function binding(text: string): OptionBindings {
  return { option: { text } } as unknown as OptionBindings;
}

const check = (questionText: string, selected: readonly string[]) =>
  firstValueFrom(verdicts.checkAnswer('rxjs', questionText, selected));

/**
 * A verdict service whose adapter never answers on its own.
 *
 * The local adapter resolves synchronously, so `checking` and `error` are
 * unreachable through it — and those two phases are exactly where the deleted
 * fallback used to run. This lets the test sit in them deliberately.
 */
function withPendingAdapter(): { verdicts: QuestionVerdictService; fail: () => void } {
  const pending = new Subject<never>();
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      QuestionVerdictService,
      {
        provide: TOPIC_QUIZ_VERDICT_ADAPTER,
        useValue: {
          check: () => pending.asObservable(),
          revealExpired: () => pending.asObservable()
        }
      }
    ]
  });
  return {
    verdicts: TestBed.inject(QuestionVerdictService),
    fail: () => pending.error(new Error('network down'))
  };
}

beforeEach(() => {
  setQuizDataCache(JSON.parse(JSON.stringify(BANK)) as Quiz[], []);
  TestBed.configureTestingModule({ providers: [QuestionVerdictService] });
  verdicts = TestBed.inject(QuestionVerdictService);
});
afterEach(() => setQuizDataCache([], []));

describe('multiple-answer, INCOMPLETE', () => {
  it('a SELECTED CORRECT option shows correct', async () => {
    await check(MULTI, ['map']);
    expect(isCurrentOptionCorrect(binding('map'), quizServiceStub(MULTI), 0, verdicts)).toBe(true);
  });

  it('a SELECTED INCORRECT option shows incorrect', async () => {
    await check(MULTI, ['Observable']);
    expect(isCurrentOptionCorrect(binding('Observable'), quizServiceStub(MULTI), 0, verdicts))
      .toBe(false);
  });

  it('an UNSELECTED CORRECT option reveals NOTHING', async () => {
    await check(MULTI, ['map']);

    // `filter` is correct, but the user has not selected it and the question
    // has not resolved. Returning true here would leak the answer key one
    // click at a time.
    expect(isCurrentOptionCorrect(binding('filter'), quizServiceStub(MULTI), 0, verdicts))
      .toBe(false);
  });

  it('an UNSELECTED INCORRECT option stays neutral', async () => {
    await check(MULTI, ['map']);
    expect(isCurrentOptionCorrect(binding('Subject'), quizServiceStub(MULTI), 0, verdicts))
      .toBe(false);
  });

  it('the local fallback CANNOT run for an unselected option while incomplete', async () => {
    await check(MULTI, ['map']);

    // A binding that positively asserts correctness both ways. If the fallback
    // were reachable it would return true; the incomplete guard returns first.
    const flagged = {
      option: { text: 'filter', correct: true },
      isCorrect: true
    } as unknown as OptionBindings;

    expect(isCurrentOptionCorrect(flagged, quizServiceStub(MULTI), 0, verdicts)).toBe(false);
  });
});

describe('multiple-answer, RESOLVED', () => {
  it('reveals every correct option, including ones never selected', async () => {
    // Superset rule: all correct selected, plus a wrong pick.
    await check(MULTI, ['map', 'filter', 'Observable']);
    const service = quizServiceStub(MULTI);

    expect(isCurrentOptionCorrect(binding('map'), service, 0, verdicts)).toBe(true);
    expect(isCurrentOptionCorrect(binding('filter'), service, 0, verdicts)).toBe(true);
    expect(isCurrentOptionCorrect(binding('Observable'), service, 0, verdicts)).toBe(false);
    // Never selected, never revealed until now.
    expect(isCurrentOptionCorrect(binding('Subject'), service, 0, verdicts)).toBe(false);
  });
});

describe('multiple-answer, EXPIRED', () => {
  it('reveals every correct option after a timer expiry', async () => {
    await firstValueFrom(verdicts.revealExpiredQuestion('rxjs', MULTI));
    const service = quizServiceStub(MULTI);

    expect(isCurrentOptionCorrect(binding('map'), service, 0, verdicts)).toBe(true);
    expect(isCurrentOptionCorrect(binding('filter'), service, 0, verdicts)).toBe(true);
    expect(isCurrentOptionCorrect(binding('Observable'), service, 0, verdicts)).toBe(false);
  });
});

describe('single-answer', () => {
  it('a correct pick resolves and shows correct', async () => {
    await check(SINGLE, ['A multicast observable']);
    const service = quizServiceStub(SINGLE);

    expect(isCurrentOptionCorrect(binding('A multicast observable'), service, 0, verdicts))
      .toBe(true);
    expect(isCurrentOptionCorrect(binding('A pipe'), service, 0, verdicts)).toBe(false);
  });

  it('a WRONG pick still resolves, and the correct option is then revealed', async () => {
    // Shipped behaviour: a single-answer question reveals on first click,
    // right or wrong.
    await check(SINGLE, ['A pipe']);
    const service = quizServiceStub(SINGLE);

    expect(isCurrentOptionCorrect(binding('A pipe'), service, 0, verdicts)).toBe(false);
    expect(isCurrentOptionCorrect(binding('A multicast observable'), service, 0, verdicts))
      .toBe(true);
  });
});

/**
 * The local `correct` flag is no longer consulted, in any phase.
 *
 * There used to be a fallback for `idle`/`checking`/`error` that read the
 * option's own flag. It existed for exactly one reason: the timeout reveal
 * painted before the server had authorized it, so something had to answer
 * during the gap. The signed-deadline work closed that gap — the reveal now
 * rides the `expired` verdict — and the fallback was deleted.
 *
 * Every fixture below carries a local flag that LIES. If the flag ever becomes
 * authoritative again, these fail.
 */
describe('local correct flags are never consulted', () => {
  const lyingTrue = () =>
    ({ option: { text: 'map', correct: true } }) as unknown as OptionBindings;

  it('stays neutral while idle, despite a local correct=true', () => {
    expect(isCurrentOptionCorrect(lyingTrue(), quizServiceStub(MULTI), 0, verdicts)).toBe(false);
  });

  it('stays neutral while checking, despite a local correct=true', () => {
    // A check in flight is not an answer. Painting from the local flag here is
    // what let an unearned reveal appear a round trip early.
    const { verdicts: v } = withPendingAdapter();
    v.checkAnswer('rxjs', MULTI, ['map']).subscribe({ error: () => undefined });

    expect(v.verdictFor('rxjs', MULTI).phase).toBe('checking');
    expect(isCurrentOptionCorrect(lyingTrue(), quizServiceStub(MULTI), 0, v)).toBe(false);
  });

  it('stays neutral after an error, despite a local correct=true', () => {
    const { verdicts: v, fail } = withPendingAdapter();
    v.checkAnswer('rxjs', MULTI, ['map']).subscribe({ error: () => undefined });
    fail();

    expect(v.verdictFor('rxjs', MULTI).phase).toBe('error');
    expect(isCurrentOptionCorrect(lyingTrue(), quizServiceStub(MULTI), 0, v)).toBe(false);
  });

  it('stays neutral when no verdict service is supplied at all', () => {
    expect(isCurrentOptionCorrect(lyingTrue(), quizServiceStub(MULTI), 0)).toBe(false);
  });

  it('works on options that have no `correct` property at all', async () => {
    // The shape the API actually returns. Nothing here can be counted or read
    // for correctness — the verdict is the only source.
    await check(MULTI, ['map', 'filter']);
    const bare = { option: { text: 'map' } } as unknown as OptionBindings;
    const bareWrong = { option: { text: 'Observable' } } as unknown as OptionBindings;

    expect(isCurrentOptionCorrect(bare, quizServiceStub(MULTI), 0, verdicts)).toBe(true);
    expect(isCurrentOptionCorrect(bareWrong, quizServiceStub(MULTI), 0, verdicts)).toBe(false);
  });
});

/**
 * THE SINGLE-ANSWER LOCK.
 *
 * "Has the user found the answer yet?" — the gate that greys out every other
 * option and ends the question. It used to be answered by matching the user's
 * selections against the bank's correct set, with a second fallback onto a
 * `correct` flag copied onto the selection record.
 *
 * Two properties matter and are asserted separately below, because getting
 * either wrong is a different bug:
 *
 *   TOO EARLY — locking before a correct pick is confirmed steals the user's
 *   remaining attempts, and locking on the bank's say-so does it a round trip
 *   before the server has agreed.
 *
 *   TOO MUCH — the question is about the user's OWN picks. An option nobody
 *   touched carries no verdict, so it can contribute nothing. That is what
 *   stops the lock from becoming a readout of the answer key.
 */
describe('the single-answer lock follows the verdict on the user own picks', () => {
  it('does not lock before anything has been selected', () => {
    expect(hasAuthorizedCorrectSelection(quizServiceStub(SINGLE), 0, verdicts)).toBe(false);
  });

  it('locks once a pick is confirmed correct', async () => {
    await check(SINGLE, ['A multicast observable']);
    expect(hasAuthorizedCorrectSelection(quizServiceStub(SINGLE), 0, verdicts)).toBe(true);
  });

  it('does NOT lock on a pick the verdict calls wrong', async () => {
    // The user must stay free to keep trying. Note the question DOES resolve on
    // a wrong single-answer pick, so "resolved" alone is not the lock signal —
    // a correct selection is.
    await check(SINGLE, ['A pipe']);

    expect(verdicts.verdictFor('rxjs', SINGLE).phase).toBe('resolved');
    expect(hasAuthorizedCorrectSelection(quizServiceStub(SINGLE), 0, verdicts)).toBe(false);
  });

  it('does not lock on the REVEALED correct option the user never picked', async () => {
    // After a wrong pick the correct option is revealed and paints green. The
    // lock must not read that reveal — only the user's own selections count,
    // and theirs was wrong.
    await check(SINGLE, ['A pipe']);

    expect(isCurrentOptionCorrect(binding('A multicast observable'), quizServiceStub(SINGLE), 0, verdicts))
      .toBe(true);
    expect(hasAuthorizedCorrectSelection(quizServiceStub(SINGLE), 0, verdicts)).toBe(false);
  });

  it('does not lock while a check is still in flight', () => {
    // The click has happened, the answer has not come back. Under the live API
    // adapter this is the state EVERY click-time reader sees, so a lock decided
    // here would be decided without authority.
    const { verdicts: v } = withPendingAdapter();
    v.checkAnswer('rxjs', SINGLE, ['A multicast observable']).subscribe({ error: () => undefined });

    expect(v.verdictFor('rxjs', SINGLE).phase).toBe('checking');
    expect(hasAuthorizedCorrectSelection(quizServiceStub(SINGLE), 0, v)).toBe(false);
  });

  it('does not lock after a failed check', () => {
    const { verdicts: v, fail } = withPendingAdapter();
    v.checkAnswer('rxjs', SINGLE, ['A multicast observable']).subscribe({ error: () => undefined });
    fail();

    expect(v.verdictFor('rxjs', SINGLE).phase).toBe('error');
    expect(hasAuthorizedCorrectSelection(quizServiceStub(SINGLE), 0, v)).toBe(false);
  });

  it('does not lock with no verdict service at all', () => {
    expect(hasAuthorizedCorrectSelection(quizServiceStub(SINGLE), 0)).toBe(false);
  });

  it('does not lock when the question cannot be identified', async () => {
    await check(SINGLE, ['A multicast observable']);

    // No question text at this index — the verdict cannot be looked up. Null is
    // "ask something else", never "locked".
    const unknownQuestion = {
      quizId: 'rxjs',
      getQuestionsInDisplayOrder: () => [],
      questions: [],
      isShuffleEnabled: () => false,
      shuffledQuestions: []
    } as unknown as QuizService;

    expect(hasAuthorizedCorrectSelection(unknownQuestion, 0, verdicts)).toBe(false);
  });

  it('locks a partially-correct multi-answer question, before it is complete', async () => {
    // Sanity boundary: this helper answers "is any pick correct", which is the
    // SINGLE-answer question. Multi-answer must not route through it — its lock
    // is authorized completion, not one correct pick. Pinned so a future caller
    // cannot quietly reuse it for multi and lock the question half-answered.
    await check(MULTI, ['map']);

    expect(verdicts.verdictFor('rxjs', MULTI).phase).toBe('incomplete');
    expect(hasAuthorizedCorrectSelection(quizServiceStub(MULTI), 0, verdicts)).toBe(true);
  });
});

/**
 * PENDING IS NEITHER CORRECT NOR INCORRECT.
 *
 * Clicking the CORRECT option made it flash red before turning green. It was
 * never a red->green repaint: a browser trace holding /check open showed the
 * option carrying correct-option AND incorrect-option together for the whole
 * pending window, with .incorrect-option winning on !important.
 *
 * The tests above pin the TWO-STATE view, which answers false while nothing is
 * authorized. That is right for "paint green or do not" and wrong for "paint
 * red": two callers in option-item negated it, so unknown became known-wrong.
 *
 * These pin the THREE-STATE view the painting branches now use. The
 * distinction only survives if the value carries it.
 */
describe(`pending correctness is UNDEFINED, not false`, () => {
  const bare = () => ({ option: { text: `map` } }) as unknown as OptionBindings;

  it(`is undefined while idle`, () => {
    expect(currentOptionCorrectness(bare(), quizServiceStub(MULTI), 0, verdicts))
      .toBeUndefined();
  });

  it(`is undefined while a check is still in flight`, () => {
    const { verdicts: v } = withPendingAdapter();
    v.checkAnswer(`rxjs`, MULTI, [`map`]).subscribe({ error: () => undefined });

    expect(v.verdictFor(`rxjs`, MULTI).phase).toBe(`checking`);
    // THE REGRESSION: false here painted the user own correct pick red for the
    // entire duration of the round trip.
    expect(currentOptionCorrectness(bare(), quizServiceStub(MULTI), 0, v)).toBeUndefined();
  });

  it(`is undefined after an error`, () => {
    const { verdicts: v, fail } = withPendingAdapter();
    v.checkAnswer(`rxjs`, MULTI, [`map`]).subscribe({ error: () => undefined });
    fail();

    expect(currentOptionCorrectness(bare(), quizServiceStub(MULTI), 0, v)).toBeUndefined();
  });

  it(`is undefined when no verdict service is supplied`, () => {
    expect(currentOptionCorrectness(bare(), quizServiceStub(MULTI), 0)).toBeUndefined();
  });

  it(`is TRUE once the server authorizes the player own pick`, async () => {
    await check(MULTI, [`map`]);
    expect(currentOptionCorrectness(bare(), quizServiceStub(MULTI), 0, verdicts)).toBe(true);
  });

  it(`is FALSE once the server calls the player own pick wrong`, async () => {
    await check(MULTI, [`Observable`]);
    const wrong = { option: { text: `Observable` } } as unknown as OptionBindings;
    expect(currentOptionCorrectness(wrong, quizServiceStub(MULTI), 0, verdicts)).toBe(false);
  });
});

describe(`the painting rule the option-item branches apply`, () => {
  // Mirrors both migrated branches exactly:
  //   correct-option:   correctness === true
  //   incorrect-option: wasSelected && correctness === false
  const paint = (correctness: boolean | undefined, wasSelected: boolean) => ({
    green: correctness === true,
    red: wasSelected && correctness === false
  });

  it(`paints NEITHER colour while the verdict is unknown`, () => {
    expect(paint(undefined, true)).toEqual({ green: false, red: false });
  });

  it(`paints green on an authorized correct verdict`, () => {
    expect(paint(true, true)).toEqual({ green: true, red: false });
  });

  it(`paints red only on an authorized wrong verdict for a SELECTED option`, () => {
    expect(paint(false, true)).toEqual({ green: false, red: true });
    expect(paint(false, false)).toEqual({ green: false, red: false });
  });

  it(`can never apply both classes at once, for any input`, () => {
    for (const c of [true, false, undefined]) {
      for (const sel of [true, false]) {
        const { green, red } = paint(c, sel);
        expect(green && red).toBe(false);
      }
    }
  });
});

/**
 * THE PAINT PATHS, NOT JUST THE CLASSES.
 *
 * 130eb7a1 fixed the two CSS-class branches and the live red flash SURVIVED,
 * because the visible colour comes from an inline [style.background-color]
 * binding that was still reading the two-state view. A frame-accurate trace of
 * the deployed site showed the row sweeping to #ff0000 by ~1691ms and reaching
 * green only at ~1908ms, with `incorrect-option` never applied at any point.
 *
 * Class-name assertions cannot catch that. These mirror the decision each paint
 * path now makes, so a regression in any of them fails here rather than in a
 * browser someone happens to be watching.
 */
describe('every paint path treats unknown as unknown', () => {
  const CORRECT_COLOR = `#43e756`;
  const INCORRECT_COLOR = `#ff0000`;

  /** option-item getOptionBackgroundColor, live branch. */
  const background = (correctness: boolean | undefined, wasSelected: boolean) => {
    if (correctness === true) return CORRECT_COLOR;
    return wasSelected && correctness === false ? INCORRECT_COLOR : null;
  };

  /** option-item getOptionIcon, feedback branch. */
  const icon = (correctness: boolean | undefined, fallback = '') => {
    if (correctness === true) return 'check';
    if (correctness === false) return 'close';
    return fallback;
  };

  /** option-item timerColor, expired-but-unrevealed branch. */
  const timerColour = (correctness: boolean | undefined, wasSelected: boolean) =>
    (wasSelected && correctness === false ? INCORRECT_COLOR : null);

  it('paints NO background while the verdict is pending, even on the click', () => {
    expect(background(undefined, true)).toBeNull();
  });

  it('shows NO verdict icon while pending — not the cross', () => {
    expect(icon(undefined)).toBe('');
  });

  it('leaves the timer-expiry colour alone until the reveal arrives', () => {
    expect(timerColour(undefined, true)).toBeNull();
  });

  it('paints green once the verdict authorizes correct', () => {
    expect(background(true, true)).toBe(CORRECT_COLOR);
    expect(icon(true)).toBe('check');
  });

  it('paints red once the verdict authorizes wrong, for the player OWN pick', () => {
    expect(background(false, true)).toBe(INCORRECT_COLOR);
    expect(icon(false)).toBe('close');
    expect(timerColour(false, true)).toBe(INCORRECT_COLOR);
  });

  it('never paints red on an option the player did not select', () => {
    expect(background(false, false)).toBeNull();
    expect(timerColour(false, false)).toBeNull();
  });

  it('never yields red for ANY pending input, selected or not', () => {
    for (const sel of [true, false]) {
      expect(background(undefined, sel)).not.toBe(INCORRECT_COLOR);
      expect(timerColour(undefined, sel)).not.toBe(INCORRECT_COLOR);
    }
    expect(icon(undefined)).not.toBe('close');
  });
});
