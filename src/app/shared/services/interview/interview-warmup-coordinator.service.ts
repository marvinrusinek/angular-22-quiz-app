import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { catchError, finalize, map, Observable, of, shareReplay, tap } from 'rxjs';

import { INTERVIEW_API_BASE_URL } from '@shared/tokens/api-base-url.token';

/**
 * App-lifecycle-scoped coordinator for the Spring free-tier container
 * wake-up ping (`GET /api/health`).
 *
 * Two components can each be the FIRST place a user reaches on a given
 * visit — `QuizSelectionComponent` (Node-owned, but the earliest possible
 * screen) and `BuildYourInterviewComponent` (Spring-owned, the Interview
 * entry point). Both want to give Spring's free-tier container a head
 * start before `Start Assessment`, but neither should fire its OWN
 * independent ping — that would be two unrelated `/api/health` requests
 * for the same purpose, one of them always wasted. This service is the ONE
 * place that request is made, shared by every caller.
 *
 * Root-provided (`@Service()` = `providedIn: 'root'`), so its state is
 * naturally scoped to the whole application's lifetime — it is never reset
 * by navigation or by any one component's destruction, only by a full page
 * reload (a fresh injector). Semantics:
 *
 *  - idle       → issues exactly one `GET /health`, remembers it as in-flight
 *  - in-flight  → every caller during this window gets the SAME observable
 *    (no second request), via `shareReplay({ refCount: false })` — the
 *    `refCount: false` is deliberate: an ordinary `shareReplay` tears down
 *    (and, worse here, RE-SUBSCRIBES on the next caller, firing a second
 *    HTTP request) when its subscriber count drops to zero, which is
 *    exactly what would happen if the initiating component were destroyed
 *    before the ping resolved. `refCount: false` keeps the shared
 *    observable connected to the underlying HTTP call regardless of how
 *    many subscribers remain, so a component's destruction can never
 *    cancel the in-flight app-level warm-up.
 *  - success    → cached as complete for the rest of this application's
 *    lifetime (this in-memory instance never resets outside a full reload)
 *    — no later caller ever issues another request.
 *  - failure/timeout → the opposite of success: NEVER cached. The in-flight
 *    reference is cleared so exactly one LATER caller (typically the
 *    Builder's own fallback, if Quiz Selection's earlier attempt is what
 *    failed) can issue a fresh attempt. A failure can never permanently
 *    poison this coordinator into never trying again.
 *
 * Deliberately does NOT go through `InterviewApiService.warmUp()`: that
 * method intentionally swallows every failure before it ever reaches its
 * caller (see its own doc comment — established, tested behavior this task
 * must not change), which is exactly the information this coordinator
 * needs internally to implement the failure-resets-for-one-retry semantics
 * above. Reproducing the same small, anonymous, header-less, body-less GET
 * here — identical in shape to `warmUp()`'s own request — is simpler and
 * safer than reshaping that already-audited service's public contract.
 * This coordinator's OWN public method never errors either, for the same
 * reason `warmUp()` doesn't: nothing downstream may ever treat `/health`
 * as a readiness signal, or show a user-facing error for a best-effort
 * wake-up ping outside Interview Mode.
 *
 * No timer, interval, polling loop, visibility/focus listener, or
 * service-worker involvement of any kind — one request per successful
 * outcome, at most one retry per failed outcome, nothing more.
 */
@Service()
export class InterviewWarmupCoordinatorService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(INTERVIEW_API_BASE_URL);

  private inFlight: Observable<void> | null = null;
  private succeeded = false;

  /** Mirrors InterviewApiService's own guard — see its doc comment. */
  private get configured(): boolean {
    return this.baseUrl.trim().length > 0;
  }

  /**
   * Ensure Spring's container is being (or has already been) warmed. Safe
   * to call from any number of components, any number of times, in any
   * order — see the class doc comment for the full sharing/reset
   * semantics. Never errors, never rejects: a failed or timed-out ping
   * resolves to `undefined`, indistinguishable from success to the caller,
   * exactly like `InterviewApiService#warmUp()`.
   */
  warmUp(): Observable<void> {
    if (!this.configured || this.succeeded) return of(undefined);
    if (this.inFlight) return this.inFlight;

    let ok = false;
    this.inFlight = this.http.get(`${this.baseUrl}/health`).pipe(
      map(() => undefined),
      tap(() => {
        ok = true;
      }),
      catchError(() => of(undefined)),
      finalize(() => {
        if (ok) {
          // Success is permanent for this application lifecycle — no
          // in-memory reset short of a full reload creates a fresh
          // coordinator instance.
          this.succeeded = true;
        } else {
          // Failure/timeout is NEVER cached — clear so exactly one later
          // caller can retry. Deliberately not `succeeded = false` (it
          // already is) — this only ever needs to clear `inFlight`.
          this.inFlight = null;
        }
      }),
      shareReplay({ bufferSize: 1, refCount: false })
    );
    return this.inFlight;
  }
}
