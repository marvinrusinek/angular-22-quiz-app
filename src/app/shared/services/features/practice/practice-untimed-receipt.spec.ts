import { TestBed } from '@angular/core/testing';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';

import { API_BASE_URL } from '../../../tokens/api-base-url.token';
import { PracticeVerdictService } from './practice-verdict.service';
import { TopicQuizAttemptService } from '../verdict/topic-quiz-attempt.service';

/**
 * Weak Areas Practice is UNTIMED, and the server's per-question receipt is not.
 *
 * `checkAnswer` evaluates expiry BEFORE any selection logic, so a receipt older
 * than its thirty-second deadline returns `expired` — a full reveal with no
 * grading at all. Practice therefore asks for a FRESH receipt immediately
 * before every check instead of reusing the cached one the Topic Quiz keeps.
 *
 * These tests pin that, because it is the difference between "a user who paused
 * to think still gets scored" and "a user who paused silently stops being
 * scored" — a failure that would never surface in a fast automated run.
 */

const BASE = 'http://api.test/api';
const QUIZ = 'rxjs';
const QUESTION = 'Which operator flattens?';

describe('Weak Areas Practice — untimed receipts', () => {
  let http: HttpTestingController;
  let verdicts: PracticeVerdictService;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: BASE },
        TopicQuizAttemptService,
        PracticeVerdictService
      ]
    });
    http = TestBed.inject(HttpTestingController);
    verdicts = TestBed.inject(PracticeVerdictService);
  });

  afterEach(() => http.verify());

  /** Answer the attempt + question-start pair that precedes one check. */
  function settleReceipts(questionReceipt: string): void {
    const attempts = http.match(`${BASE}/quizzes/${QUIZ}/attempts`);
    for (const call of attempts) call.flush({ attemptReceipt: 'ATTEMPT-1' });

    const start = http.expectOne(`${BASE}/quizzes/${QUIZ}/questions/start`);
    expect(start.request.headers.get('X-Attempt-Receipt')).toBe('ATTEMPT-1');
    start.flush({
      questionReceipt,
      startedAt: 1_000,
      expiresAt: 31_000
    });
  }

  it('a question that sat for MORE THAN 30 SECONDS is still graded normally', () => {
    jest.useFakeTimers();
    try {
      // The question becomes active…
      const activatedAt = Date.now();

      // …and the user thinks about it for well past the server's 30s deadline.
      jest.advanceTimersByTime(120_000);
      expect(Date.now() - activatedAt).toBeGreaterThan(30_000);

      let status = '';
      verdicts.check(QUIZ, QUESTION, ['mergeMap']).subscribe((r) => { status = r.status; });

      // The receipt is requested NOW, not when the question was activated, so
      // its deadline starts here and cannot already have passed.
      settleReceipts('FRESH-RECEIPT-AFTER-THE-WAIT');

      const check = http.expectOne(`${BASE}/quizzes/${QUIZ}/check`);
      expect(check.request.headers.get('X-Question-Receipt')).toBe('FRESH-RECEIPT-AFTER-THE-WAIT');

      // A server holding a fresh receipt grades the answer instead of expiring it.
      check.flush({
        status: 'resolved',
        correct: true,
        correctOptions: [{ text: 'mergeMap' }],
        explanation: 'Because it flattens.'
      });

      expect(status).toBe('resolved');
      expect(verdicts.isResolved(QUIZ, QUESTION)).toBe(true);
      expect(verdicts.verdictFor(QUIZ, QUESTION).explanation).toBe('Because it flattens.');
    } finally {
      jest.useRealTimers();
    }
  });

  it('asks for a NEW question receipt on EVERY check, never reusing the last one', () => {
    verdicts.check(QUIZ, QUESTION, ['a']).subscribe({ error: () => undefined });
    settleReceipts('RECEIPT-1');
    http.expectOne(`${BASE}/quizzes/${QUIZ}/check`).flush({
      status: 'incomplete', selectedVerdicts: [{ text: 'a', correct: false }], remainingCorrectCount: 2
    });

    // Second pick on the SAME question — a cached receipt would be reused here,
    // and would be the one that eventually ages out.
    verdicts.check(QUIZ, QUESTION, ['a', 'b']).subscribe({ error: () => undefined });
    settleReceipts('RECEIPT-2');
    const second = http.expectOne(`${BASE}/quizzes/${QUIZ}/check`);
    expect(second.request.headers.get('X-Question-Receipt')).toBe('RECEIPT-2');
    second.flush({ status: 'resolved', correct: true, correctOptions: [{ text: 'a' }, { text: 'b' }] });
  });

  it('does NOT disturb the Topic Quiz receipt cache', () => {
    const attempts = TestBed.inject(TopicQuizAttemptService);

    // A Topic Quiz question is activated and keeps its receipt.
    let topicHeaders: Record<string, string> | null = null;
    attempts.withQuestionReceipt('signals', 'Topic Q', (headers) => {
      topicHeaders = headers;
      return new (require('rxjs').Observable)((s: { next: (v: unknown) => void; complete: () => void }) => {
        s.next({}); s.complete();
      });
    }).subscribe();

    http.expectOne(`${BASE}/quizzes/signals/attempts`).flush({ attemptReceipt: 'TOPIC-ATTEMPT' });
    http.expectOne(`${BASE}/quizzes/signals/questions/start`).flush({
      questionReceipt: 'TOPIC-RECEIPT', startedAt: 0, expiresAt: 30_000
    });
    expect(topicHeaders!['X-Question-Receipt']).toBe('TOPIC-RECEIPT');

    // Practice runs against a DIFFERENT quiz — which for the Topic Quiz cache
    // would normally mean "quiz changed, discard everything".
    verdicts.check(QUIZ, QUESTION, ['x']).subscribe({ error: () => undefined });
    settleReceipts('PRACTICE-RECEIPT');
    http.expectOne(`${BASE}/quizzes/${QUIZ}/check`).flush({
      status: 'resolved', correct: false, correctOptions: [{ text: 'y' }]
    });

    // The Topic Quiz receipt survived: re-activating issues NO new start call.
    let again: Record<string, string> | null = null;
    attempts.withQuestionReceipt('signals', 'Topic Q', (headers) => {
      again = headers;
      return new (require('rxjs').Observable)((s: { next: (v: unknown) => void; complete: () => void }) => {
        s.next({}); s.complete();
      });
    }).subscribe();
    expect(again!['X-Question-Receipt']).toBe('TOPIC-RECEIPT');
  });
});
