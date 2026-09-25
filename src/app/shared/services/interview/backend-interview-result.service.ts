import { computed, inject, Service, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { InterviewApiService } from '@shared/services/api/interview-api.service';
import { InterviewApiError } from '@shared/services/api/interview-api.errors';
import { BackendInterviewSessionService } from './backend-interview-session.service';
import { InterviewSessionReferenceStorage } from './interview-session-reference.storage';
import { toSanitizedAttempt } from './interview-result-history.adapter';
import { AssessmentIntegrityService } from '@shared/services/features/interview/assessment-integrity.service';
import { InterviewHistoryService } from '@shared/services/features/interview/interview-history.service';
import type { InterviewResultViewModel } from '@shared/models/interview/interview-view-models';

/**
 * Loads and owns the SUBMITTED interview result.
 *
 * ONE pipeline, used by both the guard and the Results page, so a navigation
 * never issues two `GET /result` requests. The component reads whatever the
 * guard already loaded.
 *
 * The result is held in MEMORY only. It is re-fetched from the backend after a
 * refresh using the minimal v2 session reference — which is what allows the
 * complete review to exist without a copy of the answer key on disk.
 *
 * Nothing here computes a score. There is no local fallback: if the backend
 * cannot be reached, the page says so and offers a retry rather than rendering
 * a number the server did not produce.
 */

export type ResultLoadOutcome =
  | { readonly kind: 'loaded'; readonly result: InterviewResultViewModel }
  /** No reference at all, or it names a different session than the route. */
  | { readonly kind: 'none' }
  /** Submitted-but-not-ours, or a dead token. The reference is cleared. */
  | { readonly kind: 'unauthorized' }
  /** The session is still running — there is no result yet. */
  | { readonly kind: 'not-ready' }
  /** Reachability problem. The reference is KEPT so a retry can succeed. */
  | { readonly kind: 'unavailable' }
  /** The backend answered, but with something unusable. */
  | { readonly kind: 'malformed' };

/**
 * What to do with a session the resume call reported as finished.
 *   results     the authenticated result was fetched — the finish is PROVEN
 *   builder     the credential is dead or missing — nothing to show
 *   unresolved  the result could not confirm it (still running, unreachable,
 *               malformed) — stay put in the retry state, never navigate
 */
export type FinishedVerdict =
  | { readonly kind: 'results'; readonly sessionId: string }
  | { readonly kind: 'builder' }
  | { readonly kind: 'unresolved' };

@Service()
export class BackendInterviewResultService {
  private readonly api = inject(InterviewApiService);
  private readonly session = inject(BackendInterviewSessionService);
  private readonly storage = inject(InterviewSessionReferenceStorage);
  private readonly history = inject(InterviewHistoryService);
  private readonly integrity = inject(AssessmentIntegrityService);

  private readonly _result = signal<InterviewResultViewModel | null>(null);
  private readonly _loading = signal(false);
  private readonly _error = signal<ResultLoadOutcome['kind'] | null>(null);

  /** IN MEMORY ONLY — never written to localStorage or sessionStorage. */
  readonly result = this._result.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly error = this._error.asReadonly();
  readonly hasResult = computed(() => this._result() !== null);

  /** Session id the loaded result belongs to, for route matching. */
  readonly sessionId = computed(() => this._result()?.sessionId ?? '');

  /** Loads currently on the wire, so overlapping callers share one request. */
  private readonly inFlight = new Map<string, Promise<ResultLoadOutcome>>();

  /**
   * Load the result for `sessionId`.
   *
   * Prefers the in-memory result the session service already holds from a
   * just-completed submit, so the common path (submit → navigate) issues no
   * extra request. A refresh or a direct visit falls through to `GET /result`.
   *
   * Overlapping calls for the same session share ONE request.
   */
  load(routeSessionId: string): Promise<ResultLoadOutcome> {
    const pending = this.inFlight.get(routeSessionId);
    if (pending) return pending;

    const run = this.loadOnce(routeSessionId).finally(() => {
      this.inFlight.delete(routeSessionId);
    });
    this.inFlight.set(routeSessionId, run);
    return run;
  }

  /**
   * The resume call said the stored session is submitted or expired. That is
   * only a claim: `409` means "already submitted" on THIS endpoint but a
   * different thing on others, and an expired session is not finalized until
   * something asks for its result. Ask, with the stored credential, through the
   * one shared pipeline — a fetched result is the only proof, and it is left in
   * memory so the Results route that follows issues no second request.
   *
   * Never navigates and never throws: the caller acts on the verdict.
   */
  async confirmFinished(): Promise<FinishedVerdict> {
    const reference = this.storage.read();
    if (!reference) return { kind: 'builder' };

    const outcome = await this.load(reference.sessionId);
    switch (outcome.kind) {
      case 'loaded':
        return { kind: 'results', sessionId: reference.sessionId };
      case 'unauthorized':   // load() already dropped the dead reference
      case 'none':
        return { kind: 'builder' };
      default:               // 'not-ready' | 'unavailable' | 'malformed'
        this.session.markResumeUnresolved();
        return { kind: 'unresolved' };
    }
  }

  private async loadOnce(routeSessionId: string): Promise<ResultLoadOutcome> {
    const existing = this._result();
    if (existing && existing.sessionId === routeSessionId) {
      return { kind: 'loaded', result: existing };
    }

    // Just submitted: the session service is still holding the response.
    const submitted = this.session.result();
    if (submitted && submitted.sessionId === routeSessionId) {
      return this.adopt(submitted);
    }

    // The ONLY credential is the ACTIVE session reference in sessionStorage,
    // which dies with the tab. No durable copy exists anywhere, so once the tab
    // is gone a past review is unreachable by design and history keeps only its
    // sanitized summary.
    const active = this.storage.read();
    if (active?.sessionId !== routeSessionId) return this.fail('none');
    const token = active.sessionToken;

    this._loading.set(true);
    this._error.set(null);
    try {
      const result = await firstValueFrom(
        this.api.getResult(routeSessionId, token)
      );
      if (!isUsableResult(result)) return this.fail('malformed');
      return this.adopt(result);
    } catch (err: unknown) {
      const error = err instanceof InterviewApiError ? err : new InterviewApiError('UNKNOWN', 0);
      switch (error.code) {
        case 'UNAUTHORIZED':
          // A reference that cannot fetch its own result is dead weight.
          this.session.clearSession();
          return this.fail('unauthorized');
        case 'CONFLICT':
          // Still active. The backend finalizes an EXPIRED session inside
          // GET /result, so this really does mean "not finished yet".
          return this.fail('not-ready');
        default:
          // Reachability. Keep the reference — a dropped connection must not
          // destroy access to a completed attempt.
          return this.fail('unavailable');
      }
    } finally {
      this._loading.set(false);
    }
  }

  /** Retry after an outage, from the same single pipeline. */
  async reload(routeSessionId: string): Promise<ResultLoadOutcome> {
    this._error.set(null);
    return this.load(routeSessionId);
  }

  clear(): void {
    this._result.set(null);
    this._error.set(null);
    this._loading.set(false);
  }

  /**
   * Adopt a loaded result and record it in history exactly once.
   *
   * History is written HERE, after a valid submitted result exists, rather than
   * at submission: every route into the result — navigate, refresh, remount,
   * retry — passes through this method, and the sanitized record is keyed by
   * `sessionId`, so repeated loads collapse to one entry.
   */
  private adopt(result: InterviewResultViewModel): ResultLoadOutcome {
    this._result.set(result);
    this._error.set(null);

    this.history.recordAttempt(
      // focusChanges is client-observed: never sent to the backend, never part
      // of the score, retained only as an aggregate.
      toSanitizedAttempt(result, this.integrity.focusLossCount())
    );
    return { kind: 'loaded', result };
  }

  private fail(kind: Exclude<ResultLoadOutcome['kind'], 'loaded'>): ResultLoadOutcome {
    this._error.set(kind);
    return { kind };
  }
}

/**
 * Structural sanity check. The backend validates its own invariants, so this
 * only guards against a response that is not a result at all (a proxy error
 * page, a truncated body) being rendered as one.
 */
function isUsableResult(result: InterviewResultViewModel | null | undefined): boolean {
  return (
    !!result &&
    typeof result.sessionId === 'string' &&
    result.sessionId.length > 0 &&
    Number.isFinite(result.total) &&
    Number.isFinite(result.percentage) &&
    Array.isArray(result.review) &&
    Array.isArray(result.byTopic)
  );
}
