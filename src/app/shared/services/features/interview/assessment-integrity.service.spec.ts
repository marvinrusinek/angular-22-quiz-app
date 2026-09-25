import { DestroyRef } from '@angular/core';

import { AssessmentIntegrityService } from './assessment-integrity.service';
import { SK_ASSESSMENT_INTEGRITY } from '@shared/constants/session-keys';

/**
 * Unit tests for the Assessment Integrity DETERRENT (Interview Mode only).
 * Verifies: single-increment per focus loss, no double-count from a paired
 * blur+visibilitychange, separate episodes, fullscreen-exit handling,
 * persistence/resume, reset, and listener cleanup on destroy.
 */
describe('AssessmentIntegrityService', () => {
  let destroyCallbacks: (() => void)[];
  let destroyRef: DestroyRef;

  function makeDestroyRef(): DestroyRef {
    destroyCallbacks = [];
    return {
      onDestroy: (fn: () => void) => {
        destroyCallbacks.push(fn);
        return () => {};
      }
    } as unknown as DestroyRef;
  }

  function triggerDestroy(): void {
    for (const fn of destroyCallbacks) fn();
  }

  function setVisibility(state: 'visible' | 'hidden'): void {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => state
    });
  }

  function setFullscreenElement(el: Element | null): void {
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => el
    });
  }

  beforeEach(() => {
    sessionStorage.clear();
    setVisibility('visible');
    setFullscreenElement(null);
    destroyRef = makeDestroyRef();
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  it('starts at zero with no pending warning', () => {
    const svc = new AssessmentIntegrityService();
    expect(svc.focusLossCount()).toBe(0);
    expect(svc.warningPending()).toBe(false);
  });

  it('counts a single tab-switch (visibility hidden) as ONE and sets a pending warning', () => {
    const svc = new AssessmentIntegrityService();
    svc.activate(destroyRef);

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    expect(svc.focusLossCount()).toBe(1);
    expect(svc.warningPending()).toBe(true);
  });

  it('does NOT double-count a paired blur + visibilitychange for one action', () => {
    const svc = new AssessmentIntegrityService();
    svc.activate(destroyRef);

    // Both fire for a single tab switch.
    window.dispatchEvent(new Event('blur'));
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    expect(svc.focusLossCount()).toBe(1);
  });

  it('counts separate away/return episodes', () => {
    const svc = new AssessmentIntegrityService();
    svc.activate(destroyRef);

    // Episode 1
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    // Return
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    // Episode 2
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    expect(svc.focusLossCount()).toBe(2);
  });

  it('emits warningOnReturn$ when the user returns with a pending warning', () => {
    const svc = new AssessmentIntegrityService();
    svc.activate(destroyRef);
    const spy = jest.fn();
    svc.warningOnReturn$.subscribe(spy);

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(spy).not.toHaveBeenCalled();   // no dialog while away

    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(spy).toHaveBeenCalledTimes(1);  // shown on return
  });

  it('acknowledgeWarning clears the pending flag', () => {
    const svc = new AssessmentIntegrityService();
    svc.activate(destroyRef);
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(svc.warningPending()).toBe(true);

    svc.acknowledgeWarning();
    expect(svc.warningPending()).toBe(false);
  });

  it('treats a fullscreen EXIT during the assessment as one integrity event', () => {
    const svc = new AssessmentIntegrityService();
    // Enter fullscreen first so the service knows we were in it.
    setFullscreenElement(document.documentElement);
    svc.activate(destroyRef);
    document.dispatchEvent(new Event('fullscreenchange'));   // now in fullscreen
    expect(svc.focusLossCount()).toBe(0);

    // Exit fullscreen.
    setFullscreenElement(null);
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(svc.focusLossCount()).toBe(1);
  });

  it('persists the count and a fresh instance restores it (resume)', () => {
    const a = new AssessmentIntegrityService();
    a.activate(destroyRef);
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(a.focusLossCount()).toBe(1);
    expect(sessionStorage.getItem(SK_ASSESSMENT_INTEGRITY)).toBeTruthy();

    // Simulate a refresh: a brand-new service instance rehydrates from storage.
    const b = new AssessmentIntegrityService();
    expect(b.focusLossCount()).toBe(1);
    expect(b.warningPending()).toBe(true);
  });

  it('reset() clears the count, the pending warning, and storage', () => {
    const svc = new AssessmentIntegrityService();
    svc.activate(destroyRef);
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(svc.focusLossCount()).toBe(1);

    svc.reset();
    expect(svc.focusLossCount()).toBe(0);
    expect(svc.warningPending()).toBe(false);
    expect(sessionStorage.getItem(SK_ASSESSMENT_INTEGRITY)).toBeNull();
  });

  it('stops counting after the session component is destroyed (listener cleanup)', () => {
    const svc = new AssessmentIntegrityService();
    svc.activate(destroyRef);

    triggerDestroy();   // component destroyed → listeners torn down, counting off

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('blur'));

    expect(svc.focusLossCount()).toBe(0);
  });

  it('does not count before activate()', () => {
    const svc = new AssessmentIntegrityService();
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('blur'));
    expect(svc.focusLossCount()).toBe(0);
  });
});
