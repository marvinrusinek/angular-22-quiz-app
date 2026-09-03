import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';
import { readFileSync } from 'fs';
import { join } from 'path';

import { API_BASE_URL } from '../../../tokens/api-base-url.token';
import { QuestionTimingService } from './question-timing.service';
import { QuestionVerdictService } from '../verdict/question-verdict.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { TimerService } from './timer.service';
import { TopicQuizAttemptService } from '../verdict/topic-quiz-attempt.service';
import { QuizService } from '../../data/quiz.service';

/**
 * The signed question deadline is the ONLY timing authority for a Topic Quiz.
 *
 * The bug these tests exist to keep dead: the client started a local 30-second
 * countdown the moment a question rendered, but the receipt that authorizes a
 * timeout reveal was minted lazily on the first `/check` — which, for an
 * unanswered question, IS the timeout reveal. The server's 30-second window
 * therefore opened as the client's closed. The reveal arrived ~30 seconds
 * before its own deadline, the backend answered `incomplete`, and the correct
 * options and explanation never painted.
 *
 * So the invariant under test is ordering, not duration:
 *
 *     no countdown may start before a signed deadline exists to count to.
 *
 * A revisit is the mirror image: it must NOT buy more time. The receipt is
 * cached by question text and the deadline travels with it, so leaving a
 * question and coming back resumes rather than restarts.
 */

const BASE = 'https://api.test/api';
const QUIZ = 'rxjs';
const Q1 = 'Which operator maps values?';
const Q2 = 'Select every operator';

const url = {
  attempts: `${BASE}/quizzes/${QUIZ}/attempts`,
  start: `${BASE}/quizzes/${QUIZ}/questions/start`,
  check: `${BASE}/quizzes/${QUIZ}/check`
};

// jsdom has no structuredClone; QuizService uses it at construction.
if (typeof (globalThis as any).structuredClone !== 'function') {
  (globalThis as any).structuredClone = (value: unknown) => JSON.parse(JSON.stringify(value));
}

let http: HttpTestingController;
let attempts: TopicQuizAttemptService;
let timerService: TimerService;
let timing: QuestionTimingService;
let selectedOptionService: SelectedOptionService;
let quizService: QuizService;
let verdicts: QuestionVerdictService;

/** Controllable wall clock — the deadline is expressed in these milliseconds. */
let clock = 1_000_000;
const advance = (ms: number) => { clock += ms; };

beforeEach(() => {
  clock = 1_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => clock);

  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: API_BASE_URL, useValue: BASE },
      { provide: ActivatedRoute, useValue: { params: of({}), snapshot: { paramMap: new Map() } } }
    ]
  });

  http = TestBed.inject(HttpTestingController);
  attempts = TestBed.inject(TopicQuizAttemptService);
  timerService = TestBed.inject(TimerService);
  timing = TestBed.inject(QuestionTimingService);
  selectedOptionService = TestBed.inject(SelectedOptionService);
  quizService = TestBed.inject(QuizService);
  verdicts = TestBed.inject(QuestionVerdictService);

  // Minimal question data so `TimerService#hasRecordedCorrectCompletion`
  // (index -> questionText -> verdict) can resolve — this file otherwise
  // drives TimerService/QuestionTimingService in isolation, with no real
  // quiz session loaded.
  quizService.quizId = QUIZ;
  (quizService as any).questions = [{ questionText: Q1 }, { questionText: Q2 }];
});

afterEach(() => {
  http.verify();
  jest.restoreAllMocks();
});

/** Settle the attempt + question-start round trip, granting a 30s window. */
function grantDeadline(questionText: string, receipt = 'q-receipt'): void {
  http.expectOne({ method: 'POST', url: url.attempts })
    .flush({ quizId: QUIZ, attemptReceipt: 'attempt-receipt', startedAt: 1, expiresAt: 30_001 });

  const start = http.expectOne({ method: 'POST', url: url.start });
  expect(start.request.body).toEqual({ questionText });
  // Server clock is deliberately nothing like the local clock: only the
  // DURATION crosses the wire meaningfully.
  start.flush({
    quizId: QUIZ, questionText, durationSeconds: 30,
    startedAt: 1, expiresAt: 30_001, questionReceipt: receipt
  });
}

/** Settle only the question-start leg (the attempt already exists). */
function grantSecondDeadline(questionText: string, receipt = 'q2-receipt'): void {
  const start = http.expectOne({ method: 'POST', url: url.start });
  expect(start.request.body).toEqual({ questionText });
  start.flush({
    quizId: QUIZ, questionText, durationSeconds: 30,
    startedAt: 1, expiresAt: 30_001, questionReceipt: receipt
  });
}

/**
 * Stamp a GENUINE, terminal "resolved correct" verdict directly — the same
 * authority `TimerService#hasRecordedCorrectCompletion` reads (via
 * `allCorrectSelectedFromVerdict`). Bypasses `write`'s private visibility the
 * same way the rest of this file drives TimerService's own public surface
 * directly rather than exercising the full click -> /check round trip.
 */
function markResolvedCorrect(quizId: string, questionText: string): void {
  (verdicts as any).write(quizId, questionText, {
    phase: 'resolved',
    selectedOptionTexts: [],
    selectedVerdicts: new Map<string, boolean>(),
    remainingCorrectCount: 0,
    correctOptionTexts: [],
    explanation: null,
    isResolvedCorrect: true
  });
}

describe('a question is not timed until the server says when it ends', () => {
  it('asks for exactly one signed window on first activation', () => {
    timing.activateQuestionTiming(QUIZ, Q1, 0);
    grantDeadline(Q1);

    expect(timerService.hasAuthorizedDeadline(0)).toBe(true);
  });

  it('runs no countdown while the receipt is still in flight', () => {
    timing.activateQuestionTiming(QUIZ, Q1, 0);

    expect(timerService.isTimerRunning).toBe(false);
    expect(timerService.hasAuthorizedDeadline(0)).toBe(false);

    grantDeadline(Q1);
    expect(timerService.isTimerRunning).toBe(true);
  });

  it('refuses to start a question that has no authorized deadline', () => {
    timerService.restartForQuestion(0);

    expect(timerService.isTimerRunning).toBe(false);
  });

  it('starts counting toward the deadline once it arrives', () => {
    timing.activateQuestionTiming(QUIZ, Q1, 0);
    grantDeadline(Q1);

    expect(timerService.isTimerRunning).toBe(true);
    // A full window: nothing has been spent yet.
    expect(timerService.elapsedTimeSig()).toBe(0);
  });
});

describe('timing metadata is safe to hand out', () => {
  it('reports the deadline and nothing else', () => {
    let seen: unknown = null;
    attempts.startQuestion(QUIZ, Q1).subscribe((t) => (seen = t));
    grantDeadline(Q1, 'super-secret-receipt');

    expect(Object.keys(seen as object)).toEqual(['deadlineMs']);
  });

  it('never exposes the receipt to the caller', () => {
    let seen: unknown = null;
    attempts.startQuestion(QUIZ, Q1).subscribe((t) => (seen = t));
    grantDeadline(Q1, 'super-secret-receipt');

    expect(JSON.stringify(seen)).not.toContain('super-secret-receipt');
  });

  it('still attaches the receipt to the request that needs it', () => {
    let sent: Record<string, string> | null = null;
    attempts
      .withQuestionReceipt(QUIZ, Q1, (headers) => { sent = headers; return of('done'); })
      .subscribe();
    grantDeadline(Q1, 'super-secret-receipt');

    expect(sent).toEqual({ 'X-Question-Receipt': 'super-secret-receipt' });
  });

  it('expresses the deadline on the LOCAL clock, so clock skew cannot shorten it', () => {
    let deadlineMs = 0;
    attempts.startQuestion(QUIZ, Q1).subscribe((t) => (deadlineMs = t.deadlineMs));
    // Server timestamps say the window opened at epoch 1ms; the local clock is
    // a million milliseconds elsewhere. Trusting the server's absolute numbers
    // would make this question expire in the distant past.
    grantDeadline(Q1);

    expect(deadlineMs).toBe(clock + 30_000);
  });
});

describe('coming back to a question does not buy more time', () => {
  it('reuses the original window instead of asking for a new one', () => {
    timing.activateQuestionTiming(QUIZ, Q1, 0);
    grantDeadline(Q1);
    const deadline = clock + 30_000;

    // Leave for the next question, then come back.
    advance(10_000);
    timing.activateQuestionTiming(QUIZ, Q2, 1);
    grantSecondDeadline(Q2);
    timing.activateQuestionTiming(QUIZ, Q1, 0);

    // No second /questions/start for Q1 — http.verify() in afterEach proves it.
    expect(timerService.hasAuthorizedDeadline(0)).toBe(true);
    // 10 of the 30 seconds are already gone, and the timer resumes there.
    expect(timerService.elapsedTimeSig()).toBe(10);
    expect(deadline - clock).toBe(20_000);
  });

  it('does not restart a correctly-answered question, and asks the server nothing', () => {
    // A GENUINE, terminal verdict — the only thing
    // `hasRecordedCorrectCompletion` trusts (see its own doc comment).
    markResolvedCorrect(QUIZ, Q1);

    timing.activateQuestionTiming(QUIZ, Q1, 0);

    // No attempt, no start: http.verify() would fail if either were issued.
    expect(timerService.isTimerRunning).toBe(false);
  });

  it('does NOT freeze a question whose dot merely reads "correct" from the last click — only a genuine verdict completion counts', () => {
    // THE REGRESSION THIS PINS: a multi-answer question with only ONE (of
    // several required) correct options picked before it expired. The dot
    // status reads 'correct' — `clickConfirmedDotStatus` records whether the
    // option the user JUST CLICKED was correct, not whether the question is
    // finished — but no terminal "resolved correct" verdict was ever
    // recorded, because the question was never actually completed. This
    // must NOT freeze; it must go through the ordinary deadline-aware path
    // and ask the server for a real window.
    selectedOptionService.clickConfirmedDotStatus.set(0, 'correct');

    timing.activateQuestionTiming(QUIZ, Q1, 0);
    grantDeadline(Q1);

    expect(timerService.isTimerRunning).toBe(true);
  });

  it('treats a question returned to after its deadline as already expired', () => {
    timing.activateQuestionTiming(QUIZ, Q1, 0);
    grantDeadline(Q1);

    timing.activateQuestionTiming(QUIZ, Q2, 1);
    grantSecondDeadline(Q2);

    advance(31_000);
    timing.activateQuestionTiming(QUIZ, Q1, 0);

    expect(timerService.isTimerRunning).toBe(false);
    expect(timerService.elapsedTimeSig()).toBe(timerService.timePerQuestion);
  });

  it('a PARTIAL multi-answer pick that expired resolves to durably expired on revisit, not a fresh countdown', () => {
    // THE ROUND-3 REGRESSION, at the layer `restartForQuestion` (called
    // directly by quiz-navigation.service.ts / quiz-setup-route.service.ts
    // on every Next/Previous) actually runs at. The user picked ONE of
    // several required correct options on Q1 before it expired — the dot
    // status reads 'correct' for that single click, but the question was
    // never completed, so no terminal "resolved correct" verdict exists.
    timing.activateQuestionTiming(QUIZ, Q1, 0);
    grantDeadline(Q1);
    selectedOptionService.clickConfirmedDotStatus.set(0, 'correct'); // the one correct pick

    // The deadline passes with the question still incomplete.
    advance(31_000);

    // Leave for Q2 (a normal navigation elsewhere resets/starts Q2's own
    // timer) and come back — the exact Next -> Previous round trip.
    timing.activateQuestionTiming(QUIZ, Q2, 1);
    grantSecondDeadline(Q2);

    timerService.restartForQuestion(0);

    // Durably expired — 0:00, not a fresh ~30s countdown, and not merely
    // "left however it was" (frozen at nothing, still showing Q2's countdown).
    expect(timerService.isTimerRunning).toBe(false);
    expect(timerService.elapsedTimeSig()).toBe(timerService.timePerQuestion);
  });
});

describe('identity of a window', () => {
  it('gives a different question its own window', () => {
    timing.activateQuestionTiming(QUIZ, Q1, 0);
    grantDeadline(Q1);

    timing.activateQuestionTiming(QUIZ, Q2, 1);
    grantSecondDeadline(Q2);

    expect(timerService.hasAuthorizedDeadline(1)).toBe(true);
  });

  it('follows question TEXT, not position, so shuffling cannot swap windows', () => {
    // Same question, in a display slot that has nothing to do with its
    // position in the bank — as happens under shuffle.
    timing.activateQuestionTiming(QUIZ, Q1, 4);
    grantDeadline(Q1);

    timing.activateQuestionTiming(QUIZ, Q2, 7);
    grantSecondDeadline(Q2);

    advance(5_000);
    timing.activateQuestionTiming(QUIZ, Q1, 4);

    // Still one window (verify() enforces it), and still the original one.
    expect(timerService.elapsedTimeSig()).toBe(5);
  });

  it('mints once however many times the same question activates', () => {
    timing.activateQuestionTiming(QUIZ, Q1, 0);
    timing.activateQuestionTiming(QUIZ, Q1, 0);
    timing.activateQuestionTiming(QUIZ, Q1, 0);

    grantDeadline(Q1);

    expect(timerService.isTimerRunning).toBe(true);
  });

  it('drops everything when the quiz changes', () => {
    timing.activateQuestionTiming(QUIZ, Q1, 0);
    grantDeadline(Q1);

    timing.activateQuestionTiming('signals', Q1, 0);

    http.expectOne({ method: 'POST', url: `${BASE}/quizzes/signals/attempts` })
      .flush({ quizId: 'signals', attemptReceipt: 'a2', startedAt: 1, expiresAt: 30_001 });
    http.expectOne({ method: 'POST', url: `${BASE}/quizzes/signals/questions/start` })
      .flush({
        quizId: 'signals', questionText: Q1, durationSeconds: 30,
        startedAt: 1, expiresAt: 30_001, questionReceipt: 'r2'
      });

    expect(timerService.hasAuthorizedDeadline(0)).toBe(true);
  });

  it('starts a genuinely new window after a restart', () => {
    timing.activateQuestionTiming(QUIZ, Q1, 0);
    grantDeadline(Q1);

    advance(20_000);
    timing.clearTiming();

    expect(timerService.hasAuthorizedDeadline(0)).toBe(false);

    timing.activateQuestionTiming(QUIZ, Q1, 0);
    // A restart is a new attempt, so both legs are requested again — exactly
    // once each, which is what makes this a fresh window rather than a second
    // authority racing the old one.
    grantDeadline(Q1, 'restarted-receipt');

    expect(timerService.elapsedTimeSig()).toBe(0);
  });
});

describe('a new run does not inherit the previous run', () => {
  /**
   * THE CROSS-QUIZ LEAK.
   *
   * TimerService is provided at the root, so it outlives the QuizComponent
   * that a quiz switch destroys and recreates. Everything it remembers is
   * keyed by QUESTION INDEX — and Quiz B's first question is index 0 exactly
   * as Quiz A's was. Leaving Quiz A on an expired question therefore left
   * `hasExpiredForRun` set and `elapsedTimeSig` at the full duration, and
   * every guard in `restartForQuestion` and `startTimer` reads exactly those
   * fields. They refused to start Quiz B's question 1: it painted a permanent
   * red 0:00, and the heading — which treats
   * `expiredForQuestionIndexSig === idx` as "timed out" — rendered QUIZ A's
   * correct answer and explanation over it.
   *
   * The circularity is the defect: the only code that cleared the stale flags
   * was gated behind guards that read those same stale flags.
   *
   * These assert the run BOUNDARY, not merely that a deadline was recorded.
   * A deadline WAS recorded throughout the live defect — the countdown just
   * never started against it, which is why an existing
   * `hasAuthorizedDeadline` assertion stayed green the whole time.
   */
  const OTHER = 'signals';

  /** Quiz identity, as the route layer supplies it. */
  const useQuiz = (id: string): void => { quizService.quizId = id; };

  /** Settles both legs for a quiz other than QUIZ. */
  function grantDeadlineFor(quizId: string, questionText: string): void {
    http.expectOne({ method: 'POST', url: `${BASE}/quizzes/${quizId}/attempts` })
      .flush({ quizId, attemptReceipt: 'a2', startedAt: 1, expiresAt: 30_001 });
    http.expectOne({ method: 'POST', url: `${BASE}/quizzes/${quizId}/questions/start` })
      .flush({
        quizId, questionText, durationSeconds: 30,
        startedAt: 1, expiresAt: 30_001, questionReceipt: 'r2'
      });
  }

  /**
   * Quiz A, question 1, left EXPIRED — via question 2, because returning
   * straight to a question that is still the running one is refused by
   * design (that guard is what keeps a re-emitted payload from restarting
   * an answered question's clock).
   */
  function leaveQuizAExpired(): void {
    useQuiz(QUIZ);
    timing.activateQuestionTiming(QUIZ, Q1, 0);
    grantDeadline(Q1);
    timing.activateQuestionTiming(QUIZ, Q2, 1);
    grantSecondDeadline(Q2);

    advance(31_000);
    timing.activateQuestionTiming(QUIZ, Q1, 0);
  }

  it('starts the next quiz at zero after the previous one EXPIRED', () => {
    leaveQuizAExpired();
    expect(timerService.elapsedTimeSig()).toBe(timerService.timePerQuestion);
    expect(timerService.expiredForQuestionIndexSig()).toBe(0);

    // Switch quizzes. Same question INDEX, different quiz.
    useQuiz(OTHER);
    timing.activateQuestionTiming(OTHER, Q1, 0);
    grantDeadlineFor(OTHER, Q1);

    // The countdown runs, from the top — not frozen at the full duration,
    // which is what rendered as a permanent 0:00.
    expect(timerService.elapsedTimeSig()).toBe(0);
    expect(timerService.isTimerRunning).toBe(true);

    // ...and nothing still claims question 0 timed out, which is what put
    // Quiz A's correct answer on Quiz B's heading.
    expect(timerService.expiredForQuestionIndexSig()).toBe(-1);
    expect(timerService.expiredOnArrivalSig()).toBe(-1);
  });

  it('does not let the previous quiz\'s deadlines authorize anything', () => {
    useQuiz(QUIZ);
    timing.activateQuestionTiming(QUIZ, Q1, 0);
    grantDeadline(Q1);
    timing.activateQuestionTiming(QUIZ, Q2, 1);
    grantSecondDeadline(Q2);

    expect(timerService.hasAuthorizedDeadline(1)).toBe(true);

    useQuiz(OTHER);
    timing.activateQuestionTiming(OTHER, Q1, 0);
    grantDeadlineFor(OTHER, Q1);

    // Index 1 belongs to a quiz that is no longer running. A signed window is
    // for one question of one attempt; an index is not a question.
    expect(timerService.hasAuthorizedDeadline(1)).toBe(false);
    expect(timerService.hasAuthorizedDeadline(0)).toBe(true);
  });

  it('does not carry the previous quiz\'s recorded times into the freeze', () => {
    useQuiz(QUIZ);
    timing.activateQuestionTiming(QUIZ, Q1, 0);
    grantDeadline(Q1);
    timing.activateQuestionTiming(QUIZ, Q2, 1);
    grantSecondDeadline(Q2);

    advance(5_000);
    timing.activateQuestionTiming(QUIZ, Q1, 0);
    timerService.recordElapsedForAnsweredQuestion(0);
    expect(timerService.elapsedTimes[0]).toBe(5);

    useQuiz(OTHER);
    timing.activateQuestionTiming(OTHER, Q1, 0);
    grantDeadlineFor(OTHER, Q1);

    // `freezeAtRecordedTime` reads elapsedTimes[index]; Quiz A's value would
    // otherwise paint Quiz B's question 1 with a time it never took.
    expect(timerService.elapsedTimes[0]).toBeUndefined();
  });

  it('CONTROL: moving within ONE quiz starts no new run', () => {
    useQuiz(QUIZ);
    timing.activateQuestionTiming(QUIZ, Q1, 0);
    grantDeadline(Q1);
    timing.activateQuestionTiming(QUIZ, Q2, 1);
    grantSecondDeadline(Q2);

    advance(5_000);
    timing.activateQuestionTiming(QUIZ, Q1, 0);

    // Both windows survive and the revisit RESUMES its own — a new run here
    // would have discarded question 2's deadline and restarted question 1
    // from zero, buying time the server never granted.
    expect(timerService.elapsedTimeSig()).toBe(5);
    expect(timerService.hasAuthorizedDeadline(0)).toBe(true);
    expect(timerService.hasAuthorizedDeadline(1)).toBe(true);
  });

  it('releases the guards for a RESTART, where the quiz id cannot change', () => {
    leaveQuizAExpired();
    expect(timerService.elapsedTimeSig()).toBe(timerService.timePerQuestion);

    // Restarting is a new run at the SAME quiz, so identity proves nothing
    // and the timer has to be told explicitly.
    timerService.beginNewRun();
    timing.clearTiming();

    expect(timerService.expiredForQuestionIndexSig()).toBe(-1);
    expect(timerService.hasAuthorizedDeadline(0)).toBe(false);

    timing.activateQuestionTiming(QUIZ, Q1, 0);
    grantDeadline(Q1, 'restarted-receipt');

    expect(timerService.elapsedTimeSig()).toBe(0);
    expect(timerService.isTimerRunning).toBe(true);
  });
});

describe('when the server will not authorize a window', () => {
  it('leaves the timer stopped rather than inventing a local one', () => {
    timing.activateQuestionTiming(QUIZ, Q1, 0);

    http.expectOne({ method: 'POST', url: url.attempts })
      .flush({ quizId: QUIZ, attemptReceipt: 'attempt-receipt', startedAt: 1, expiresAt: 30_001 });
    http.expectOne({ method: 'POST', url: url.start })
      .flush({ error: 'nope' }, { status: 500, statusText: 'Server Error' });

    expect(timerService.isTimerRunning).toBe(false);
    expect(timerService.hasAuthorizedDeadline(0)).toBe(false);
  });
});

describe('no production path starts an unsigned Topic Quiz countdown', () => {
  const read = (rel: string) =>
    readFileSync(join(__dirname, '..', '..', rel), 'utf8');

  it.each([
    ['flow/quiz-setup-route.service.ts'],
    ['flow/quiz-reset.service.ts'],
    ['features/qqc/qqc-ql-stream.service.ts']
  ])('%s no longer starts a timer itself', (rel) => {
    expect(read(rel)).not.toContain('timerService.startTimer(');
  });
});
