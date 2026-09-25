import { DestroyRef, Service } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { Observable, Subscription } from 'rxjs';
import {
  distinctUntilChanged, filter, map, skipWhile, switchMap, take, tap
} from 'rxjs/operators';

import { Option } from '@shared/models/Option.model';
import { QuestionPayload } from '@shared/models/QuestionPayload.model';
import { QuizQuestion } from '@shared/models/QuizQuestion.model';

import { shallowObjectEqual } from '@shared/utils/shallow-equal';

/**
 * Manages lifecycle-related orchestration for QuizQuestionComponent:
 * - ngOnInit subscription wiring and index tracking
 * - ngAfterViewInit render-ready and options loader subscriptions
 * - render-ready computation (observable-driven; see createRenderReadyObservable)
 * - ngOnDestroy cleanup helpers
 *
 * Extracted from QuizQuestionComponent to reduce its size.
 */
@Service()
export class QqcLifecycleService {

  // ═══════════════════════════════════════════════════════════════
  // ngOnInit HELPERS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Creates the idxSub (currentQuestionIndex$ → timer expiry) subscription.
   * This is the core per-question timer wiring from ngOnInit.
   * Extracted from ngOnInit (lines 432–468).
   */
  createIndexTimerSubscription(params: {
    destroyRef: DestroyRef;
    currentQuestionIndex$: Observable<number>;
    elapsedTime$: Observable<number>;
    timePerQuestion: number;
    normalizeIndex: (idx: number) => number;
    resetPerQuestionState: (i0: number) => void;
    deleteHandledOnExpiry: (i0: number) => void;
    emitPassiveNow: (i0: number) => void;
    prewarmResolveFormatted: (i0: number) => void;
    onTimerExpiredFor: (i0: number) => void;
  }): void {
    params.currentQuestionIndex$.pipe(
      map((i: number) => params.normalizeIndex(i)),
      distinctUntilChanged(),

      // On every question: hard reset view and restart visible countdown
      tap((i0: number) => {
        // DO NOT overwrite @Input currentQuestionIndex here.
        // We use i0 for the local reaction.
        params.resetPerQuestionState(i0);   // this must NOT arm any expiry
        params.deleteHandledOnExpiry(i0);  // clear any one-shot guards
        requestAnimationFrame(() => params.emitPassiveNow(i0));

        // Prewarm formatted text for THIS question (non-blocking; no UI writes)
        // Cache hit → no-op; miss → compute & store for first-click
        params.prewarmResolveFormatted(i0);
      }),

      // Wait for the SAME clock the UI renders: elapsedTime$
      // When it reaches the duration once, expire this question.
      switchMap((i0: number) =>
        params.elapsedTime$.pipe(
          // `elapsedTime$` (toObservable of the elapsed signal) replays its
          // CURRENT value on subscribe. When we arrive from a question that just
          // timed out, that value is still the previous question's max elapsed,
          // so the filter below would fire IMMEDIATELY and expire this fresh
          // question on arrival (FET shown before the question). Skip the stale
          // high value(s) until the timer resets below the duration, then arm.
          skipWhile((elapsed: number) => elapsed >= params.timePerQuestion),
          filter((elapsed: number) => elapsed >= params.timePerQuestion),
          take(1),
          map((): number => i0)
        )
      ),
      takeUntilDestroyed(params.destroyRef)
    )
    .subscribe((i0: number) => params.onTimerExpiredFor(i0));
  }

  /**
   * Computes the initial route-based question index and fixed index.
   * Extracted from ngOnInit (lines 588–591).
   */
  computeInitialQuestionIndex(activatedRoute: ActivatedRoute): {
    currentQuestionIndex: number;
    fixedQuestionIndex: number;
  } {
    const questionIndexParam = activatedRoute.snapshot.paramMap.get('questionIndex');
    const routeIndex = questionIndexParam !== null ? +questionIndexParam : 1;
    const idx = Math.max(0, routeIndex - 1);  // Normalize to 0-based
    return { currentQuestionIndex: idx, fixedQuestionIndex: idx };
  }

  /**
   * Creates the renderReady$ observable from the host's questionPayload$
   * (which mirrors the questionPayloadSig signal via toObservable).
   * Extracted from ngOnInit (lines 627–647).
   */
  createRenderReadyObservable(params: {
    questionPayload$: Observable<QuestionPayload | null>;
    setCurrentQuestion: (q: QuizQuestion) => void;
    setOptionsToDisplay: (opts: Option[]) => void;
    setExplanationToDisplay: (text: string) => void;
    setRenderReady: (val: boolean) => void;
    emitRenderReady: (val: boolean) => void;
  }): Observable<boolean> {
    return params.questionPayload$.pipe(
      filter((payload): payload is QuestionPayload => !!payload),
      distinctUntilChanged((a, b) => shallowObjectEqual(a, b)),
      tap((payload: QuestionPayload) => {
        // Assign all data at once
        const { question, options, explanation } = payload;
        params.setCurrentQuestion(question);
        params.setOptionsToDisplay([...options]);
        params.setExplanationToDisplay(explanation?.trim() || '');

        // Show everything together — Q + A in one paint pass
        setTimeout(() => {
          params.setRenderReady(true);
          params.emitRenderReady(true);
        }, 0);
      }),
      map(() => true)
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // ngAfterViewInit HELPERS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Creates the quizQuestionLoaderService.options$ subscription
   * that keeps currentOptions in sync.
   * Extracted from ngAfterViewInit (lines 725–733).
   */
  createOptionsLoaderSubscription(params: {
    options$: Observable<Option[]>;
    setCurrentOptions: (opts: Option[]) => void;
  }): Subscription {
    return params.options$
      .pipe(
        filter((opts) => opts.length > 0)  // skip empties
      )
      .subscribe((opts) => {
        params.setCurrentOptions([...opts]);  // parent's public field
      });
  }

  /**
   * Performs the renderReady subscription wiring for sharedOptionComponent.
   * Extracted from ngAfterViewInit (lines 716–723).
   */
  deferRenderReadySubscription(params: {
    sharedOptionComponent: any;
    subscribeToRenderReady: () => void;
  }): void {
    setTimeout(() => {
      if (params.sharedOptionComponent) params.subscribeToRenderReady();
    });
  }
}
