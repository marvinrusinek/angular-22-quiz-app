import { Service, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError, map, shareReplay, switchMap } from 'rxjs/operators';

import { QuestionVerdictError } from './question-verdict.types';
import { API_BASE_URL } from '../../../tokens/api-base-url.token';

/**
 * Topic Quiz attempt and per-question timing receipts.
 *
 * ── Two receipts, two jobs ─────────────────────────────────────────
 *
 * The ATTEMPT receipt says "this browser started this quiz". The QUESTION
 * receipt says "this question became active at T and expires at T+30s", and it
 * is the only thing that can authorize a reveal by expiry. The split exists
 * because the Topic Quiz timer is per-question: one whole-quiz deadline is
 * still in the future when question 3 of 10 times out, so it could never
 * authorize that question's reveal.
 *
 * ── Memory only ────────────────────────────────────────────────────
 *
 * Nothing here is persisted — not localStorage, not sessionStorage, not the
 * URL. A refresh legitimately starts a new attempt, which is cheaper than
 * reasoning about a stale receipt surviving in storage. The receipts are also
 * never logged: they are readable by design, but printing them invites copying
 * them somewhere durable.
 *
 * ── One receipt per question ───────────────────────────────────────
 *
 * `questionReceipts` is keyed by canonical question text and never refreshed
 * for a question already started. That is what stops a revisit — or a second
 * change-detection pass — from restarting a question's 30 seconds. The server
 * is stateless, so it would happily issue a fresh deadline; not asking for one
 * is the client's responsibility.
 *
 * ── Deadlines live on the CLIENT clock ─────────────────────────────
 *
 * The server sends `startedAt`/`expiresAt` on its own clock. Subtracting those
 * from `Date.now()` would silently bake in whatever the two clocks disagree
 * by — and a client running fast would time out BEFORE the signed deadline,
 * which is the exact failure this whole mechanism exists to prevent. So the
 * server's DURATION is anchored to the local instant the response settled:
 * the countdown then ends one network round-trip AFTER the server's deadline,
 * never before it, whatever the clocks think. No tolerance is added.
 */
@Service()
export class TopicQuizAttemptService {
  private readonly http = inject(HttpClient);
  private readonly apiBaseUrl = inject(API_BASE_URL);

  /** The quiz the in-flight state belongs to. Switching quizzes discards it. */
  private quizId: string | null = null;

  /** Shared so concurrent first-renders produce ONE attempt, not several. */
  private attempt$: Observable<string> | null = null;

  /** Canonical question text → in-flight or settled activation. */
  private readonly questionReceipts = new Map<string, Observable<QuestionActivation>>();

  /**
   * Match the server's canonicalization closely enough to key the cache.
   *
   * This is a CACHE KEY, not an identity assertion — the server still resolves
   * the question itself. Getting it slightly wrong would mean a duplicate
   * receipt, never a wrong answer.
   */
  private cacheKey(questionText: string): string {
    return questionText.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  private baseUrl(quizId: string): string {
    return `${this.apiBaseUrl}/quizzes/${encodeURIComponent(quizId)}`;
  }

  /**
   * Discard everything when the quiz changes.
   *
   * A receipt is bound to one quiz server-side, so reuse would fail anyway —
   * but failing on the server is a round trip and a user-visible error, and the
   * client already knows better.
   */
  private ensureQuiz(quizId: string): void {
    if (this.quizId === quizId) return;
    this.quizId = quizId;
    this.attempt$ = null;
    this.questionReceipts.clear();
  }

  /**
   * The attempt receipt for this quiz, created at most once.
   *
   * `shareReplay` is what makes duplicate renders safe: several subscribers
   * arriving before the response lands share the one request, and later
   * subscribers get the settled value rather than a new attempt.
   */
  attemptReceipt(quizId: string): Observable<string> {
    this.ensureQuiz(quizId);

    if (!this.attempt$) {
      this.attempt$ = this.http
        .post<{ attemptReceipt: string }>(`${this.baseUrl(quizId)}/attempts`, {})
        .pipe(
          map((body) => body.attemptReceipt),
          catchError(() => throwError(() => new QuestionVerdictError('Invalid submission'))),
          shareReplay({ bufferSize: 1, refCount: false })
        );
    }
    return this.attempt$;
  }

  /**
   * The receipt for ONE question, created at most once per question.
   *
   * Called when a question becomes active. A revisit returns the ORIGINAL
   * receipt, so the question's deadline is not pushed forward by navigating
   * away and back.
   */
  private activation(quizId: string, questionText: string): Observable<QuestionActivation> {
    this.ensureQuiz(quizId);

    const key = this.cacheKey(questionText);
    const cached = this.questionReceipts.get(key);
    if (cached) return cached;

    const request$ = this.attemptReceipt(quizId).pipe(
      switchMap((attemptReceipt) =>
        this.http.post<QuestionStartResponse>(
          `${this.baseUrl(quizId)}/questions/start`,
          { questionText },
          { headers: { 'X-Attempt-Receipt': attemptReceipt } }
        )
      ),
      map((body) => ({
        receipt: body.questionReceipt,
        // Anchor the server's duration to the local clock at arrival. See the
        // class docblock: this is what keeps the countdown from ending early
        // when the two clocks disagree.
        deadlineMs: Date.now() + Math.max(0, body.expiresAt - body.startedAt)
      })),
      catchError((err: unknown) => {
        // A failed start must not poison the cache — the next attempt to
        // activate this question should be able to try again.
        this.questionReceipts.delete(key);
        return throwError(() =>
          err instanceof QuestionVerdictError ? err : new QuestionVerdictError('Invalid submission')
        );
      }),
      shareReplay({ bufferSize: 1, refCount: false })
    );

    this.questionReceipts.set(key, request$);
    return request$;
  }

  /**
   * Activate a question and report WHEN it expires, on the local clock.
   *
   * The receipt itself stays inside this service — the timer only needs the
   * deadline, and handing out a credential to something that will not send it
   * anywhere is how credentials end up logged. A revisit replays the original
   * deadline rather than issuing a new one, so navigating away and back cannot
   * buy more time.
   */
  startQuestion(quizId: string, questionText: string): Observable<QuestionTiming> {
    return this.activation(quizId, questionText).pipe(
      map(({ deadlineMs }) => ({ deadlineMs }))
    );
  }

  /** True when this question already has a receipt. Used by tests and guards. */
  hasStarted(quizId: string, questionText: string): boolean {
    return this.quizId === quizId && this.questionReceipts.has(this.cacheKey(questionText));
  }

  /** Leaving the quiz. Everything is in memory, so dropping it is the cleanup. */
  clear(): void {
    this.quizId = null;
    this.attempt$ = null;
    this.questionReceipts.clear();
  }

  /**
   * Run `project` with this question's receipt attached.
   *
   * Kept here so the receipt never has to be handed out to a caller that only
   * wants to make one authorized request with it.
   */
  withQuestionReceipt<T>(
    quizId: string,
    questionText: string,
    project: (headers: Record<string, string>) => Observable<T>
  ): Observable<T> {
    return this.activation(quizId, questionText).pipe(
      switchMap(({ receipt }) => project({ 'X-Question-Receipt': receipt }))
    );
  }
}

/** What `/questions/start` sends back. `questionReceipt` never leaves the service. */
interface QuestionStartResponse {
  readonly questionReceipt: string;
  readonly startedAt: number;
  readonly expiresAt: number;
}

/** Cached per question: the credential plus its local-clock deadline. */
interface QuestionActivation {
  readonly receipt: string;
  readonly deadlineMs: number;
}

/** The only part of an activation a caller is allowed to see. */
export interface QuestionTiming {
  readonly deadlineMs: number;
}

/** Re-exported so specs can assert the endpoints without duplicating strings. */
export const TOPIC_QUIZ_ENDPOINTS = {
  attempts: (base: string, quizId: string) => `${base}/quizzes/${quizId}/attempts`,
  questionStart: (base: string, quizId: string) => `${base}/quizzes/${quizId}/questions/start`,
  check: (base: string, quizId: string) => `${base}/quizzes/${quizId}/check`
} as const;
