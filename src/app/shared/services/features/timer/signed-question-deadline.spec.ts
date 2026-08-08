import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';
import { readFileSync } from 'fs';
import { join } from 'path';

import { API_BASE_URL } from '../../../tokens/api-base-url.token';
import { QuestionTimingService } from './question-timing.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { TimerService } from './timer.service';
import { TopicQuizAttemptService } from '../verdict/topic-quiz-attempt.service';

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
    selectedOptionService.clickConfirmedDotStatus.set(0, 'correct');

    timing.activateQuestionTiming(QUIZ, Q1, 0);

    // No attempt, no start: http.verify() would fail if either were issued.
    expect(timerService.isTimerRunning).toBe(false);
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
