import { computed, Service, OnDestroy, signal } from '@angular/core';
import { Subject } from 'rxjs';

import { formatMMSS } from '@shared/utils/format-time';

/**
 * Dedicated total-assessment countdown for Interview Mode — intentionally
 * SEPARATE from the per-question TimerService (which resets on navigation and
 * uses the Scoreboard font). This one starts once, survives question navigation,
 * and emits a single expiry event.
 *
 * It is timestamp-driven (`expiresAt`), so remaining time stays correct even
 * when the browser tab is inactive (interval ticks can be throttled) and it can
 * be restored after a refresh from a persisted `expiresAt`.
 */
@Service()
export class InterviewTimerService implements OnDestroy {
  private static readonly LOW_TIME_THRESHOLD = 5 * 60;   // 5 minutes

  private expiresAtMs = 0;
  private totalSeconds = 0;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private expiredEmitted = false;

  private readonly _remaining = signal<number>(0);
  readonly remainingSeconds = this._remaining.asReadonly();
  readonly formatted = computed(() => formatMMSS(this._remaining()));
  readonly isLowTime = computed(
    () => this._remaining() > 0 && this._remaining() <= InterviewTimerService.LOW_TIME_THRESHOLD
  );

  private readonly _expired = new Subject<void>();
  readonly expired$ = this._expired.asObservable();

  // ── lifecycle ───────────────────────────────────────────────────
  start(durationSeconds: number): void {
    this.begin(Date.now() + durationSeconds * 1000, durationSeconds);
  }

  // Resume after a refresh from a persisted expiry timestamp + original duration.
  restore(expiresAtMs: number, durationSeconds: number): void {
    this.begin(expiresAtMs, durationSeconds);
  }

  private begin(expiresAtMs: number, durationSeconds: number): void {
    this.clearInterval();
    this.expiresAtMs = expiresAtMs;
    this.totalSeconds = durationSeconds;
    this.expiredEmitted = false;
    this.tick();
    // Already expired on restore → the tick above emits; don't start ticking.
    if (this._remaining() > 0) {
      this.intervalId = setInterval(() => this.tick(), 1000);
    }
  }

  private tick(): void {
    const remaining = Math.max(0, Math.ceil((this.expiresAtMs - Date.now()) / 1000));
    this._remaining.set(remaining);
    if (remaining <= 0 && !this.expiredEmitted) {
      this.expiredEmitted = true;
      this.clearInterval();
      this._expired.next();
    }
  }

  // ── reads ───────────────────────────────────────────────────────
  get expiresAt(): number {
    return this.expiresAtMs;
  }

  get durationSeconds(): number {
    return this.totalSeconds;
  }

  elapsedSeconds(): number {
    return Math.max(0, this.totalSeconds - this._remaining());
  }

  // ── pause / resume (e.g. while a confirmation dialog is open) ────
  // Freeze the countdown WITHOUT finalizing it: remaining stays put.
  pause(): void {
    this.clearInterval();
  }

  // Continue after a pause: recompute the expiry from the frozen remaining so
  // the countdown resumes exactly where it left off. Returns the new expiry ms
  // (so callers can persist it for resume-after-refresh).
  resume(): number {
    if (this.expiredEmitted || this._remaining() <= 0) {
      return this.expiresAtMs;
    }
    this.expiresAtMs = Date.now() + this._remaining() * 1000;
    this.clearInterval();
    this.intervalId = setInterval(() => this.tick(), 1000);
    return this.expiresAtMs;
  }

  // ── teardown ────────────────────────────────────────────────────
  stop(): void {
    this.clearInterval();
  }

  reset(): void {
    this.clearInterval();
    this._remaining.set(0);
    this.expiresAtMs = 0;
    this.totalSeconds = 0;
    this.expiredEmitted = false;
  }

  private clearInterval(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  ngOnDestroy(): void {
    this.clearInterval();
  }
}
