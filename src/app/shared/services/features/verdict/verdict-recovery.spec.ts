import { TestBed } from '@angular/core/testing';
import { NEVER, Observable, Subject } from 'rxjs';

import { QuizService } from '@shared/services/data/quiz.service';
import { SelectedOptionService } from '@shared/services/state/selectedoption.service';
import { QuestionVerdictService, VERDICT_CHECK_TIMEOUT_MS } from './question-verdict.service';
import { QuestionVerdictError, type QuestionCheckResult } from './question-verdict.types';
import { TOPIC_QUIZ_VERDICT_ADAPTER } from './verdict-adapter';

/**
 * RECOVERY from a failed or timed-out `/check`.
 *
 * A failed check is never a verdict: nothing is scored, nothing advances, and
 * Results stays unavailable. But that used to be a silent dead end — the question
 * stayed in `error`/`checking` with no message, no timeout and no way to resend
 * an UNCHANGED selection (selection de-duplication ignores it). These pin the
 * recovery contract; the fail-closed guarantees stay exactly as they were.
 */

const QUIZ = 'rxjs';
const SINGLE = 'Which is correct?';
const MULTI = 'Select every operator';
const QUESTIONS = [{ questionText: SINGLE }, { questionText: MULTI }];

const RESOLVED_WRONG: QuestionCheckResult = {
  status: 'resolved', correct: false, correctOptionTexts: ['b'], explanation: 'e'
} as QuestionCheckResult;
const RESOLVED_RIGHT: QuestionCheckResult = {
  status: 'resolved', correct: true, correctOptionTexts: ['a'], explanation: 'e'
} as QuestionCheckResult;

/** Each adapter call is a Subject the test settles by hand. */
let calls: { texts: readonly string[]; subject: Subject<QuestionCheckResult>; unsubscribed: boolean }[];
let verdicts: QuestionVerdictService;
let selected: SelectedOptionService;
let credit: jest.Mock;

beforeEach(() => {
  // SelectedOptionService reads performance.getEntriesByType at construction; jsdom has none.
  const perf = performance as unknown as { getEntriesByType?: () => unknown[] };
  perf.getEntriesByType ??= () => [];
  jest.useFakeTimers();
  calls = [];
  credit = jest.fn();
  const adapter = {
    check: (_quiz: string, _q: string, texts: readonly string[]): Observable<QuestionCheckResult> =>
      new Observable<QuestionCheckResult>((subscriber) => {
        const entry = { texts, subject: new Subject<QuestionCheckResult>(), unsubscribed: false };
        calls.push(entry);
        const inner = entry.subject.subscribe(subscriber);
        return () => { entry.unsubscribed = true; inner.unsubscribe(); };
      }),
    revealExpired: jest.fn()
  };
  TestBed.resetTestingModule();
  sessionStorage.clear();
  TestBed.configureTestingModule({
    providers: [
      { provide: TOPIC_QUIZ_VERDICT_ADAPTER, useValue: adapter },
      {
        provide: QuizService,
        useValue: {
          quizId: QUIZ,
          quizReset$: NEVER,
          getQuestionsInDisplayOrder: () => QUESTIONS,
          isShuffleEnabled: () => false,
          scoringService: { creditResolvedQuestion: credit }
        }
      }
    ]
  });
  verdicts = TestBed.inject(QuestionVerdictService);
  selected = TestBed.inject(SelectedOptionService);
});

afterEach(() => jest.useRealTimers());

const phase = (q: string) => verdicts.verdictFor(QUIZ, q).phase;
const send = (q: string, texts: string[]) =>
  verdicts.checkAnswer(QUIZ, q, texts).subscribe({ error: () => undefined });
const fail = (i: number) => calls[i]!.subject.error(new Error('network'));

describe('a failed check is recoverable and stays fail-closed', () => {
  it('1. a network failure enters `error`: no verdict, no credit, Results stays blocked', () => {
    send(SINGLE, ['a']);
    fail(0);

    expect(phase(SINGLE)).toBe('error');
    expect(verdicts.hasFailedVerdicts(QUIZ)).toBe(true);
    expect(verdicts.hasBlockingVerdicts(QUIZ)).toBe(true);
    expect(credit).not.toHaveBeenCalled();
    expect(verdicts.verdictFor(QUIZ, SINGLE).isResolvedCorrect).toBeFalsy();
  });

  it('2. a check that never answers times out into the SAME `error` state, and is cancelled', () => {
    send(SINGLE, ['a']);
    expect(phase(SINGLE)).toBe('checking');
    expect(verdicts.hasBlockingVerdicts(QUIZ)).toBe(true);

    jest.advanceTimersByTime(VERDICT_CHECK_TIMEOUT_MS - 1);
    expect(phase(SINGLE)).toBe('checking');             // still within the bound

    jest.advanceTimersByTime(1);
    expect(phase(SINGLE)).toBe('error');
    expect(verdicts.hasFailedVerdicts(QUIZ)).toBe(true);
    expect(calls[0]!.unsubscribed).toBe(true);          // the request was cancelled
  });

  it('3. a late answer from the timed-out request cannot land (it was cancelled)', () => {
    send(SINGLE, ['a']);
    jest.advanceTimersByTime(VERDICT_CHECK_TIMEOUT_MS);
    calls[0]!.subject.next(RESOLVED_RIGHT);

    expect(phase(SINGLE)).toBe('error');                // not overwritten by the late "resolved"
    expect(verdicts.verdictFor(QUIZ, SINGLE).isResolvedCorrect).toBeFalsy();
  });

  it('4. a stale response cannot overwrite a newer verdict', () => {
    send(MULTI, ['a']);                                 // request 0 (older)
    send(MULTI, ['a', 'b']);                            // request 1 (newer, supersedes)
    calls[1]!.subject.next(RESOLVED_RIGHT);
    expect(phase(MULTI)).toBe('resolved');

    calls[0]!.subject.error(new Error('late failure')); // the older one fails LAST
    expect(phase(MULTI)).toBe('resolved');              // still the newer verdict
  });
});

describe('retryVerdict — resend the UNCHANGED selection', () => {
  it('5. retries an unchanged SINGLE-answer selection with a NEW request', () => {
    send(SINGLE, ['a']);
    fail(0);

    expect(selected.retryVerdict(0)).toBe(true);

    expect(calls).toHaveLength(2);
    expect(calls[1]!.texts).toEqual(['a']);             // the same selection, resent
    expect(phase(SINGLE)).toBe('checking');
  });

  it('6. retries an unchanged MULTIPLE-answer selection with all its picks', () => {
    send(MULTI, ['a', 'b']);
    fail(0);

    expect(selected.retryVerdict(1)).toBe(true);

    expect(calls[1]!.texts).toEqual(['a', 'b']);
  });

  it('7. a successful retry clears the error, unblocks Results and credits through the normal path', () => {
    send(SINGLE, ['a']);
    fail(0);
    expect(verdicts.hasBlockingVerdicts(QUIZ)).toBe(true);

    selected.retryVerdict(0);
    calls[1]!.subject.next(RESOLVED_RIGHT);

    expect(phase(SINGLE)).toBe('resolved');
    expect(verdicts.hasFailedVerdicts(QUIZ)).toBe(false);
    expect(verdicts.hasBlockingVerdicts(QUIZ)).toBe(false);
    expect(credit).toHaveBeenCalledWith(QUIZ, SINGLE);  // credited on arrival, once
  });

  it('7b. a successful retry that resolves WRONG earns no credit (the SERVICE-level backstop only tracks checking/error)', () => {
    send(SINGLE, ['b']);
    fail(0);
    selected.retryVerdict(0);
    calls[1]!.subject.next(RESOLVED_WRONG);

    expect(phase(SINGLE)).toBe('resolved');
    expect(verdicts.hasBlockingVerdicts(QUIZ)).toBe(false);
    expect(credit).not.toHaveBeenCalled();
  });

  it('8. a failed retry stays recoverable, and can be retried again', () => {
    send(SINGLE, ['a']);
    fail(0);
    selected.retryVerdict(0);
    fail(1);

    expect(phase(SINGLE)).toBe('error');
    expect(verdicts.hasBlockingVerdicts(QUIZ)).toBe(true);
    expect(selected.retryVerdict(0)).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('9. rapid retry cannot create concurrent requests', () => {
    send(SINGLE, ['a']);
    fail(0);

    expect(selected.retryVerdict(0)).toBe(true);
    expect(selected.retryVerdict(0)).toBe(false);       // already checking
    expect(selected.retryVerdict(0)).toBe(false);

    expect(calls).toHaveLength(2);                      // original + ONE retry
  });

  it('10. retry does nothing unless the check actually failed (no phantom requests)', () => {
    expect(selected.retryVerdict(0)).toBe(false);       // idle
    send(SINGLE, ['a']);
    expect(selected.retryVerdict(0)).toBe(false);       // checking
    calls[0]!.subject.next(RESOLVED_RIGHT);
    expect(selected.retryVerdict(0)).toBe(false);       // resolved

    expect(calls).toHaveLength(1);
  });

  it('11. the Results gate stays closed for the whole recovery, on the last question too', () => {
    send(MULTI, ['a', 'b']);                            // pretend this is the last question
    fail(0);
    expect(verdicts.hasBlockingVerdicts(QUIZ)).toBe(true);

    selected.retryVerdict(1);
    expect(verdicts.hasBlockingVerdicts(QUIZ)).toBe(true);   // pending: still closed

    calls[1]!.subject.next(RESOLVED_RIGHT);
    expect(verdicts.hasBlockingVerdicts(QUIZ)).toBe(false);  // proven: open
  });
});

describe('recovery introduces no client-side correctness', () => {
  it('12. an errored question holds no correct set, no explanation and no resolved flag', () => {
    send(SINGLE, ['a']);
    fail(0);

    const state = verdicts.verdictFor(QUIZ, SINGLE);
    expect(state.phase).toBe('error');
    expect(state.correctOptionTexts).toEqual([]);
    expect(state.explanation).toBeFalsy();
    expect(state.isResolvedCorrect).toBeFalsy();
  });

  it('a failed check surfaces the coarse domain error only', () => {
    let seen: unknown;
    verdicts.checkAnswer(QUIZ, SINGLE, ['a']).subscribe({ error: (e) => (seen = e) });
    fail(0);
    expect(seen).toBeInstanceOf(QuestionVerdictError);
  });
});
