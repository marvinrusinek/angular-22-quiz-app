import { Service, signal } from '@angular/core';

/**
 * A single "start attempt" handle. Returned by `showForStart()` and NOT
 * interchangeable with a handle from any other call — every method on it is
 * scoped to exactly the attempt that created it, and is a no-op once a
 * NEWER `showForStart()` call has superseded it. This is what lets two
 * independent components share one global overlay safely: neither can ever
 * affect the other's attempt through a stale reference.
 */
export interface QuizStartSpinnerHandle {
  /**
   * Resolves after the minimum display duration (1600ms) — a FLOOR, not a
   * hide trigger. Callers that care about that floor (e.g. to preserve the
   * "wait one rotation before navigating" choreography for the warm case)
   * await this; it does NOT hide the overlay by itself.
   */
  readonly minimumElapsed: Promise<void>;
  /**
   * Signal that THIS attempt's real work (fetch + navigation) is done. The
   * overlay hides once the minimum duration has ALSO elapsed for THIS
   * attempt. Idempotent, and a safe no-op if a LATER `showForStart()` call
   * has already superseded this attempt — a stale handle can never hide a
   * newer attempt's overlay.
   */
  hide(): void;
  /**
   * Immediately hide — bypassing the minimum-duration floor — but ONLY if
   * this handle still owns the CURRENT attempt. A stale handle (superseded
   * by a newer `showForStart()`) is a guaranteed no-op: it must never hide
   * or otherwise affect a newer attempt's overlay. For a component's
   * destroy-time cleanup only — a destroyed component has no polished
   * transition left to protect — never for the ordinary success/failure
   * flow, which uses `hide()` instead.
   */
  forceCancel(): void;
}

/**
 * Drives the "starting the quiz"/"preparing interview" loading overlay.
 *
 * Each `showForStart()` call is its own independent, generation-stamped
 * attempt (see `QuizStartSpinnerHandle`): the overlay hides at whichever of
 * "this attempt's minimum duration" or "this attempt's real work" finishes
 * LAST, so:
 *
 *   - A warm response (data already cached, matching this service's original
 *     design assumption) behaves exactly as before: the overlay is up for
 *     one full rotation, then fades into the loaded page.
 *   - A cold response (Render/Neon still waking) keeps the overlay up for as
 *     long as it genuinely takes, instead of the overlay vanishing after a
 *     fixed cosmetic delay while the real fetch is still silently in flight —
 *     the exact defect that made a cold "Start the Quiz" click look dead for
 *     several seconds even though it was still working underneath.
 *
 * A NEW `showForStart()` call supersedes whatever attempt came before it: it
 * cancels the previous attempt's pending timer, and — because every method
 * on a handle checks its OWN generation stamp before touching shared state —
 * a PREVIOUS attempt's `hide()` or `forceCancel()` arriving late (e.g.
 * component A was destroyed and navigated away, but its in-flight fetch's
 * `finally` block still calls `hide()` once it eventually settles, after
 * component B has already started a new attempt on this same shared
 * singleton) can never prematurely hide a newer attempt's overlay.
 *
 * There is deliberately NO service-level "reset everything" method: every
 * known caller is a routed component with its own handle to scope cleanup
 * to, and a global reset is exactly the kind of primitive that would let a
 * stale destroy hook affect an unrelated newer attempt. If a genuine
 * non-component caller ever needs an unconditional reset, add one then —
 * scoped to that proven need, not preemptively.
 */
@Service()
export class QuizStartSpinnerService {
  // The minimum time the overlay stays up, regardless of how fast the
  // caller's real work finishes — preserves the original polished-transition
  // feel for the common (warm) case.
  private static readonly MINIMUM_MS = 1600;
  private static readonly DEFAULT_LABEL = $localize`Preparing quiz…`;

  private readonly _visible = signal(false);
  readonly visible = this._visible.asReadonly();
  // The overlay label. Defaults to the quiz-start wording; Interview Mode passes
  // "Preparing Interview…" so the same single overlay is reused (never duplicated).
  private readonly _label = signal<string>(QuizStartSpinnerService.DEFAULT_LABEL);
  readonly label = this._label.asReadonly();

  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by every showForStart() call, and by a handle's own forceCancel() — supersedes whatever came before. */
  private generation = 0;

  /**
   * Show the overlay for a NEW start attempt, superseding any previous one.
   * Returns a handle scoped to exactly this attempt.
   */
  showForStart(label: string = QuizStartSpinnerService.DEFAULT_LABEL): QuizStartSpinnerHandle {
    this._label.set(label);
    this._visible.set(true);

    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const myGeneration = ++this.generation;
    let minimumElapsed = false;
    let hideRequested = false;

    const owns = (): boolean => this.generation === myGeneration;

    const maybeHide = (): void => {
      // A superseded attempt (a newer showForStart(), or another handle's
      // forceCancel(), has since bumped the generation) must never touch
      // the CURRENT overlay — this is what makes a stale hide() harmless.
      if (!owns()) return;
      if (!minimumElapsed || !hideRequested) return;
      this._visible.set(false);
    };

    const minimumElapsedPromise = new Promise<void>((resolve) => {
      this.timer = setTimeout(() => {
        this.timer = null;
        minimumElapsed = true;
        maybeHide();
        resolve();
      }, QuizStartSpinnerService.MINIMUM_MS);
    });

    return {
      minimumElapsed: minimumElapsedPromise,
      hide: (): void => {
        hideRequested = true;
        maybeHide();
      },
      forceCancel: (): void => {
        if (!owns()) return; // stale — a superseded attempt touches nothing
        this.generation++; // close this generation out
        if (this.timer !== null) {
          clearTimeout(this.timer);
          this.timer = null;
        }
        this._visible.set(false);
      }
    };
  }
}
