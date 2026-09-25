import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest
} from '@angular/common/http/testing';

import { API_BASE_URL } from '@shared/tokens/api-base-url.token';
import { ApiTopicQuizVerdictAdapter } from './api-verdict.adapter';
import { QuestionVerdictService } from './question-verdict.service';
import { TopicQuizAttemptService } from './topic-quiz-attempt.service';
import { TOPIC_QUIZ_VERDICT_ADAPTER } from './verdict-adapter';
import { QuestionVerdictError, type QuestionCheckResult } from './question-verdict.types';

/**
 * The API-backed verdict path.
 *
 * What these tests protect, in order of importance:
 *
 *  1. Angular never sends an id, an index, or anything derived from the answer
 *     key. Identity on the wire is quizId + exact question text + option texts.
 *  2. One attempt and one question timer per question, however many times the
 *     UI renders — a duplicate start would silently reset a 30-second deadline.
 *  3. A stale response can never overwrite a newer selection's verdict.
 *  4. A failure fails CLOSED. There is no local fallback to fall back to.
 */

const BASE = 'https://api.test/api';
const QUIZ = 'rxjs';
const MULTI = 'Select every operator';
const SINGLE = 'Which answer is correct?';

let http: HttpTestingController;
let attempts: TopicQuizAttemptService;
let verdicts: QuestionVerdictService;

const url = {
  attempts: `${BASE}/quizzes/${QUIZ}/attempts`,
  start: `${BASE}/quizzes/${QUIZ}/questions/start`,
  check: `${BASE}/quizzes/${QUIZ}/check`
};

beforeEach(() => {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: API_BASE_URL, useValue: BASE },
      // The whole point of the seam: swap the source, touch no consumer.
      { provide: TOPIC_QUIZ_VERDICT_ADAPTER, useExisting: ApiTopicQuizVerdictAdapter }
    ]
  });

  http = TestBed.inject(HttpTestingController);
  attempts = TestBed.inject(TopicQuizAttemptService);
  verdicts = TestBed.inject(QuestionVerdictService);
});

afterEach(() => {
  http.verify();
});

/** Answer the attempt request, then the question-start request. */
function grantReceipts(questionText: string, receipt = 'q-receipt'): void {
  http.expectOne({ method: 'POST', url: url.attempts })
    .flush({ quizId: QUIZ, attemptReceipt: 'attempt-receipt', startedAt: 1, expiresAt: 2 });

  const start = http.expectOne({ method: 'POST', url: url.start });
  expect(start.request.body).toEqual({ questionText });
  expect(start.request.headers.get('X-Attempt-Receipt')).toBe('attempt-receipt');
  start.flush({
    quizId: QUIZ, questionText, durationSeconds: 30,
    startedAt: 1, expiresAt: 30_001, questionReceipt: receipt
  });
}

const INCOMPLETE: QuestionCheckResult = {
  status: 'incomplete',
  selectedVerdicts: [{ text: 'map', correct: true }],
  remainingCorrectCount: 1
};

const RESOLVED: QuestionCheckResult = {
  status: 'resolved',
  correct: true,
  correctOptionTexts: ['map', 'filter'],
  explanation: 'map and filter are operators.'
};

describe('the request Angular sends', () => {
  it('checks with TEXT identity only — no ids, no indexes', () => {
    verdicts.checkAnswer(QUIZ, MULTI, ['map']).subscribe();
    grantReceipts(MULTI);

    const req = http.expectOne({ method: 'POST', url: url.check });
    expect(req.request.body).toEqual({
      questionText: MULTI,
      selectedOptionTexts: ['map']
    });
    expect(req.request.headers.get('X-Question-Receipt')).toBe('q-receipt');

    // Nothing resembling an identifier or the answer key leaves the browser.
    const wire = JSON.stringify(req.request.body);
    for (const banned of [
      'questionId', 'optionId', 'questionIndex', 'optionIndex',
      'correct', 'isCorrect', 'explanation', 'id'
    ]) {
      expect(wire).not.toContain(banned);
    }
    req.flush(INCOMPLETE);
  });

  it('sends the FULL selection each time, not a delta', () => {
    verdicts.checkAnswer(QUIZ, MULTI, ['map']).subscribe();
    grantReceipts(MULTI);
    http.expectOne({ method: 'POST', url: url.check }).flush(INCOMPLETE);

    verdicts.checkAnswer(QUIZ, MULTI, ['map', 'filter']).subscribe();
    const second = http.expectOne({ method: 'POST', url: url.check });
    expect(second.request.body.selectedOptionTexts).toEqual(['map', 'filter']);
    second.flush(RESOLVED);
  });
});

describe('attempt and question lifecycle', () => {
  it('creates ONE attempt however many questions are checked', () => {
    verdicts.checkAnswer(QUIZ, MULTI, ['map']).subscribe();
    grantReceipts(MULTI);
    http.expectOne({ method: 'POST', url: url.check }).flush(INCOMPLETE);

    verdicts.checkAnswer(QUIZ, SINGLE, ['A pipe']).subscribe();
    // A second question starts its own timer, but NOT a second attempt.
    const start = http.expectOne({ method: 'POST', url: url.start });
    start.flush({ questionReceipt: 'q2', expiresAt: 1, startedAt: 0, quizId: QUIZ, questionText: SINGLE, durationSeconds: 30 });
    http.expectOne({ method: 'POST', url: url.check }).flush(INCOMPLETE);

    http.expectNone({ method: 'POST', url: url.attempts });
  });

  it('a duplicate render does NOT start a second question timer', () => {
    attempts.startQuestion(QUIZ, MULTI).subscribe();
    grantReceipts(MULTI);

    // Change detection re-runs and the question activates again.
    attempts.startQuestion(QUIZ, MULTI).subscribe();
    attempts.startQuestion(QUIZ, MULTI).subscribe();

    // No further start request: a second one would silently reset the 30s.
    http.expectNone({ method: 'POST', url: url.start });
    expect(attempts.hasStarted(QUIZ, MULTI)).toBe(true);
  });

  it('concurrent first renders share ONE attempt request', () => {
    // Two questions activate before either response lands.
    attempts.startQuestion(QUIZ, MULTI).subscribe();
    attempts.startQuestion(QUIZ, SINGLE).subscribe();

    http.expectOne({ method: 'POST', url: url.attempts })
      .flush({ attemptReceipt: 'attempt-receipt' });

    const starts = http.match({ method: 'POST', url: url.start });
    expect(starts.length).toBe(2);
    starts.forEach((s, i) => s.flush({ questionReceipt: `q${i}` }));
  });

  it('REVISITING a question reuses its original receipt', () => {
    verdicts.checkAnswer(QUIZ, MULTI, ['map']).subscribe();
    grantReceipts(MULTI, 'original-receipt');
    http.expectOne({ method: 'POST', url: url.check }).flush(INCOMPLETE);

    // The user navigates away and comes back, then answers again.
    verdicts.checkAnswer(QUIZ, MULTI, ['map', 'filter']).subscribe();

    http.expectNone({ method: 'POST', url: url.start });
    const req = http.expectOne({ method: 'POST', url: url.check });
    // The ORIGINAL deadline still applies — a revisit must not buy more time.
    expect(req.request.headers.get('X-Question-Receipt')).toBe('original-receipt');
    req.flush(RESOLVED);
  });

  it('a DIFFERENT quiz cannot reuse the previous quiz\'s receipt', () => {
    attempts.startQuestion(QUIZ, MULTI).subscribe();
    grantReceipts(MULTI);

    attempts.startQuestion('signals', 'What does computed() return?').subscribe();

    // Switching quizzes discards the old attempt and starts a fresh one.
    http.expectOne({ method: 'POST', url: `${BASE}/quizzes/signals/attempts` })
      .flush({ attemptReceipt: 'signals-attempt' });
    const start = http.expectOne({ method: 'POST', url: `${BASE}/quizzes/signals/questions/start` });
    expect(start.request.headers.get('X-Attempt-Receipt')).toBe('signals-attempt');
    start.flush({ questionReceipt: 'signals-q' });

    expect(attempts.hasStarted(QUIZ, MULTI)).toBe(false);
  });

  it('clear() drops everything so the next quiz starts clean', () => {
    attempts.startQuestion(QUIZ, MULTI).subscribe();
    grantReceipts(MULTI);
    expect(attempts.hasStarted(QUIZ, MULTI)).toBe(true);

    attempts.clear();
    expect(attempts.hasStarted(QUIZ, MULTI)).toBe(false);

    attempts.startQuestion(QUIZ, MULTI).subscribe();
    grantReceipts(MULTI);   // a whole new attempt + start
  });

  it('never writes the receipt to browser storage', () => {
    const localSpy = jest.spyOn(Storage.prototype, 'setItem');

    verdicts.checkAnswer(QUIZ, MULTI, ['map']).subscribe();
    grantReceipts(MULTI, 'secret-receipt');
    http.expectOne({ method: 'POST', url: url.check }).flush(RESOLVED);

    for (const [, value] of localSpy.mock.calls) {
      expect(String(value)).not.toContain('secret-receipt');
      expect(String(value)).not.toContain('attempt-receipt');
    }
    localSpy.mockRestore();
  });
});

describe('stale responses', () => {
  /** Issue a check and hand back its pending HTTP request. */
  function issue(texts: string[]): TestRequest {
    verdicts.checkAnswer(QUIZ, MULTI, texts).subscribe({ error: () => undefined });
    return http.expectOne({ method: 'POST', url: url.check });
  }

  it('an older response landing LAST does not overwrite the newer verdict', () => {
    verdicts.checkAnswer(QUIZ, MULTI, ['map']).subscribe();
    grantReceipts(MULTI);
    const first = http.expectOne({ method: 'POST', url: url.check });

    const second = issue(['map', 'filter']);

    // Request 2 resolves first…
    second.flush(RESOLVED);
    expect(verdicts.verdictFor(QUIZ, MULTI).phase).toBe('resolved');

    // …and request 1 arrives afterwards. It must be ignored.
    first.flush(INCOMPLETE);
    const state = verdicts.verdictFor(QUIZ, MULTI);
    expect(state.phase).toBe('resolved');
    expect(state.isResolvedCorrect).toBe(true);
  });

  it('a stale FAILURE does not clobber a newer success', () => {
    verdicts.checkAnswer(QUIZ, MULTI, ['map']).subscribe({ error: () => undefined });
    grantReceipts(MULTI);
    const first = http.expectOne({ method: 'POST', url: url.check });

    const second = issue(['map', 'filter']);
    second.flush(RESOLVED);

    first.error(new ProgressEvent('network error'));

    expect(verdicts.verdictFor(QUIZ, MULTI).phase).toBe('resolved');
  });

  it('DESELECTION is ordered too — the newest empty selection wins', () => {
    verdicts.checkAnswer(QUIZ, MULTI, ['map', 'filter']).subscribe();
    grantReceipts(MULTI);
    const first = http.expectOne({ method: 'POST', url: url.check });

    // The user deselects everything before the first response returns.
    const second = issue([]);
    second.flush({ status: 'incomplete', selectedVerdicts: [], remainingCorrectCount: 2 });

    first.flush(RESOLVED);

    const state = verdicts.verdictFor(QUIZ, MULTI);
    expect(state.phase).toBe('incomplete');
    expect(state.remainingCorrectCount).toBe(2);
  });

  it('the newest response still applies when it lands last', () => {
    verdicts.checkAnswer(QUIZ, MULTI, ['map']).subscribe();
    grantReceipts(MULTI);
    const first = http.expectOne({ method: 'POST', url: url.check });
    const second = issue(['map', 'filter']);

    first.flush(INCOMPLETE);
    second.flush(RESOLVED);

    expect(verdicts.verdictFor(QUIZ, MULTI).phase).toBe('resolved');
  });
});

describe('failure is closed', () => {
  it('a network failure produces an ERROR phase, never a correctness claim', (done) => {
    verdicts.checkAnswer(QUIZ, MULTI, ['map']).subscribe({
      error: (err: unknown) => {
        expect(err).toBeInstanceOf(QuestionVerdictError);

        const state = verdicts.verdictFor(QUIZ, MULTI);
        expect(state.phase).toBe('error');
        // Nothing was revealed and nothing was marked correct.
        expect(state.correctOptionTexts).toEqual([]);
        expect(state.isResolvedCorrect).toBeNull();
        done();
      }
    });

    grantReceipts(MULTI);
    http.expectOne({ method: 'POST', url: url.check })
      .error(new ProgressEvent('network error'));
  });

  it('keeps the user\'s selection after a failure', (done) => {
    verdicts.checkAnswer(QUIZ, MULTI, ['map', 'filter']).subscribe({
      error: () => {
        expect(verdicts.verdictFor(QUIZ, MULTI).selectedOptionTexts).toEqual(['map', 'filter']);
        done();
      }
    });

    grantReceipts(MULTI);
    http.expectOne({ method: 'POST', url: url.check }).flush('nope', { status: 500, statusText: 'Server Error' });
  });

  it('does not leak backend error detail to the caller', (done) => {
    verdicts.checkAnswer(QUIZ, MULTI, ['map']).subscribe({
      error: (err: unknown) => {
        expect((err as Error).message).toBe('Invalid submission');
        expect(JSON.stringify(err)).not.toContain('stack trace from server');
        done();
      }
    });

    grantReceipts(MULTI);
    http.expectOne({ method: 'POST', url: url.check })
      .flush({ message: 'stack trace from server' }, { status: 400, statusText: 'Bad Request' });
  });

  it('a failed question START can be retried', () => {
    attempts.startQuestion(QUIZ, MULTI).subscribe({ error: () => undefined });

    http.expectOne({ method: 'POST', url: url.attempts }).flush({ attemptReceipt: 'a' });
    http.expectOne({ method: 'POST', url: url.start })
      .error(new ProgressEvent('network error'));

    expect(attempts.hasStarted(QUIZ, MULTI)).toBe(false);

    // The cache was not poisoned — activating again really retries.
    attempts.startQuestion(QUIZ, MULTI).subscribe();
    http.expectOne({ method: 'POST', url: url.start }).flush({ questionReceipt: 'q' });
  });
});

describe('expiry', () => {
  it('asks the server and accepts ONLY an expired verdict', (done) => {
    verdicts.revealExpiredQuestion(QUIZ, MULTI).subscribe((result) => {
      expect(result.correctOptionTexts).toEqual(['map', 'filter']);

      const state = verdicts.verdictFor(QUIZ, MULTI);
      expect(state.phase).toBe('expired');
      expect(state.explanation).toBe('map and filter are operators.');
      done();
    });

    grantReceipts(MULTI);
    const req = http.expectOne({ method: 'POST', url: url.check });
    // Angular does not claim expiry — it sends an ordinary check.
    expect(req.request.body).toEqual({ questionText: MULTI, selectedOptionTexts: [] });
    expect(JSON.stringify(req.request.body)).not.toContain('expired');

    req.flush({
      status: 'expired',
      correctOptionTexts: ['map', 'filter'],
      explanation: 'map and filter are operators.'
    });
  });

  it('REFUSES to reveal when the server says the deadline has not passed', (done) => {
    verdicts.revealExpiredQuestion(QUIZ, MULTI).subscribe({
      error: () => {
        // No reveal, and no correct options painted.
        expect(verdicts.verdictFor(QUIZ, MULTI).correctOptionTexts).toEqual([]);
        done();
      }
    });

    grantReceipts(MULTI);
    http.expectOne({ method: 'POST', url: url.check }).flush(INCOMPLETE);
  });

  it('an expiry reveal OUTRANKS an in-flight check', () => {
    verdicts.checkAnswer(QUIZ, MULTI, ['map']).subscribe({ error: () => undefined });
    grantReceipts(MULTI);
    const check = http.expectOne({ method: 'POST', url: url.check });

    verdicts.revealExpiredQuestion(QUIZ, MULTI).subscribe();
    const reveal = http.expectOne({ method: 'POST', url: url.check });
    reveal.flush({
      status: 'expired', correctOptionTexts: ['map', 'filter'], explanation: 'x'
    });

    // The earlier selection response must not undo the reveal.
    check.flush(INCOMPLETE);
    expect(verdicts.verdictFor(QUIZ, MULTI).phase).toBe('expired');
  });
});
