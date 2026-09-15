import { HttpClient, HttpHeaders } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { catchError, map, type Observable } from 'rxjs';
import { throwError } from 'rxjs';

import { INTERVIEW_API_BASE_URL } from '../../tokens/api-base-url.token';
import type {
  ActiveInterviewSessionDto,
  CreateInterviewSessionRequest,
  InterviewResultDto,
  SaveInterviewAnswerRequest,
  SaveInterviewAnswerResponse,
  SetReviewFlagRequest,
  SetReviewFlagResponse,
  QuizMetadataDto
} from '../../models/api/interview-api.dto';
import type {
  InterviewResultViewModel,
  InterviewSessionViewModel
} from '../../models/interview/interview-view-models';
import { InterviewApiError, toInterviewApiError } from './interview-api.errors';
import { toResultViewModel, toSessionViewModel } from './interview-api.mappers';
import { TopicQuizMetadataService } from './topic-quiz-metadata.service';

/**
 * The ONLY place Interview SESSION-LIFECYCLE HTTP calls are made — create,
 * resume, answer, mark-for-review, submit, result. Every one of those
 * resolves `INTERVIEW_API_BASE_URL` (Spring), and this service injects
 * ONLY that one token — never `API_BASE_URL` (Node) too, since holding both
 * in one service is exactly the kind of thing that makes accidental
 * cross-routing easy. `getQuizMetadata()` below is the one exception: it
 * delegates entirely to the Node-owned `TopicQuizMetadataService` rather
 * than making its own Spring request, so this class never needs a second
 * base URL of its own.
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
  private readonly baseUrl = inject(INTERVIEW_API_BASE_URL);
  private readonly topicQuizMetadata = inject(TopicQuizMetadataService);

  /**
   * True when a Spring origin is configured for this build.
   *
   * With no origin, `baseUrl` is '' and every session-lifecycle URL below
   * would collapse to a RELATIVE path — the request would hit the static
   * site host and return its index.html, which is far worse than failing.
   * Callers check `isInterviewApiConfigured()` first; this is the backstop
   * for anything that does not. `getQuizMetadata()` below has no equivalent
   * guard — it never touches this base URL at all.
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
   *
   * Delegates entirely to the Node-owned `TopicQuizMetadataService` rather
   * than issuing its own request against Spring: this is the SAME
   * `GET /quizzes` metadata Topic Quiz itself reads, so Node stays the one
   * owner instead of a second, duplicate implementation existing on Spring.
   * `TopicQuizMetadataService.load()` shares one in-flight/replayed request
   * across every caller, so calling it here never adds a second real HTTP
   * request beyond whatever Topic Quiz's own pages already trigger.
   */
  getQuizMetadata(): Observable<readonly QuizMetadataDto[]> {
    return this.topicQuizMetadata.load().pipe(map((entries) => entries.map(toQuizMetadataDto)));
  }

  /**
   * `idempotencyKey`, when supplied, is sent as the `Idempotency-Key` header
   * — the server treats a repeated request carrying the SAME key (a retry of
   * the same logical start attempt, e.g. after a cold-start gateway
   * timeout) as "did this already commit?" rather than minting a second
   * session. See {@code BuildYourInterviewComponent#startInterview} for the
   * client-side half of this: one key is generated per logical attempt and
   * reused across that attempt's own retries only, never across two
   * genuinely different attempts.
   */
  createSession(
    request: CreateInterviewSessionRequest,
    idempotencyKey?: string
  ): Observable<CreatedInterviewSession> {
    if (!this.configured) return this.notConfigured();
    const headers = idempotencyKey ? new HttpHeaders({ 'Idempotency-Key': idempotencyKey }) : undefined;
    return this.http
      .post<ActiveInterviewSessionDto>(`${this.baseUrl}/interview-sessions`, request, { headers })
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

/**
 * Adapt one `TopicQuizMetadataService` entry to this service's public
 * `QuizMetadataDto` contract.
 *
 * The two shapes differ only in strictness: `TopicQuizMetadataService`'s
 * entry type is unexported and treats every field but `quizId` as optional or
 * nullable (it is read field-by-field into per-quiz maps, so a missing value
 * just means "not set yet"), while `QuizMetadataDto` — the builder's existing
 * public contract — declares `milestone`/`summary`/`image`/`difficulty`/
 * `questionCount` as required. `InterviewCatalogService`, the sole consumer,
 * never reads `summary` or `image` and already falls back to `quizId` for a
 * blank `milestone`, so defaulting a missing value to '' / 0 here changes
 * nothing observable — it only satisfies the stricter type.
 */
function toQuizMetadataDto(entry: {
  readonly quizId: string;
  readonly milestone?: string;
  readonly summary?: string;
  readonly image?: string;
  readonly difficulty?: string | null;
  readonly facts?: readonly string[];
  readonly questionCount?: number | null;
}): QuizMetadataDto {
  return {
    quizId: entry.quizId,
    milestone: entry.milestone ?? '',
    summary: entry.summary ?? '',
    image: entry.image ?? '',
    difficulty: entry.difficulty ?? '',
    facts: entry.facts,
    questionCount: entry.questionCount ?? 0,
  };
}
