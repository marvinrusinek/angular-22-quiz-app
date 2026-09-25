import { computed, DestroyRef, inject, Service, signal } from '@angular/core';
import { Subject } from 'rxjs';

import { formatMMSS } from '@shared/utils/format-time';

/**
 * DISPLAY-ONLY countdown for a backend-owned Interview session.
 *
 * The server is the sole authority on expiry. This service never persists
 * remaining time, never restores a duration from storage, and never sends a
 * value back — it only renders a number derived from what the server last said.
 *
 * The deadline is anchored to a MONOTONIC clock (`performance.now`) captured
 * when the response arrived, so the display cannot be extended by changing the
 * system clock. `remainingSeconds` from the server is the ceiling: a resume can
 * only ever lower the displayed value, never raise it.
 */
@Service()
export class BackendInterviewTimerService {
  private static readonly LOW_TIME_THRESHOLD = 60;

  private readonly _remaining = signal(0);
  private readonly _durationSeconds = signal(0);
  private intervalId: ReturnType<typeof setInterval> | null = null;

  /** Monotonic ms at which the countdown hits zero. */
  private deadlineMonotonicMs = 0;
  private expiredEmitted = false;

  private readonly _expired = new Subject<void>();
  /** Fires ONCE per session when the display reaches zero. */
  readonly expired$ = this._expired.asObservable();

  readonly remainingSeconds = this._remaining.asReadonly();
  readonly durationSeconds = this._durationSeconds.asReadonly();
  readonly formatted = computed(() => formatMMSS(this._remaining()));
  readonly isLowTime = computed(
    () => this._remaining() > 0 && this._remaining() <= BackendInterviewTimerService.LOW_TIME_THRESHOLD
  );

  /** Injectable for tests; never used to decide expiry authoritatively. */
  private now: () => number = () => performance.now();

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  /** Test seam. */
  setClock(now: () => number): void {
    this.now = now;
  }

  /**
   * (Re)start the display from a server response.
   *
   * Called on creation AND on every resume, so a refresh re-anchors to the
   * server's current remaining time rather than restarting a full duration.
   */
  syncFromServer(remainingSeconds: number, durationSeconds: number): void {
    const safeRemaining = Math.max(0, Math.floor(remainingSeconds));
    this._durationSeconds.set(Math.max(0, Math.floor(durationSeconds)));
    this.deadlineMonotonicMs = this.now() + safeRemaining * 1000;
    this.expiredEmitted = false;
    this._remaining.set(safeRemaining);

    this.stop();
    if (safeRemaining <= 0) {
      this.emitExpired();
      return;
    }
    this.intervalId = setInterval(() => this.tick(), 1000);
    this.tick();
  }

  /**
   * Recompute from the monotonic deadline rather than decrementing, so a
   * throttled background tab catches up in one step instead of drifting
   * slowly and granting extra time.
   */
  private tick(): void {
    const remaining = Math.max(0, Math.ceil((this.deadlineMonotonicMs - this.now()) / 1000));
    this._remaining.set(remaining);
    if (remaining <= 0) this.emitExpired();
  }

  private emitExpired(): void {
    if (this.expiredEmitted) return;
    this.expiredEmitted = true;
    this.stop();
    this._expired.next();
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  reset(): void {
    this.stop();
    this._remaining.set(0);
    this._durationSeconds.set(0);
    this.deadlineMonotonicMs = 0;
    this.expiredEmitted = false;
  }
}
