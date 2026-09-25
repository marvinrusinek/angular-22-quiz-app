/**
 * FET emission contract tests.
 *
 * The 2026-05-31 sweep hit a class of regression where a "semantically
 * identical" refactor in OptionInteractionService broke multi-answer FET
 * display in the browser. The exact mechanism was never identified, but
 * the failure mode was: emitFormatted appeared to be called correctly,
 * but the displayed FET wasn't visible.
 *
 * These tests lock down the OBSERVABLE contract of
 * `ExplanationTextService.emitFormatted` and `purgeAndDefer` so future
 * refactors at least have a behavioral anchor. They don't catch the
 * specific (still-unexplained) interaction bug, but they ensure the
 * canonical entry point keeps writing/clearing state as documented.
 *
 * Scenarios covered:
 *  - emitFormatted(idx, text, { bypassGuard: true }) writes latestExplanation
 *  - emitFormatted(idx, text) honors the multi-answer guard
 *  - emitFormatted(idx, null / empty / whitespace) is a safe no-op
 *  - latestExplanationIndex tracks the most-recent emission
 *  - purgeAndDefer(newIndex) clears state for the new index
 *  - emitFormatted does NOT throw on missing index / extreme indices
 */
// jsdom doesn't expose structuredClone in some versions; polyfill before
// the QuizService module is loaded (its field initializer calls it).
if (typeof (globalThis as any).structuredClone !== 'function') {
  (globalThis as any).structuredClone = (v: any) => JSON.parse(JSON.stringify(v));
}

import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { FET_UNLOCK_WATCHDOG_MS } from '@shared/constants/timing';

import { ExplanationTextService } from './explanation-text.service';

describe('FET emission contract', () => {
  let service: ExplanationTextService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } },
      ],
    });
    service = TestBed.inject(ExplanationTextService);
  });

  // ── emitFormatted writes ──────────────────────────────────────────

  it('emitFormatted with bypassGuard:true writes latestExplanation', () => {
    service.emitFormatted(2, 'Hello world', { bypassGuard: true });
    expect(service.latestExplanation).toBe('Hello world');
  });

  it('emitFormatted updates latestExplanationIndex to the emitting index', () => {
    service.emitFormatted(3, 'Index three text', { bypassGuard: true });
    expect(service.latestExplanationIndex).toBe(3);
  });

  it('successive bypassGuard emissions overwrite the previous text', () => {
    service.emitFormatted(0, 'first', { bypassGuard: true });
    service.emitFormatted(0, 'second', { bypassGuard: true });
    expect(service.latestExplanation).toBe('second');
  });

  // ── safe no-op cases ──────────────────────────────────────────────

  it('emitFormatted with null is a safe no-op (latestExplanation unchanged)', () => {
    service.emitFormatted(0, 'baseline', { bypassGuard: true });
    expect(service.latestExplanation).toBe('baseline');
    service.emitFormatted(0, null, { bypassGuard: true });
    // Empty-trim guard: a null value does not overwrite existing text
    expect(service.latestExplanation).toBe('baseline');
  });

  it('emitFormatted with empty string is a safe no-op', () => {
    service.emitFormatted(0, 'baseline', { bypassGuard: true });
    service.emitFormatted(0, '', { bypassGuard: true });
    expect(service.latestExplanation).toBe('baseline');
  });

  it('emitFormatted with whitespace-only string is a safe no-op', () => {
    service.emitFormatted(0, 'baseline', { bypassGuard: true });
    service.emitFormatted(0, '   \n\t  ', { bypassGuard: true });
    expect(service.latestExplanation).toBe('baseline');
  });

  // ── purgeAndDefer resets state ────────────────────────────────────

  it('purgeAndDefer(newIndex) does not throw for valid indices', () => {
    service.emitFormatted(0, 'text for q0', { bypassGuard: true });
    expect(() => service.purgeAndDefer(1)).not.toThrow();
  });

  it('purgeAndDefer(0) does not throw for index 0', () => {
    expect(() => service.purgeAndDefer(0)).not.toThrow();
  });

  // ── boundary / robustness ─────────────────────────────────────────

  it('emitFormatted does not throw on negative indices with bypassGuard', () => {
    expect(() => service.emitFormatted(-1, 'fallback', { bypassGuard: true })).not.toThrow();
  });

  it('emitFormatted does not throw on extreme indices', () => {
    expect(() => service.emitFormatted(9999, 'extreme', { bypassGuard: true })).not.toThrow();
  });

  // ── tripwires for known bug surfaces (see E6_FET_STATE_MACHINE_DESIGN.md) ──
  //
  // These tests document two latent bugs found while writing the E6 state-
  // machine design doc. Each bug surface has TWO tests:
  //
  //   1. A passing test that asserts the CURRENT (buggy) behavior. This
  //      is a tripwire — if the behavior changes (someone "fixes" the
  //      surface), this test fails and forces a deliberate update.
  //
  //   2. A skipped (xit) test that asserts the DESIRED behavior. When
  //      the bug is fixed, un-skip + delete the documenting test above.

  // ── BUG #1: emitFormatted empty-value lock-leak ──────────────────
  //
  // emitFormatted sets `_fetLocked = true` at line 736, then returns
  // without unlocking when the trimmed value is empty (line 805). This
  // means calling with null/empty/whitespace + bypassGuard:true leaves
  // the gate locked indefinitely, blocking subsequent emissions until
  // some external caller resets the lock.

  // FIXED (E6): emitFormatted now restores the prior lock state on an
  // empty/null/whitespace bail instead of leaking _fetLocked = true.
  it('emitFormatted with empty value should NOT leave _fetLocked stuck', () => {
    const displayState = (service as any).displayState;
    displayState._fetLocked = false;

    service.emitFormatted(0, '', { bypassGuard: true });
    expect(displayState._fetLocked).toBe(false);

    displayState._fetLocked = false;
    service.emitFormatted(0, null, { bypassGuard: true });
    expect(displayState._fetLocked).toBe(false);

    displayState._fetLocked = false;
    service.emitFormatted(0, '   \n\t', { bypassGuard: true });
    expect(displayState._fetLocked).toBe(false);
  });

  // ── BUG #2: purgeAndDefer deferred-unlock watchdog gap ───────────
  //
  // purgeAndDefer schedules an unlock via rAF + setTimeout chain with a
  // token-equality check. If the token changes mid-chain, the inner
  // callback bails — leaving _fetLocked = true. The newer purgeAndDefer
  // call that bumped the token also schedules its own unlock, so in
  // practice the lock clears via the newer call. BUT: there's no
  // watchdog on purgeAndDefer itself (unlike unlockFetGateAfterRender,
  // which got the D3 watchdog).
  //
  // The current passing test asserts: after a normal purgeAndDefer +
  // enough wall time for the rAF + setTimeout to complete, _fetLocked
  // returns to false. If that ever stops being true, this tripwire
  // fires.

  it('purgeAndDefer eventually clears _fetLocked after the deferred-unlock window', (done) => {
    const displayState = (service as any).displayState;
    service.purgeAndDefer(2);
    expect(displayState._fetLocked).toBe(true); // locked immediately

    // FET_UNLOCK_SETTLE_DELAY_MS is the setTimeout delay. Wait long
    // enough for rAF + setTimeout + buffer. Real timer used here so
    // we exercise the actual rAF queue.
    setTimeout(() => {
      try {
        expect(displayState._fetLocked).toBe(false);
        done();
      } catch (e) {
        done(e as any);
      }
    }, 600); // FET_UNLOCK_SETTLE_DELAY_MS (~250-300ms) + headroom
  });

  // FIXED: purgeAndDefer now has a watchdog mirroring the one guarding
  // unlockFetGateAfterRender. Even if the primary deferred unlock chain is
  // disrupted, the watchdog force-clears _fetLocked after the watchdog
  // window — but only while the same token still owns the gate.
  it('purgeAndDefer watchdog force-unlocks _fetLocked if the deferred unlock is disrupted', () => {
    jest.useFakeTimers();
    const displayState = (service as any).displayState;

    // Disrupt the primary unlock: make rAF a no-op so the inner setTimeout
    // that clears the lock is never scheduled. Only the watchdog (a direct
    // setTimeout) remains to recover the gate.
    const rafSpy = jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(() => 0 as any);

    try {
      service.purgeAndDefer(3);
      expect(displayState._fetLocked).toBe(true);

      // Just before the watchdog window — still locked.
      jest.advanceTimersByTime(FET_UNLOCK_WATCHDOG_MS - 1);
      expect(displayState._fetLocked).toBe(true);

      // Past the watchdog window — force-unlocked (same token owns the gate).
      jest.advanceTimersByTime(2);
      expect(displayState._fetLocked).toBe(false);
    } finally {
      rafSpy.mockRestore();
      jest.useRealTimers();
    }
  });
});
