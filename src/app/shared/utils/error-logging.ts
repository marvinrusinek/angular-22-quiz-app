import { ErrorHandler, Injectable, isDevMode } from '@angular/core';

/**
 * Centralized error visibility. The app has ~300 silent `catch {}` blocks, so
 * failures often vanish with no trace (e.g. the StackBlitz cold-load chunk-fetch
 * throw that was invisible until a catch was manually instrumented). These
 * helpers give a single, consistent place for errors to surface.
 *
 * - GlobalErrorHandler: replaces Angular's default ErrorHandler — same behavior
 *   (log to console) but one hook we control for future telemetry.
 * - installGlobalErrorLogging: in a ZONELESS app, unhandled promise rejections
 *   and uncaught window errors don't reach Angular's ErrorHandler, so listen for
 *   them directly. Pure logging — no behavior change.
 * - reportError: for the handful of HIGH-RISK catches (B) whose failures matter
 *   in production too (component load, data fetch, storage). Always logs.
 * - swallow: dev-only logging for the long tail of low-risk catches (C) — a
 *   NO-OP in a production build, so prod behaves byte-identically to today.
 */

@Injectable()
export class GlobalErrorHandler implements ErrorHandler {
  handleError(error: unknown): void {
    try {
      console.error('[GlobalError]', error);
    } catch {
      /* a handler must never throw */
    }
  }
}

/** Surface errors that escape Angular in a zoneless app (async rejections, uncaught window errors). */
export function installGlobalErrorLogging(): void {
  if (typeof window === 'undefined') return;
  try {
    window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
      try {
        console.error('[unhandledrejection]', e?.reason);
      } catch {
        /* never throw */
      }
    });
    window.addEventListener('error', (e: ErrorEvent) => {
      try {
        console.error('[window.error]', e?.error ?? e?.message);
      } catch {
        /* never throw */
      }
    });
  } catch {
    /* never throw from install */
  }
}

/** Log a caught-but-recovered error that matters in production too. Never throws. */
export function reportError(context: string, err: unknown): void {
  try {
    console.error(`[recovered] ${context}`, err);
  } catch {
    /* never throw from the logger */
  }
}

/**
 * Log a swallowed error WITHOUT changing control flow. Dev-only: a no-op in a
 * production build (isDevMode() === false), so prod behaves exactly as the old
 * silent catch did. Flip globalThis.__swallowVerbose to surface in prod.
 */
export function swallow(context: string, err: unknown): void {
  try {
    if (isDevMode() || (globalThis as any).__swallowVerbose) {
      console.debug(`[swallowed] ${context}`, err);
    }
  } catch {
    /* never throw from the logger */
  }
}
