import { computed, DestroyRef, Service, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { combineLatest, Observable, of, Subscription } from 'rxjs';
import { distinctUntilChanged } from 'rxjs/operators';

@Service()
export class NextButtonStateService {
  // ── signals ─────────────────────────────────────────────────────
  readonly isButtonEnabled = signal<boolean>(false);
  public isButtonEnabled$ = toObservable(this.isButtonEnabled);

  // ── computed ────────────────────────────────────────────────────
  // Reactive style derived from the enabled signal — auto-recomputes
  // whenever isButtonEnabled changes.
  readonly nextButtonStyleSig = computed<{ [key: string]: string }>(() => ({
    opacity: this.isButtonEnabled() ? '1' : '0.5',
    cursor: this.isButtonEnabled() ? 'pointer' : 'not-allowed',
    'pointer-events': 'auto'
  }));

  // ── properties ──────────────────────────────────────────────────
  private nextButtonStateSubscription?: Subscription;
  private initialized = false;

  // When > 0, the reactive stream cannot disable the button.
  // Decremented by a timer so it auto-expires.
  private _forceHoldUntil = 0;

  // ── public methods ──────────────────────────────────────────────
  public initializeNextButtonStateStream(
    isAnswered$: Observable<boolean>,
    isLoading$: Observable<boolean>,
    isNavigating$: Observable<boolean>,
    destroyRef: DestroyRef,
    interactionReady$?: Observable<boolean>
  ): void {
    if (this.initialized) return;

    this.initialized = true;

    const ready$ = interactionReady$ ?? of(true);

    this.nextButtonStateSubscription = combineLatest([
      isAnswered$,
      isLoading$,
      isNavigating$,
      ready$
    ])
      .pipe(
        takeUntilDestroyed(destroyRef), // Cleanup when component is destroyed
        distinctUntilChanged(
          ([a1, b1, c1, d1], [a2, b2, c2, d2]) => a1 === a2 && b1 === b2 && c1 === c2 && d1 === d2
        )
      )
      .subscribe(([isAnswered, isLoading, isNavigating, ready]) => {
        const enabled = isAnswered && !isLoading && !isNavigating && !!ready;
        // If the button was force-held enabled, don't let the stream disable it
        if (!enabled && Date.now() < this._forceHoldUntil) return;
        this.updateAndSyncNextButtonState(enabled);
      });
  }

  public cleanupNextButtonStateStream(): void {
    this.nextButtonStateSubscription?.unsubscribe();
    this.nextButtonStateSubscription = undefined;
    this.initialized = false;
  }

  public evaluateNextButtonState(
    isAnswered: boolean,
    isLoading: boolean,
    isNavigating: boolean
  ): boolean {
    const shouldEnable = isAnswered && !isLoading && !isNavigating;
    if (!shouldEnable && Date.now() < this._forceHoldUntil) return true;

    this.updateAndSyncNextButtonState(shouldEnable);
    return shouldEnable;
  }

  public updateAndSyncNextButtonState(isEnabled: boolean): void {
    this.isButtonEnabled.set(isEnabled);
    // nextButtonStyleSig auto-derives from isButtonEnabled via computed()
  }

  public setNextButtonState(enabled: boolean): void {
    if (enabled) this._forceHoldUntil = Date.now() + 300;
    this.updateAndSyncNextButtonState(enabled);
  }

  /**
   * Force-enable the button and prevent the reactive stream from
   * disabling it for `durationMs` milliseconds.
   */
  public forceEnable(durationMs = 500): void {
    this._forceHoldUntil = Date.now() + durationMs;
    this.updateAndSyncNextButtonState(true);
  }

  reset(): void {
    this._forceHoldUntil = 0;
    this.setNextButtonState(false);
  }
}
