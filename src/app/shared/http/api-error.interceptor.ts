import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';

import { API_BASE_URL } from '../tokens/api-base-url.token';
import { swallow } from '../utils/error-logging';

/**
 * Centralized, DEV-ONLY diagnostic logging for requests to this app's own
 * backend API (`API_BASE_URL`).
 *
 * ── What this deliberately does NOT do ─────────────────────────────
 *
 * Every consumer of HttpClient in this app already owns its own error
 * handling: `topic-quiz-metadata.service.ts` and `topic-quiz-resources.service.ts`
 * fail SOFT to an empty list; `api-verdict.adapter.ts`, `topic-quiz-attempt.service.ts`,
 * `topic-quiz-questions.service.ts`, `practice-verdict.service.ts`, and
 * `interview-api.service.ts` fail CLOSED with their own typed, rethrown
 * error, and none of them fall back to a local answer key. This interceptor
 * does not map errors, does not retry, does not cache, does not fabricate a
 * fallback response, and does not change which of those two behaviors any
 * consumer gets — it only OBSERVES a failure long enough to log sanitized,
 * non-sensitive context, then rethrows the EXACT SAME error object so every
 * existing `.pipe(catchError(...))` downstream keeps working exactly as
 * before.
 *
 * ── What is safe to log, and what never is ──────────────────────────
 *
 * Only HTTP method, the request path with the base URL and query string
 * stripped, the HTTP status, and a coarse status classification. Never the
 * request body (selections, receipts), never response bodies, never
 * headers/tokens, never query parameters. Logging goes through `swallow()`,
 * the app's existing dev-only diagnostic logger — a no-op in production
 * builds, so this introduces no production console noise.
 */
export const apiErrorInterceptor: HttpInterceptorFn = (req, next) => {
  const apiBaseUrl = inject(API_BASE_URL);

  // Only requests to THIS app's own backend API are observed. An empty
  // apiBaseUrl (API not configured for this build) must never match every
  // request via an empty-string prefix.
  if (!apiBaseUrl || !req.url.startsWith(apiBaseUrl)) {
    return next(req);
  }

  return next(req).pipe(
    catchError((error: unknown) => {
      if (error instanceof HttpErrorResponse) {
        swallow('apiErrorInterceptor', {
          method: req.method,
          path: requestPath(req.url, apiBaseUrl),
          status: error.status,
          classification: classifyStatus(error.status)
        });
      }
      // Rethrow the ORIGINAL, untouched error — this interceptor never
      // replaces, wraps, or suppresses a failure.
      return throwError(() => error);
    })
  );
};

/** Strip the base URL and any query string; query params may carry sensitive values. */
function requestPath(url: string, apiBaseUrl: string): string {
  const withoutBase = url.startsWith(apiBaseUrl) ? url.slice(apiBaseUrl.length) : url;
  return withoutBase.split('?')[0];
}

/** A coarse, non-sensitive failure classification for diagnostics only. */
function classifyStatus(status: number): string {
  if (status === 0) return 'network-or-cors';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not-found';
  if (status >= 500) return 'server-error';
  if (status >= 400) return 'client-error';
  return 'unknown';
}
