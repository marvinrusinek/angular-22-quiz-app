import { TestBed } from '@angular/core/testing';
import { SwUpdate, VersionEvent, VersionReadyEvent } from '@angular/service-worker';
import { Subject } from 'rxjs';

import { PwaUpdateService } from './pwa-update.service';

/**
 * Unit coverage for the PWA update flow (added 2026-06-14). Mocks SwUpdate with
 * a Subject for versionUpdates so VERSION_READY can be driven deterministically,
 * and fake timers so the hourly poll can be advanced. Confirms the service:
 *  - no-ops entirely when the SW is disabled (dev / unsupported),
 *  - activates the update SILENTLY on VERSION_READY (no confirm prompt),
 *  - ignores version events other than VERSION_READY,
 *  - polls checkForUpdate on the interval.
 *
 * Note: the post-activate document.location.reload() is not asserted — jsdom's
 * window.location is non-configurable and location.reload is read-only, so it
 * cannot be spied. The confirm test keeps activateUpdate pending so reload is
 * never reached; the meaningful contract (prompt → activate decision) is what's
 * pinned here.
 */
const HOUR_MS = 60 * 60 * 1000;
const versionReady = { type: 'VERSION_READY' } as unknown as VersionReadyEvent;

describe('PwaUpdateService', () => {
  let service: PwaUpdateService;
  let versionUpdates$: Subject<VersionEvent>;
  let swUpdateMock: any;
  let confirmSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();

    versionUpdates$ = new Subject<VersionEvent>();
    swUpdateMock = {
      isEnabled: true,
      versionUpdates: versionUpdates$,
      activateUpdate: jest.fn().mockResolvedValue(true),
      checkForUpdate: jest.fn().mockResolvedValue(true)
    };

    confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);

    TestBed.configureTestingModule({
      providers: [PwaUpdateService, { provide: SwUpdate, useValue: swUpdateMock }]
    });
    service = TestBed.inject(PwaUpdateService);
  });

  afterEach(() => {
    confirmSpy.mockRestore();
    TestBed.resetTestingModule();
    jest.useRealTimers();
  });

  it('is a no-op when the service worker is disabled', () => {
    swUpdateMock.isEnabled = false;

    service.init();
    versionUpdates$.next(versionReady);
    jest.advanceTimersByTime(HOUR_MS);

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(swUpdateMock.activateUpdate).not.toHaveBeenCalled();
    expect(swUpdateMock.checkForUpdate).not.toHaveBeenCalled();
  });

  it('activates the update SILENTLY on VERSION_READY (no confirm prompt)', () => {
    // Keep activation pending so the post-activate reload() is never reached
    // (location.reload is unmockable in jsdom).
    swUpdateMock.activateUpdate.mockReturnValue(new Promise<boolean>(() => {}));

    service.init();
    versionUpdates$.next(versionReady);

    // Silent auto-reload: no prompt, activate straight away.
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(swUpdateMock.activateUpdate).toHaveBeenCalledTimes(1);
  });

  it('ignores version events other than VERSION_READY', () => {
    service.init();
    versionUpdates$.next({ type: 'NO_NEW_VERSION_DETECTED' } as VersionEvent);

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(swUpdateMock.activateUpdate).not.toHaveBeenCalled();
  });

  it('checks for an update immediately on init', () => {
    service.init();
    expect(swUpdateMock.checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it('checks for updates on the hourly interval', () => {
    service.init();
    // One immediate check fires on init; the interval adds one per hour.
    expect(swUpdateMock.checkForUpdate).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(HOUR_MS);
    expect(swUpdateMock.checkForUpdate).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(HOUR_MS);
    expect(swUpdateMock.checkForUpdate).toHaveBeenCalledTimes(3);
  });
});
