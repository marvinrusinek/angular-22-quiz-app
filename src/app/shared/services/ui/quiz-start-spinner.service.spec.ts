import { TestBed } from '@angular/core/testing';

import { QuizStartSpinnerService } from './quiz-start-spinner.service';

/**
 * Cold-start "Start the Quiz looks dead" fix, at the service level.
 *
 * showForStart() returns a per-attempt handle (`{ minimumElapsed, hide,
 * forceCancel }`), not a bare Promise and not a service-level method — see
 * the service's own doc comment for why: a single shared singleton, with no
 * per-attempt identity, would let a STALE hide()/forceCancel() call from a
 * superseded (or destroyed) attempt prematurely hide a NEWER attempt's
 * overlay, even one owned by a completely different component.
 */
describe('QuizStartSpinnerService', () => {
  let service: QuizStartSpinnerService;

  beforeEach(() => {
    jest.useFakeTimers();
    TestBed.configureTestingModule({ providers: [QuizStartSpinnerService] });
    service = TestBed.inject(QuizStartSpinnerService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows immediately on showForStart()', () => {
    service.showForStart();
    expect(service.visible()).toBe(true);
  });

  it('does NOT hide on its own once the minimum elapses — hide() was never called', async () => {
    service.showForStart();
    await jest.advanceTimersByTimeAsync(1600);
    expect(service.visible()).toBe(true);
  });

  it('warm case: hide() called before the minimum elapses keeps the overlay up until the minimum, then hides', async () => {
    const attempt = service.showForStart();
    attempt.hide(); // "real work" finished almost immediately
    expect(service.visible()).toBe(true); // minimum not yet elapsed

    await jest.advanceTimersByTimeAsync(1600);
    expect(service.visible()).toBe(false);
  });

  it('cold case: minimum elapses first, overlay stays up until hide() is called', async () => {
    const attempt = service.showForStart();
    await jest.advanceTimersByTimeAsync(1600);
    expect(service.visible()).toBe(true); // real work still not done

    attempt.hide();
    expect(service.visible()).toBe(false);
  });

  it("an attempt's hide() is idempotent — safe to call repeatedly", async () => {
    const attempt = service.showForStart();
    await jest.advanceTimersByTimeAsync(1600);
    attempt.hide();
    expect(service.visible()).toBe(false);

    expect(() => attempt.hide()).not.toThrow();
    expect(() => attempt.hide()).not.toThrow();
    expect(service.visible()).toBe(false);
  });

  it("showForStart()'s minimumElapsed resolves at exactly the minimum duration, independent of hide()", async () => {
    let resolved = false;
    void service.showForStart().minimumElapsed.then(() => { resolved = true; });

    await jest.advanceTimersByTimeAsync(1599);
    expect(resolved).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
  });

  it('a new showForStart() cycle, started after the previous one fully hid, behaves independently', async () => {
    const first = service.showForStart();
    await jest.advanceTimersByTimeAsync(1600);
    first.hide();
    expect(service.visible()).toBe(false);

    const second = service.showForStart(); // second attempt
    expect(service.visible()).toBe(true);
    second.hide(); // real work already done again
    expect(service.visible()).toBe(true); // minimum for THIS cycle hasn't elapsed

    await jest.advanceTimersByTimeAsync(1600);
    expect(service.visible()).toBe(false);
  });

  describe('forceCancel() — attempt-scoped, not a global reset', () => {
    it('immediately hides when the handle still owns the current attempt, bypassing the minimum', () => {
      const attempt = service.showForStart();
      attempt.forceCancel();
      expect(service.visible()).toBe(false);
    });

    it("cancels the attempt's pending timer — advancing past the minimum afterward changes nothing", async () => {
      const attempt = service.showForStart();
      attempt.forceCancel();
      await jest.advanceTimersByTimeAsync(1600);
      expect(service.visible()).toBe(false);
    });

    it('is a no-op on a handle superseded by a NEWER showForStart() — never touches the newer overlay', async () => {
      const stale = service.showForStart();
      const current = service.showForStart(); // supersedes `stale`

      stale.forceCancel();
      expect(service.visible()).toBe(true); // current's overlay is untouched

      await jest.advanceTimersByTimeAsync(1600);
      expect(service.visible()).toBe(true); // still up — current never hid itself

      current.hide();
      expect(service.visible()).toBe(false);
    });

    it('is a no-op when the attempt already completed normally (hide() already ran)', async () => {
      const attempt = service.showForStart();
      await jest.advanceTimersByTimeAsync(1600);
      attempt.hide();
      expect(service.visible()).toBe(false);

      const next = service.showForStart(); // a new, unrelated attempt
      attempt.forceCancel(); // the OLD, already-completed handle
      expect(service.visible()).toBe(true); // next's overlay is untouched

      next.hide();
      await jest.advanceTimersByTimeAsync(1600);
      expect(service.visible()).toBe(false);
    });

    it('is idempotent — safe to call repeatedly', () => {
      const attempt = service.showForStart();
      expect(() => attempt.forceCancel()).not.toThrow();
      expect(() => attempt.forceCancel()).not.toThrow();
      expect(service.visible()).toBe(false);
    });
  });

  /**
   * The EXACT scenario required by the concurrency-audit refinement: two
   * independent "components" (simulated here by two showForStart() calls
   * with no other coordination) sharing the one global overlay. Destroying
   * the OLDER one must never affect the newer one's spinner, and destroying
   * the newer one must clear it immediately.
   */
  describe('two independent owners sharing the global overlay', () => {
    it('A starts, B starts (newer), destroying A leaves B visible, destroying B clears it immediately', async () => {
      const componentA = service.showForStart('Preparing quiz…');
      const componentB = service.showForStart('Preparing Interview…'); // B supersedes A

      // Simulate component A being destroyed while its attempt is still
      // technically "in flight" from A's own point of view.
      componentA.forceCancel();
      expect(service.visible()).toBe(true); // B's spinner is untouched
      expect(service.label()).toBe('Preparing Interview…'); // still B's label

      // B's own destruction (or normal completion) clears B's spinner.
      componentB.forceCancel();
      expect(service.visible()).toBe(false);
    });

    it('A starts, B starts (newer) and finishes normally, A is destroyed afterward — no effect on the already-hidden overlay', async () => {
      const componentA = service.showForStart();
      const componentB = service.showForStart();

      await jest.advanceTimersByTimeAsync(1600);
      componentB.hide();
      expect(service.visible()).toBe(false);

      componentA.forceCancel(); // A destroyed late — must not resurrect anything
      expect(service.visible()).toBe(false);
    });
  });
});
