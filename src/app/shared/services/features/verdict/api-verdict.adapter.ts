import { Service, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';

import { API_BASE_URL } from '@shared/tokens/api-base-url.token';
import { TopicQuizAttemptService } from './topic-quiz-attempt.service';
import type { TopicQuizVerdictAdapter } from './verdict-adapter';
import {
  QuestionVerdictError,
  type QuestionCheckResult,
  type QuestionExpiredResult
} from './question-verdict.types';

/**
 * The production verdict source: `POST /api/quizzes/:quizId/check`.
 *
 * ── What this adapter deliberately cannot do ───────────────────────
 *
 * It has no access to the quiz bank, so there is nothing to fall back to when
 * the network fails. That is the point. A fallback to `option.correct` would
 * keep working right up until the day the answer key leaves the bundle, and
 * then fail silently — better that a failure is a failure now.
 *
 * ── Expiry is not ours to claim ────────────────────────────────────
 *
 * `revealExpired` sends the same request as a normal check. The server decides
 * whether the question's signed deadline has passed and answers `expired` if
 * so. Nothing in the request asserts expiry, because a client that could assert
 * it could harvest all 185 answers in a loop.
 *
 * The empty selection is what makes the timeout call meaningful: the user ran
 * out of time, so whatever they had picked is beside the point — but note the
 * server reveals on expiry regardless of selection, so a partially-answered
 * question that times out still reveals.
 */
@Service()
export class ApiTopicQuizVerdictAdapter implements TopicQuizVerdictAdapter {
  private readonly http = inject(HttpClient);
  private readonly apiBaseUrl = inject(API_BASE_URL);
  private readonly attempts = inject(TopicQuizAttemptService);

  private checkUrl(quizId: string): string {
    return `${this.apiBaseUrl}/quizzes/${encodeURIComponent(quizId)}/check`;
  }

  /**
   * One authorized check.
   *
   * The receipt is fetched through `withQuestionReceipt` rather than passed in,
   * so it never has to travel through the verdict service or a component. Every
   * failure — network, 401, 400, malformed body — collapses to the same coarse
   * error: consumers need to know it failed, not which part the server disliked.
   */
  private submit(
    quizId: string,
    questionText: string,
    selectedOptionTexts: readonly string[]
  ): Observable<QuestionCheckResult> {
    return this.attempts.withQuestionReceipt(quizId, questionText, (headers) =>
      this.http.post<QuestionCheckResult>(
        this.checkUrl(quizId),
        // Identity is TEXT. No ids, no indexes, nothing derived from the
        // rendered order — the server resolves both question and options from
        // these strings.
        { questionText, selectedOptionTexts: [...selectedOptionTexts] },
        { headers }
      )
    ).pipe(
      map((result) => {
        if (!result || typeof (result as { status?: unknown }).status !== 'string') {
          throw new QuestionVerdictError('Invalid submission');
        }
        return result;
      }),
      catchError((err: unknown) =>
        throwError(() =>
          err instanceof QuestionVerdictError ? err : new QuestionVerdictError('Invalid submission')
        )
      )
    );
  }

  check(
    quizId: string,
    questionText: string,
    selectedOptionTexts: readonly string[]
  ): Observable<QuestionCheckResult> {
    return this.submit(quizId, questionText, selectedOptionTexts);
  }

  revealExpired(quizId: string, questionText: string): Observable<QuestionExpiredResult> {
    return this.submit(quizId, questionText, []).pipe(
      switchMap((result) =>
        // Only the server may declare expiry. If it answered anything else the
        // deadline has not passed, and treating that as a reveal would paint
        // answers the user is not entitled to see yet.
        result.status === 'expired'
          ? [result]
          : throwError(() => new QuestionVerdictError('Invalid submission'))
      )
    );
  }
}
