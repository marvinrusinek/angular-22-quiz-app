import { TestBed } from '@angular/core/testing';
import { firstValueFrom, Subject } from 'rxjs';

import { hasAuthorizedCorrectSelection, isCurrentOptionCorrect } from './option-item-correctness';
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
