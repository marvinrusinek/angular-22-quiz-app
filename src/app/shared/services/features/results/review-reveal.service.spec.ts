import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest
} from '@angular/common/http/testing';

import { QuizQuestion, ScoreAnalysisItem } from '@shared/models';
import { API_BASE_URL } from '@shared/tokens/api-base-url.token';
import { QuestionVerdictService } from '@shared/services/features/verdict/question-verdict.service';
import { TOPIC_QUIZ_VERDICT_ADAPTER } from '@shared/services/features/verdict/verdict-adapter';
import { ApiTopicQuizVerdictAdapter } from '@shared/services/features/verdict/api-verdict.adapter';
import {
  ReviewRevealRateLimitedError,
  TopicQuizAttemptService
} from '@shared/services/features/verdict/topic-quiz-attempt.service';
import {
  REVIEW_REVEAL_CONCURRENCY,
  ReviewReveal,
  ReviewRevealService,
  mergeReviewReveals
} from './review-reveal.service';

/**
 * Review-only reveal (Option A').
 *
 * What these tests protect, in order of importance:
 *  1. No answer is requested before a question's own deadline, and none for a
 *     question that never held a receipt — a receipt is never created here.
 *  2. Nothing the verdict service owns is touched: no verdict write, no
 *     terminal event, so scoring, timers and navigation cannot react.
 *  3. Every response is tied to the question it was requested for.
 */
const BASE = 'https://api.test/api';
const QUIZ = 'topic';
const url = {
  attempts: `${BASE}/quizzes/${QUIZ}/attempts`,
  start: `${BASE}/quizzes/${QUIZ}/questions/start`,
  check: `${BASE}/quizzes/${QUIZ}/check`
};

let http: HttpTestingController;
let attempts: TopicQuizAttemptService;
let service: ReviewRevealService;

/** Issue (and settle) a real receipt for `text`, deadline = now + 30 s. */
function issueReceipt(text: string): void {
  attempts.startQuestion(QUIZ, text).subscribe();
  const a = http.match(url.attempts);
  if (a.length > 0) a[0].flush({ attemptReceipt: 'attempt-1' });
  http.expectOne(url.start).flush({
    questionReceipt: `receipt:${text}`,
    startedAt: 1,
    expiresAt: 30_001
  });
}

const item = (i: number, text: string, extra: Partial<ScoreAnalysisItem> = {}): ScoreAnalysisItem => ({
  questionIndex: i,
  questionText: text,
  wasCorrect: false,
  selectedOptionIds: [],
  correctOptionIds: [],
  ...extra
});

const checks = (): TestRequest[] => http.match((r) => r.url === url.check);
const expired = (correct: string[], explanation: string) => ({
  status: 'expired',
  correctOptionTexts: correct,
  explanation
});

beforeEach(() => {
  jest.useFakeTimers();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: API_BASE_URL, useValue: BASE },
      { provide: TOPIC_QUIZ_VERDICT_ADAPTER, useExisting: ApiTopicQuizVerdictAdapter }
    ]
  });
  http = TestBed.inject(HttpTestingController);
  attempts = TestBed.inject(TopicQuizAttemptService);
  service = TestBed.inject(ReviewRevealService);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('TopicQuizAttemptService — read-only receipt lookup', () => {
  it('reports no deadline for a question that never had a receipt', () => {
    expect(attempts.issuedDeadline(QUIZ, 'Q0')).toBeNull();
    http.expectNone(() => true);
  });

  it('reports the deadline of an issued receipt without any request', () => {
    issueReceipt('Q0');
    const deadline = attempts.issuedDeadline(QUIZ, 'Q0');
    expect(deadline).toBe(Date.now() + 30_000);
    expect(attempts.issuedDeadline(QUIZ, ' q0 ')).toBe(deadline); // canonical key
    expect(attempts.issuedDeadline('another-quiz', 'Q0')).toBeNull();
    http.expectNone(() => true);
  });

  it('never creates a receipt: no receipt means no request', () => {
    let error: unknown;
    attempts.revealIssued(QUIZ, 'Q0').subscribe({ error: (e) => (error = e) });
    expect(error).toBeDefined();
    http.expectNone(() => true);
    expect(attempts.hasStarted(QUIZ, 'Q0')).toBe(false);
  });

  it('never asks before the deadline', () => {
    issueReceipt('Q0');
    let error: unknown;
    attempts.revealIssued(QUIZ, 'Q0').subscribe({ error: (e) => (error = e) });
    expect(error).toBeDefined();
    http.expectNone(() => true);
  });

  it('after the deadline sends the issued receipt with an empty selection', () => {
    issueReceipt('Q0');
    jest.advanceTimersByTime(30_001);
    let result: unknown;
    attempts.revealIssued(QUIZ, 'Q0').subscribe((r) => (result = r));
    const req = http.expectOne(url.check);
    expect(req.request.headers.get('X-Question-Receipt')).toBe('receipt:Q0');
    expect(req.request.body).toEqual({ questionText: 'Q0', selectedOptionTexts: [] });
    req.flush(expired(['A'], 'why'));
    expect(result).toEqual(expired(['A'], 'why'));
  });

  it('accepts only an expired answer (an incomplete one reveals nothing)', () => {
    issueReceipt('Q0');
    jest.advanceTimersByTime(30_001);
    let error: unknown;
    attempts.revealIssued(QUIZ, 'Q0').subscribe({ error: (e) => (error = e) });
    http.expectOne(url.check).flush({
      status: 'incomplete',
      selectedVerdicts: [],
      remainingCorrectCount: 1
    });
    expect(error).toBeDefined();
  });

  it('turns an HTTP 429 into a rate-limit error carrying Retry-After', () => {
    issueReceipt('Q0');
    jest.advanceTimersByTime(30_001);
    let error: unknown;
    attempts.revealIssued(QUIZ, 'Q0').subscribe({ error: (e) => (error = e) });
    http
      .expectOne(url.check)
      .flush({}, { status: 429, statusText: 'Too Many', headers: { 'Retry-After': '3' } });
    expect(error).toBeInstanceOf(ReviewRevealRateLimitedError);
    expect((error as ReviewRevealRateLimitedError).retryAfterMs).toBe(3000);
  });
});

describe('ReviewRevealService.pending', () => {
  it('lists only unrevealed questions that hold a receipt, earliest deadline first', () => {
    issueReceipt('Q1');
    jest.advanceTimersByTime(5_000);
    issueReceipt('Q0');
    issueReceipt('Q3');
    const p = service.pending(QUIZ, [
      item(0, 'Q0'),
      item(1, 'Q1'),
      item(2, 'Q2'), // no receipt
      item(3, 'Q3', { explanation: 'already revealed' })
    ]);
    expect(p.map((x) => x.questionText)).toEqual(['Q1', 'Q0']);
  });
});

describe('ReviewRevealService.reveals', () => {
  it('existing receipt with an expired deadline: reveals at once', () => {
    issueReceipt('Q0');
    jest.advanceTimersByTime(31_000);
    const got: ReviewReveal[] = [];
    service.reveals(QUIZ, [item(0, 'Q0')]).subscribe((r) => got.push(r));
    jest.advanceTimersByTime(0);
    checks()[0].flush(expired(['A'], 'why-0'));
    expect(got).toEqual([
      { questionText: 'Q0', correctOptionTexts: ['A'], explanation: 'why-0' }
    ]);
  });

  it('existing receipt with a future deadline: waits, never asks early', () => {
    issueReceipt('Q0');
    jest.advanceTimersByTime(10_000); // 20 s left
    const got: ReviewReveal[] = [];
    service.reveals(QUIZ, [item(0, 'Q0')]).subscribe((r) => got.push(r));

    jest.advanceTimersByTime(19_000);
    expect(checks()).toHaveLength(0);
    jest.advanceTimersByTime(1_100);
    const [req] = checks();
    expect(req).toBeDefined();
    req.flush(expired(['B'], 'why-0'));
    expect(got).toHaveLength(1);
  });

  it('a question without a receipt is never requested', () => {
    const got: ReviewReveal[] = [];
    service.reveals(QUIZ, [item(0, 'Q0')]).subscribe((r) => got.push(r));
    jest.advanceTimersByTime(120_000);
    http.expectNone(() => true);
    expect(got).toEqual([]);
  });

  it('never has more than 2 requests in flight (concurrency cap)', () => {
    expect(REVIEW_REVEAL_CONCURRENCY).toBe(2);
    const texts = ['Q0', 'Q1', 'Q2', 'Q3', 'Q4'];
    texts.forEach(issueReceipt);
    jest.advanceTimersByTime(31_000);
    const got: ReviewReveal[] = [];
    service.reveals(QUIZ, texts.map((t, i) => item(i, t))).subscribe((r) => got.push(r));
    jest.advanceTimersByTime(0);

    const inFlight: TestRequest[] = [...checks()];
    expect(inFlight).toHaveLength(REVIEW_REVEAL_CONCURRENCY);
    let answered = 0;
    for (let round = 0; round < 10 && answered < texts.length; round++) {
      const req = inFlight.shift();
      if (!req) break;
      req.flush(expired(['A'], 'e'));
      answered++;
      jest.advanceTimersByTime(0);
      inFlight.push(...checks());
      expect(inFlight.length).toBeLessThanOrEqual(REVIEW_REVEAL_CONCURRENCY);
    }
    expect(answered).toBe(5);
    expect(got).toHaveLength(5);
  });

  it('ties each response to its own question, whatever the arrival order', () => {
    issueReceipt('Q0');
    issueReceipt('Q1');
    jest.advanceTimersByTime(31_000);
    const got: ReviewReveal[] = [];
    service.reveals(QUIZ, [item(0, 'Q0'), item(1, 'Q1')]).subscribe((r) => got.push(r));
    jest.advanceTimersByTime(0);

    const reqs = checks();
    const q0 = reqs.find((r) => r.request.body.questionText === 'Q0')!;
    const q1 = reqs.find((r) => r.request.body.questionText === 'Q1')!;
    q1.flush(expired(['B1'], 'about-q1')); // answers out of order
    q0.flush(expired(['A0'], 'about-q0'));

    const byText = Object.fromEntries(got.map((g) => [g.questionText, g]));
    expect(byText['Q0']).toEqual({
      questionText: 'Q0', correctOptionTexts: ['A0'], explanation: 'about-q0'
    });
    expect(byText['Q1']).toEqual({
      questionText: 'Q1', correctOptionTexts: ['B1'], explanation: 'about-q1'
    });
  });

  it('a failed request yields nothing, throws nothing, and spares the others', () => {
    issueReceipt('Q0');
    issueReceipt('Q1');
    jest.advanceTimersByTime(31_000);
    const got: ReviewReveal[] = [];
    let errored = false;
    service
      .reveals(QUIZ, [item(0, 'Q0'), item(1, 'Q1')])
      .subscribe({ next: (r) => got.push(r), error: () => (errored = true) });
    jest.advanceTimersByTime(0);

    const reqs = checks();
    reqs.find((r) => r.request.body.questionText === 'Q0')!
      .flush({}, { status: 500, statusText: 'boom' });
    reqs.find((r) => r.request.body.questionText === 'Q1')!
      .flush(expired(['B'], 'ok'));
    expect(errored).toBe(false);
    expect(got.map((g) => g.questionText)).toEqual(['Q1']);
  });

  it('HTTP 429: retries after Retry-After, then succeeds', () => {
    issueReceipt('Q0');
    jest.advanceTimersByTime(31_000);
    const got: ReviewReveal[] = [];
    service.reveals(QUIZ, [item(0, 'Q0')]).subscribe((r) => got.push(r));
    jest.advanceTimersByTime(0);

    checks()[0].flush({}, { status: 429, statusText: 'x', headers: { 'Retry-After': '2' } });
    jest.advanceTimersByTime(1_900);
    expect(checks()).toHaveLength(0);
    jest.advanceTimersByTime(200);
    checks()[0].flush(expired(['A'], 'late'));
    expect(got).toEqual([
      { questionText: 'Q0', correctOptionTexts: ['A'], explanation: 'late' }
    ]);
  });

  it('HTTP 429 forever: gives up quietly after a bounded number of retries', () => {
    issueReceipt('Q0');
    jest.advanceTimersByTime(31_000);
    const got: ReviewReveal[] = [];
    let errored = false;
    service
      .reveals(QUIZ, [item(0, 'Q0')])
      .subscribe({ next: (r) => got.push(r), error: () => (errored = true) });
    jest.advanceTimersByTime(0);

    let sent = 0;
    for (let i = 0; i < 6; i++) {
      const open = checks();
      sent += open.length;
      open.forEach((r) =>
        r.flush({}, { status: 429, statusText: 'x', headers: { 'Retry-After': '1' } })
      );
      jest.advanceTimersByTime(1_100);
    }
    expect(sent).toBe(4); // the first try + 3 retries
    expect(got).toEqual([]);
    expect(errored).toBe(false);
  });

  it('does not write a verdict or emit a terminal event', () => {
    const verdicts = TestBed.inject(QuestionVerdictService);
    const terminal = jest.fn();
    const changed = jest.fn();
    verdicts.terminalVerdicts$.subscribe(terminal);
    verdicts.verdictChanges$.subscribe(changed);

    issueReceipt('Q0');
    jest.advanceTimersByTime(31_000);
    service.reveals(QUIZ, [item(0, 'Q0')]).subscribe();
    jest.advanceTimersByTime(0);
    checks()[0].flush(expired(['A'], 'why'));

    expect(terminal).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(verdicts.verdictFor(QUIZ, 'Q0').phase).toBe('idle');
    expect(verdicts.hasBlockingVerdicts(QUIZ)).toBe(false);
  });
});

describe('mergeReviewReveals', () => {
  const q = (text: string, ...options: string[]): QuizQuestion =>
    ({
      questionText: text,
      options: options.map((t, i) => ({ optionId: i + 1, text: t }))
    }) as unknown as QuizQuestion;
  const reveal = (text: string, correct: string[], explanation: string): ReviewReveal => ({
    questionText: text,
    correctOptionTexts: correct,
    explanation
  });
  const map = (...r: ReviewReveal[]) =>
    new Map(r.map((x) => [x.questionText.toLowerCase(), x] as const));

  const questions = [q('Q0', 'A0', 'B0'), q('Q1', 'A1', 'B1')];

  it('returns the very same array when there is nothing to merge', () => {
    const analysis = [item(0, 'Q0')];
    expect(mergeReviewReveals(analysis, new Map(), questions)).toBe(analysis);
  });

  it('adds the reveal to the matching unrevealed item only', () => {
    const analysis = [item(0, 'Q0', { wasCorrect: false }), item(1, 'Q1')];
    const out = mergeReviewReveals(analysis, map(reveal('Q0', ['B0'], 'why-0')), questions);
    expect(out[0]).toMatchObject({
      correctOptionTexts: ['B0'],
      correctOptionIds: ['2'],
      explanation: 'why-0',
      wasCorrect: false // the score is never touched
    });
    expect(out[1]).toBe(analysis[1]);
  });

  it('never overwrites a reveal the item already carries', () => {
    const analysis = [item(0, 'Q0', { explanation: 'earned', correctOptionTexts: ['A0'] })];
    const out = mergeReviewReveals(analysis, map(reveal('Q0', ['B0'], 'other')), questions);
    expect(out[0]).toBe(analysis[0]);
  });

  it('ignores a reveal whose options are not this question\'s (no cross-question leak)', () => {
    const analysis = [item(0, 'Q0')];
    const out = mergeReviewReveals(
      analysis, map(reveal('Q0', ['B1'], 'about-q1')), questions
    );
    expect(out[0]).toBe(analysis[0]);
    expect(JSON.stringify(out)).not.toContain('about-q1');
  });

  it('uses the question text, so a shuffled display order cannot cross wires', () => {
    const shuffled = [questions[1], questions[0]]; // displayed Q1, Q0
    const analysis = [item(0, 'Q1'), item(1, 'Q0')];
    const out = mergeReviewReveals(
      analysis,
      map(reveal('Q0', ['A0'], 'for-q0'), reveal('Q1', ['B1'], 'for-q1')),
      shuffled
    );
    expect(out[0]).toMatchObject({ questionText: 'Q1', explanation: 'for-q1' });
    expect(out[1]).toMatchObject({ questionText: 'Q0', explanation: 'for-q0' });
  });
});
