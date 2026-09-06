import { HttpClient, HttpHeaders } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { catchError, map, type Observable } from 'rxjs';
import { throwError } from 'rxjs';

import { API_BASE_URL } from '../../tokens/api-base-url.token';
import type {
  ActiveInterviewSessionDto,
  CreateInterviewSessionRequest,
  InterviewResultDto,
  SaveInterviewAnswerRequest,
  SaveInterviewAnswerResponse,
  SetReviewFlagRequest,
  SetReviewFlagResponse,
  QuizMetadataDto,
  QuizMetadataListDto
} from '../../models/api/interview-api.dto';
import type {
  InterviewResultViewModel,
  InterviewSessionViewModel
} from '../../models/interview/interview-view-models';
import { InterviewApiError, toInterviewApiError } from './interview-api.errors';
import { toResultViewModel, toSessionViewModel } from './interview-api.mappers';

/**
 * The ONLY place Interview HTTP calls are made.
 *
 * Responsibilities are deliberately narrow: build the request, attach the
 * bearer token to session-scoped calls, map the response, map the error. It
 * never calculates correctness, never touches sessionStorage, and never
 * navigates.
 *
 * The token is attached PER CALL rather than by a global HTTP interceptor — an
 * interceptor would attach it to every outbound request, including the static
 * asset fetches this app still makes, which is exactly how bearer tokens leak
 * to unintended origins.
 */
export interface CreatedInterviewSession {
  readonly session: InterviewSessionViewModel;
  /** Returned by creation ONLY. The caller stores it; it is never logged. */
  readonly sessionToken: string;
}

@Service()
export class InterviewApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(API_BASE_URL);

  /**
   * True when a backend origin is configured for this build.
   *
   * With no origin, `baseUrl` is '' and every URL below would collapse to a
   * RELATIVE path — the request would hit the static site host and return its
   * index.html, which is far worse than failing. Callers check
   * `isApiConfigured()` first; this is the backstop for anything that does not.
   */
  private get configured(): boolean {
    return this.baseUrl.trim().length > 0;
  }

  private notConfigured<T>(): Observable<T> {
    return throwError(() => new InterviewApiError('BACKEND_UNAVAILABLE', 0));
  }

  /**
   * PUBLIC topic metadata for the builder: ids, titles, difficulty and how many
   * questions each topic holds. No questions, options, correctness or
   * explanations — the endpoint does not serve them and the builder does not
   * need them.
   */
  getQuizMetadata(): Observable<readonly QuizMetadataDto[]> {
    if (!this.configured) return this.notConfigured();
    return this.http
      .get<QuizMetadataListDto>(`${this.baseUrl}/quizzes`)
      .pipe(
        map((dto) => dto.quizzes ?? []),
        catchError((err: unknown) => throwError(() => toInterviewApiError(err)))
      );
  }

  createSession(request: CreateInterviewSessionRequest): Observable<CreatedInterviewSession> {
    if (!this.configured) return this.notConfigured();
    return this.http
      .post<ActiveInterviewSessionDto>(`${this.baseUrl}/interview-sessions`, request)
      .pipe(
        map((dto) => {
          if (!dto.sessionToken) {
            // Without a token the session is unusable; fail loudly rather than
            // storing a half-reference the user can never resume.
            throw toInterviewApiError(null);
          }
          return { session: toSessionViewModel(dto), sessionToken: dto.sessionToken };
        }),
        catchError((err: unknown) => throwError(() => toInterviewApiError(err)))
      );
  }

  resumeSession(sessionId: string, token: string): Observable<InterviewSessionViewModel> {
    if (!this.configured) return this.notConfigured();
    return this.http
      .get<ActiveInterviewSessionDto>(this.sessionUrl(sessionId), { headers: this.auth(token) })
      .pipe(
        map(toSessionViewModel),
        catchError((err: unknown) => throwError(() => toInterviewApiError(err)))
      );
  }

  saveAnswer(
    sessionId: string,
    token: string,
    questionId: string,
    selectedOptionIds: readonly number[]
  ): Observable<SaveInterviewAnswerResponse> {
    if (!this.configured) return this.notConfigured();
    const body: SaveInterviewAnswerRequest = { selectedOptionIds: [...selectedOptionIds] };

    return this.http
      .put<SaveInterviewAnswerResponse>(
        `${this.sessionUrl(sessionId)}/answers/${encodeURIComponent(questionId)}`,
        body,
        { headers: this.auth(token) }
      )
      .pipe(catchError((err: unknown) => throwError(() => toInterviewApiError(err))));
  }

  /** Set or clear the Mark-for-Review flag for ONE question. Never an answer. */
  setReviewFlag(
    sessionId: string,
    token: string,
    questionId: string,
    flagged: boolean
  ): Observable<SetReviewFlagResponse> {
    if (!this.configured) return this.notConfigured();
    const body: SetReviewFlagRequest = { flagged };

    return this.http
      .put<SetReviewFlagResponse>(
        `${this.sessionUrl(sessionId)}/review/${encodeURIComponent(questionId)}`,
        body,
        { headers: this.auth(token) }
      )
      .pipe(catchError((err: unknown) => throwError(() => toInterviewApiError(err))));
  }

  /** The submit request carries NO body fields — the server owns every value. */
  submitSession(sessionId: string, token: string): Observable<InterviewResultViewModel> {
    if (!this.configured) return this.notConfigured();
    return this.http
      .post<InterviewResultDto>(`${this.sessionUrl(sessionId)}/submit`, {}, { headers: this.auth(token) })
      .pipe(
        map(toResultViewModel),
        catchError((err: unknown) => throwError(() => toInterviewApiError(err)))
      );
  }

  getResult(sessionId: string, token: string): Observable<InterviewResultViewModel> {
    if (!this.configured) return this.notConfigured();
    return this.http
      .get<InterviewResultDto>(`${this.sessionUrl(sessionId)}/result`, { headers: this.auth(token) })
      .pipe(
        map(toResultViewModel),
        catchError((err: unknown) => throwError(() => toInterviewApiError(err)))
      );
  }

  // ── internals ─────────────────────────────────────────────────────

  private sessionUrl(sessionId: string): string {
    // The id is server-generated and opaque; encoding it keeps a malformed
    // reference from altering the path shape.
    return `${this.baseUrl}/interview-sessions/${encodeURIComponent(sessionId)}`;
  }

  /** The token travels ONLY in this header — never a query param or cookie. */
  private auth(token: string): HttpHeaders {
    return new HttpHeaders({ Authorization: `Bearer ${token}` });
  }
}
