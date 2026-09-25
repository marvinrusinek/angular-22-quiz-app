import { HttpErrorResponse } from '@angular/common/http';

import type { ApiErrorBodyDto } from '@shared/models/api/interview-api.dto';

/**
 * Typed Interview API errors.
 *
 * Backend messages are never shown to users verbatim — they may name internal
 * constraints. Each code carries a fixed, user-safe message; the raw backend
 * text is kept only for logging/diagnostics and must not be rendered.
 */

export type InterviewApiErrorCode =
  | 'UNAUTHORIZED'
  | 'SESSION_EXPIRED'
  | 'CONFLICT'
  | 'BAD_REQUEST'
  | 'BACKEND_UNAVAILABLE'
  | 'UNKNOWN';

const USER_MESSAGE: Record<InterviewApiErrorCode, string> = {
  UNAUTHORIZED: 'This interview session is no longer available.',
  SESSION_EXPIRED: 'Time is up — this assessment has ended.',
  CONFLICT: 'This assessment has already been submitted.',
  BAD_REQUEST: 'That request could not be completed.',
  BACKEND_UNAVAILABLE: 'Cannot reach the interview service. Check your connection and try again.',
  UNKNOWN: 'Something went wrong. Please try again.'
};

export class InterviewApiError extends Error {
  public override readonly name = 'InterviewApiError';
  public readonly code: InterviewApiErrorCode;
  /** User-safe. Always use this for display. */
  public readonly userMessage: string;
  public readonly status: number;
  /** Whether retrying the same request could plausibly succeed. */
  public readonly retryable: boolean;

  constructor(code: InterviewApiErrorCode, status: number) {
    super(`InterviewApiError(${code})`);
    this.code = code;
    this.status = status;
    this.userMessage = USER_MESSAGE[code];
    this.retryable = code === 'BACKEND_UNAVAILABLE' || code === 'UNKNOWN';
  }
}

function readBackendCode(error: HttpErrorResponse): string {
  const body = error.error as ApiErrorBodyDto | string | null;
  if (body && typeof body === 'object' && typeof body.error?.code === 'string') {
    return body.error.code;
  }
  return '';
}

/**
 * Map an HttpErrorResponse onto a typed error.
 *
 * `status === 0` means the request never reached the server — offline, DNS
 * failure, CORS rejection or a stopped backend. That is reported as
 * BACKEND_UNAVAILABLE so the UI can offer a retry rather than implying the
 * session is invalid.
 */
export function toInterviewApiError(error: unknown): InterviewApiError {
  if (error instanceof InterviewApiError) return error;

  if (!(error instanceof HttpErrorResponse)) {
    return new InterviewApiError('UNKNOWN', 0);
  }

  if (error.status === 0) return new InterviewApiError('BACKEND_UNAVAILABLE', 0);

  const backendCode = readBackendCode(error);

  // The backend distinguishes an expired assessment from an ordinary conflict
  // using the error CODE; both are 409, so the status alone is not enough.
  if (backendCode === 'SESSION_EXPIRED') return new InterviewApiError('SESSION_EXPIRED', error.status);

  switch (error.status) {
    case 400:
      return new InterviewApiError('BAD_REQUEST', 400);
    case 401:
      return new InterviewApiError('UNAUTHORIZED', 401);
    case 409:
      return new InterviewApiError('CONFLICT', 409);
    case 404:
      // No Interview route 404s for a real session, so treat it as a dead
      // reference rather than a distinct state.
      return new InterviewApiError('UNAUTHORIZED', 404);
    default:
      if (error.status >= 500) return new InterviewApiError('BACKEND_UNAVAILABLE', error.status);
      return new InterviewApiError('UNKNOWN', error.status);
  }
}
