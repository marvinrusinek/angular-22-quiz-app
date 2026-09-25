import { DestroyRef, Service, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { fromEvent, Subject } from 'rxjs';

import { AssessmentIntegrityState } from '@shared/models/AssessmentIntegrityState.model';
import { SK_ASSESSMENT_INTEGRITY } from '@shared/constants/session-keys';
import { swallow } from '@shared/utils/error-logging';
import { readSessionJson, removeSessionKey, writeSessionJson } from '@shared/utils/session-storage';

/**
 * Assessment Integrity Mode — a browser-based DETERRENT for Interview/Assessment
 * Mode ONLY. It discourages copying questions and leaving the assessment to look
 * up answers; it does NOT (and cannot) prevent opening another window, tab,
 * device, or connection, and it never fails/submits/resets the assessment.
 *
 * Owns the focus-loss count + pending-warning flag as signals, persisted to its
 * OWN sessionStorage key so a refresh/resume keeps the count. All document/window
 * listeners are registered through `activate(destroyRef)` and torn down via
 * `takeUntilDestroyed(destroyRef)` when the InterviewSessionComponent is
 * destroyed — nothing global survives leaving the session. NEVER touches
 * topic-quiz progress/achievements/scores.
 */
@Service()
export class AssessmentIntegrityService {
  // Coalesce a paired blur + visibilitychange (fired for one action) so a single
  // tab-switch counts ONCE.
  private static readonly COALESCE_MS = 500;

  // ── state (signals) ─────────────────────────────────────────────
  private readonly _focusLossCount = signal(0);
  readonly focusLossCount = this._focusLossCount.asReadonly();

  private readonly _warningPending = signal(false);
  readonly warningPending = this._warningPending.asReadonly();

  // Whether the document is currently in fullscreen. Reactive mirror of
  // `wasFullscreen` so the session UI can show a live "Full Screen Enabled"
  // indicator, including when the user leaves fullscreen via Esc / F11 (which
  // never routes through enterFullscreen()).
  private readonly _isFullscreen = signal(false);
  readonly isFullscreen = this._isFullscreen.asReadonly();

  private _lastFocusLossAt: number | undefined;

  // ── internal flags ──────────────────────────────────────────────
  private active = false;              // listeners registered & counting enabled
  private isAway = false;              // currently blurred/hidden (transition gate)
  private recentFullscreenExitAt = 0;  // dedupe a fullscreen-exit's paired blur only
  private wasFullscreen = false;

  // Fires when the user RETURNS with a pending warning — the session component
  // opens the accessible warning dialog (it owns MatDialog).
  readonly warningOnReturn$ = new Subject<void>();

  constructor() {
    this.restore();
  }

  // ── lifecycle ───────────────────────────────────────────────────
  /**
   * Begin watching for focus loss. Called by InterviewSessionComponent.ngOnInit
   * with the component's DestroyRef so every listener is removed automatically
   * when the session screen is destroyed.
   */
  activate(destroyRef: DestroyRef): void {
    if (this.active) return;
    this.active = true;
    this.isAway = false;
    this.wasFullscreen = !!this.fullscreenElement();
    this._isFullscreen.set(this.wasFullscreen);

    fromEvent(document, 'visibilitychange')
      .pipe(takeUntilDestroyed(destroyRef))
      .subscribe(() => (document.visibilityState === 'hidden' ? this.registerLeave() : this.registerReturn()));

    fromEvent(window, 'blur')
      .pipe(takeUntilDestroyed(destroyRef))
      .subscribe(() => this.registerLeave());

    fromEvent(window, 'focus')
      .pipe(takeUntilDestroyed(destroyRef))
      .subscribe(() => this.registerReturn());

    fromEvent(document, 'fullscreenchange')
      .pipe(takeUntilDestroyed(destroyRef))
      .subscribe(() => this.onFullscreenChange());

    // When the session component is destroyed, disable counting so a later
    // re-entry can re-register cleanly. (The listeners themselves are already
    // torn down by takeUntilDestroyed.)
    destroyRef.onDestroy(() => (this.active = false));
  }

  /** Stop counting (listeners are removed via the DestroyRef passed to activate). */
  deactivate(): void {
    this.active = false;
  }

  // ── focus tracking ──────────────────────────────────────────────
  // Record one integrity episode (count + pending warning + persist).
  private bumpCount(): void {
    this._focusLossCount.update((n) => n + 1);
    this._lastFocusLossAt = Date.now();
    this._warningPending.set(true);
    this.persist();
  }

  /**
   * A tab/window focus loss (visibility→hidden or window blur). Counted ONCE per
   * "away" episode: the `isAway` flag dedupes the paired blur + visibilitychange
   * that fire for a single switch; a short window after a fullscreen exit dedupes
   * that exit's own paired blur (if the browser emits one).
   */
  private registerLeave(): void {
    if (!this.active || this.isAway) return;
    if (Date.now() - this.recentFullscreenExitAt < AssessmentIntegrityService.COALESCE_MS) {
      this.isAway = true;   // already counted via the fullscreen-exit path
      return;
    }
    this.isAway = true;
    this.bumpCount();
  }

  /** Focus regained — surface the warning if one is pending. */
  private registerReturn(): void {
    if (!this.active) return;
    this.isAway = false;
    if (this._warningPending()) {
      this.warningOnReturn$.next();
    }
  }

  private onFullscreenChange(): void {
    if (!this.active) return;
    const inFs = !!this.fullscreenElement();
    // Exiting fullscreen mid-assessment is an integrity event too. The user is
    // still present, so count it ONCE and surface the warning immediately. It
    // does NOT touch `isAway` (that tracks real tab/window focus), so a later
    // genuine tab-switch still counts.
    if (this.wasFullscreen && !inFs) {
      this.recentFullscreenExitAt = Date.now();
      this.bumpCount();
      this.warningOnReturn$.next();
    }
    this.wasFullscreen = inFs;
    this._isFullscreen.set(inFs);
  }

  // ── fullscreen (optional, user gesture) ─────────────────────────
  /** Request fullscreen on the given element. Resolves false if unsupported/denied. */
  enterFullscreen(el: Element): Promise<boolean> {
    const req = (el as any).requestFullscreen?.bind(el)
      ?? (el as any).webkitRequestFullscreen?.bind(el);
    if (!req) return Promise.resolve(false);
    return Promise.resolve(req())
      .then(() => { this.wasFullscreen = true; this._isFullscreen.set(true); return true; })
      .catch(() => false);
  }

  fullscreenSupported(): boolean {
    return !!(document as any).fullscreenEnabled
      || typeof (document.documentElement as any).requestFullscreen === 'function';
  }

  private fullscreenElement(): Element | null {
    return document.fullscreenElement ?? (document as any).webkitFullscreenElement ?? null;
  }

  // ── warning ─────────────────────────────────────────────────────
  /** Called after the warning dialog is dismissed. */
  acknowledgeWarning(): void {
    this._warningPending.set(false);
    this.persist();
  }

  // ── reset ───────────────────────────────────────────────────────
  /** Clear all integrity state + storage (fresh assessment / leaving Interview Mode). */
  reset(): void {
    this.active = false;
    this.isAway = false;
    this.wasFullscreen = false;
    this._isFullscreen.set(false);
    this.recentFullscreenExitAt = 0;
    this._lastFocusLossAt = undefined;
    this._focusLossCount.set(0);
    this._warningPending.set(false);
    removeSessionKey(SK_ASSESSMENT_INTEGRITY);
  }

  // ── persistence / resume ────────────────────────────────────────
  private persist(): void {
    const state: AssessmentIntegrityState = {
      focusLossCount: this._focusLossCount(),
      lastFocusLossAt: this._lastFocusLossAt,
      warningPending: this._warningPending()
    };
    writeSessionJson(SK_ASSESSMENT_INTEGRITY, state);
  }

  private restore(): void {
    try {
      const saved = readSessionJson<AssessmentIntegrityState | null>(SK_ASSESSMENT_INTEGRITY, null);
      if (!saved) return;
      this._focusLossCount.set(Math.max(0, saved.focusLossCount ?? 0));
      this._lastFocusLossAt = saved.lastFocusLossAt;
      this._warningPending.set(!!saved.warningPending);
    } catch (err: unknown) {
      swallow('assessment-integrity.service.ts', err);
    }
  }
}
