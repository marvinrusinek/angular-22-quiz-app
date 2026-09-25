import { DestroyRef, inject, Service } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, NavigationEnd, Router } from '@angular/router';
import { Observable, Subscription } from 'rxjs';
import { filter, skip, tap } from 'rxjs/operators';

import { Option } from '@shared/models/Option.model';
import { QuestionPayload } from '@shared/models/QuestionPayload.model';
import { QuizQuestion } from '@shared/models/QuizQuestion.model';

import { QuizNavigationService } from '@shared/services/flow/quiz-navigation.service';
import { QuizService } from '@shared/services/data/quiz.service';
import { ResetStateService } from '@shared/services/state/reset-state.service';
import { SharedVisibilityService } from '@shared/services/ui/shared-visibility.service';

import { swallow } from '@shared/utils/error-logging';

/**
 * Subscription factory service for QQC.
 * Creates and returns Subscription objects that the component owns and tears down.
 * Extracted from QuizQuestionComponent to reduce its size.
 */
@Service()
export class QqcSubscriptionWiringService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly quizNavigationService = inject(QuizNavigationService);
  private readonly quizService = inject(QuizService);
  private readonly resetStateService = inject(ResetStateService);
  private readonly sharedVisibilityService = inject(SharedVisibilityService);
  private readonly router = inject(Router);

  /**
   * Creates the page visibility subscription.
   * Extracted from setupVisibilitySubscription().
   */
  createVisibilitySubscription(params: {
    destroyRef: DestroyRef;
    onHidden: () => void;
    onVisible: () => void;
  }): void {
    this.sharedVisibilityService.pageVisibility$
      .pipe(takeUntilDestroyed(params.destroyRef))
      .subscribe((isHidden) => {
        if (isHidden) {
          params.onHidden();
        } else {
          params.onVisible();
        }
      });
  }

  /**
   * Creates the route listener subscription.
   * Calls onRouteChange with the parsed zero-based question index.
   * Extracted from initializeRouteListener().
   */
  createRouteListener(params: {
    activatedRoute: ActivatedRoute;
    getQuestionsLength: () => number;
    onRouteChange: (adjustedIndex: number) => void;
  }): Subscription {
    return this.router.events
      .pipe(filter((event) => event instanceof NavigationEnd))
      .subscribe(() => {
        const paramIndex =
          params.activatedRoute.snapshot.paramMap.get('questionIndex');
        const index = paramIndex ? +paramIndex : 0;

        const questionsLength = params.getQuestionsLength();
        if (questionsLength === 0) return;

        const adjustedIndex = Math.max(0, Math.min(index - 1, questionsLength - 1));
        params.onRouteChange(adjustedIndex);
      });
  }

  /**
   * Creates navigation flag subscription.
   * Extracted from subscribeToNavigationFlags().
   */
  createNavigationFlagSubscription(
    onNavigating: (isNavigating: boolean) => void
  ): Subscription {
    return this.quizNavigationService.getIsNavigatingToPrevious().subscribe(onNavigating);
  }

  /**
   * Creates total questions subscription.
   * Extracted from subscribeToTotalQuestions().
   */
  createTotalQuestionsSubscription(params: {
    quizId: string;
    destroyRef: DestroyRef;
    onTotal: (total: number) => void;
  }): Subscription {
    return this.quizService.getTotalQuestionsCount(params.quizId)
      .pipe(takeUntilDestroyed(params.destroyRef))
      .subscribe(params.onTotal);
  }

  /**
   * Creates the reset feedback + reset state subscriptions.
   * Returns an array of subscriptions for bulk teardown.
   * Extracted from setupSubscriptions().
   */
  createResetSubscriptions(params: {
    destroyRef: DestroyRef;
    onResetFeedback: () => void;
    onResetState: () => void;
  }): void {
    this.resetStateService.resetFeedback$
      .pipe(takeUntilDestroyed(params.destroyRef))
      .subscribe(params.onResetFeedback);
    this.resetStateService.resetState$
      .pipe(takeUntilDestroyed(params.destroyRef))
      .subscribe(params.onResetState);
  }

  /**
   * Creates subscription for questionPayload$ stream.
   * Applies payload data to component state on each emission.
   * Extracted from ngOnInit (lines 485â€“499).
   */
  createQuestionPayloadSubscription(callbacks: {
    destroyRef: DestroyRef;
    onPayload: (payload: QuestionPayload) => void;
  }): void {
    this.quizService.questionPayload$
      .pipe(
        filter((payload): payload is QuestionPayload => !!payload),
        tap((payload: QuestionPayload) => callbacks.onPayload(payload)),
        takeUntilDestroyed(callbacks.destroyRef)
      )
      .subscribe();
  }

  /**
   * Creates subscription for checkedShuffle$ preference stream.
   * Extracted from ngOnInit (lines 501â€“504).
   */
  createShufflePreferenceSubscription(params: {
    destroyRef: DestroyRef;
    onShuffle: (shouldShuffle: boolean) => void;
  }): void {
    this.quizService.checkedShuffle$
      .pipe(takeUntilDestroyed(params.destroyRef))
      .subscribe(params.onShuffle);
  }

  /**
   * Creates subscriptions for all QuizNavigationService event streams.
   * Returns an array of subscriptions for bulk teardown.
   * Extracted from ngOnInit (lines 506â€“551).
   */
  createNavigationEventSubscriptions(callbacks: {
    destroyRef: DestroyRef;
    onNavigationSuccess: () => void;
    onNavigatingBack: (sharedOptionComponent: any) => void;
    onNavigationToQuestion: (data: { question: QuizQuestion; options: Option[] }) => void;
    onExplanationReset: () => void;
    onRenderReset: () => void;
    onResetUIForNewQuestion: () => void;
  }): Subscription[] {
    const subs: Subscription[] = [];
    // Every stream below is a LONG-LIVED root-service Subject, while the host
    // (QuizQuestionComponent) is recreated on every question. These handles are
    // still returned so the page-visibility path can clear them early, but
    // takeUntilDestroyed is what guarantees they die with the component — without
    // it each question left six live subscriptions firing callbacks into a
    // destroyed instance.
    const untilGone = <T>(o: Observable<T>): Observable<T> =>
      o.pipe(takeUntilDestroyed(callbacks.destroyRef));

    subs.push(
      untilGone(this.quizNavigationService.navigationSuccess$).subscribe(() => {
        callbacks.onNavigationSuccess();
      })
    );

    subs.push(
      untilGone(this.quizNavigationService.navigatingBack$).subscribe(() => {
        // Component passes sharedOptionComponent reference
        callbacks.onNavigatingBack(null);
      })
    );

    subs.push(
      untilGone(this.quizNavigationService.navigationToQuestion$).subscribe(
        ({ question, options }) => {
          if (question?.questionText && options?.length) {
            callbacks.onNavigationToQuestion({ question, options });
          }
        }
      )
    );

    subs.push(
      untilGone(this.quizNavigationService.explanationReset$).subscribe(() => {
        callbacks.onExplanationReset();
      })
    );

    subs.push(
      untilGone(this.quizNavigationService.renderReset$).subscribe(() => {
        callbacks.onRenderReset();
      })
    );

    subs.push(
      untilGone(this.quizNavigationService.resetUIForNewQuestion$).subscribe(() => {
        callbacks.onResetUIForNewQuestion();
      })
    );

    return subs;
  }

  /**
   * Creates subscription for quizService.preReset$ stream.
   * Resets per-question state when a new question index is emitted.
   * Extracted from ngOnInit (lines 553â€“562).
   */
  createPreResetSubscription(params: {
    destroyRef: DestroyRef;
    onPreReset: (idx: number) => void;
    getLastResetFor: () => number;
    setLastResetFor: (idx: number) => void;
  }): Subscription {
    return this.quizService.preReset$
      .pipe(
        takeUntilDestroyed(params.destroyRef),
        filter(idx => Number.isFinite(idx as number) && (idx as number) >= 0),
        filter(idx => idx !== params.getLastResetFor()),
        tap(idx => params.setLastResetFor(idx as number))
      )
      .subscribe(idx => {
        params.onPreReset(idx as number);
      });
  }

  /**
   * Creates subscription for timerService.expired$ stream.
   * Extracted from ngOnInit (lines 599â€“604).
   */
  createTimerExpiredSubscription(params: {
    destroyRef: DestroyRef;
    timerExpired$: Observable<void>;
    onExpired: () => void;
  }): Subscription {
    return params.timerExpired$
      .pipe(takeUntilDestroyed(params.destroyRef))
      .subscribe(() => {
        params.onExpired();
      });
  }

  /**
   * Creates subscription for timerService.stop$ stream.
   * Skips the first emission and handles timer stop with microtask.
   * Extracted from ngOnInit (lines 606â€“613).
   */
  createTimerStopSubscription(params: {
    destroyRef: DestroyRef;
    timerStop$: Observable<any>;
    onTimerStopped: () => void;
  }): Subscription {
    return params.timerStop$
      .pipe(skip(1), takeUntilDestroyed(params.destroyRef))
      .subscribe(() => {
        queueMicrotask(() => {
          params.onTimerStopped();
        });
      });
  }

  /**
   * Creates subscription for currentQuestionIndex$ logging stream.
   * Extracted from ngOnInit (lines 470â€“479).
   */
  createCurrentQuestionIndexSubscription(
    destroyRef: DestroyRef,
    onIndex: (index: number) => void
  ): void {
    this.quizService.currentQuestionIndex$
      .pipe(takeUntilDestroyed(destroyRef))
      .subscribe((index: number) => {
        onIndex(index);
      });
  }

  /**
   * Creates subscription for activatedRoute.paramMap changes.
   * Resets explanation state and fetches question for each route change.
   * Extracted from ngOnInit (lines 564â€“586).
   */
  createRouteParamSubscription(params: {
    activatedRoute: ActivatedRoute;
    onRouteChange: (questionIndex: number) => Promise<void>;
  }): Subscription {
    return params.activatedRoute.paramMap.subscribe(async (paramMap) => {
      const rawParam = paramMap.get('questionIndex');
      const routeIndex = Number(rawParam);
      const questionIndex = Math.max(0, routeIndex - 1);  // normalize to 0-based

      await params.onRouteChange(questionIndex);
    });
  }

  /**
   * Creates the handleRouteChanges subscription that loads questions
   * and updates explanation state on each route param change.
   * Extracted from handleRouteChanges() (lines 1144â€“1212).
   */
  createRouteChangeHandlerSubscription(params: {
    activatedRoute: ActivatedRoute;
    getTotalQuestions: () => number;
    parseRouteIndex: (rawParam: string | null) => number;
    onRouteChange: (zeroBasedIndex: number, displayIndex: number) => Promise<void>;
  }): Subscription {
    return params.activatedRoute.paramMap.subscribe(async (paramMap) => {
      const rawParam = paramMap.get('questionIndex');

      // Delegate route parsing
      const zeroBasedIndex = params.parseRouteIndex(rawParam);
      const displayIndex = zeroBasedIndex + 1;  // 1-based for logging

      try {
        await params.onRouteChange(zeroBasedIndex, displayIndex);
      } catch (err: unknown) { swallow('qqc-subscription-wiring.service.ts onRouteChange', err); }
    });
  }
}
