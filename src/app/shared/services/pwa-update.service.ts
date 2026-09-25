import { DestroyRef, inject, Service } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { interval } from 'rxjs';
import { filter } from 'rxjs/operators';

import { reportError } from '@shared/utils/error-logging';

/**
 * Keeps deployed users on a fresh bundle. The service worker (registered in
 * main.ts) caches assets for offline/installable use, but that means a redeploy
 * is invisible until the SW downloads the new version. On VERSION_READY this
 * prompts the user to reload onto it. It checks once immediately on init so a
 * fresh deploy is caught on load, and polls hourly so long-open tabs pick up a
 * later deploy. No-op when the SW is disabled (dev / unsupported).
 */
@Service()
export class PwaUpdateService {
  // ----- injects -----
  private readonly destroyRef = inject(DestroyRef);
  private readonly swUpdate = inject(SwUpdate);

  // ----- props -----
  private readonly CHECK_INTERVAL_MS = 60 * 60 * 1000;  // hourly

  // ----- public -----
  init(): void {
    if (!this.swUpdate.isEnabled) {
      return;
    }
    this.promptOnVersionReady();
    this.pollForUpdates();
    this.checkNow();
  }

  // ----- private -----
  private promptOnVersionReady(): void {
    this.swUpdate.versionUpdates
      .pipe(
        filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY'),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe(() => this.activateAndReload());
  }

  private checkNow(): void {
    this.swUpdate
      .checkForUpdate()
      .catch((err: unknown) => reportError('PwaUpdateService.checkNow', err));
  }

  private pollForUpdates(): void {
    interval(this.CHECK_INTERVAL_MS)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.swUpdate
          .checkForUpdate()
          .catch((err: unknown) => reportError('PwaUpdateService.checkForUpdate', err));
      });
  }

  private activateAndReload(): void {
    // Silent auto-reload: activate the freshly downloaded version and reload
    // straight onto it, with no confirm prompt. The owner opted into this so a
    // new deploy is picked up automatically (no manual refresh / cache clearing).
    this.swUpdate
      .activateUpdate()
      .then(() => document.location.reload())
      .catch((err: unknown) => reportError('PwaUpdateService.activateUpdate', err));
  }
}
