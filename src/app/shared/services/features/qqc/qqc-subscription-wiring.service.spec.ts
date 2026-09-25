import { DestroyRef, Injectable } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';

import { QqcSubscriptionWiringService } from './qqc-subscription-wiring.service';
import { QuizService } from '@shared/services/data/quiz.service';
import { QuizNavigationService } from '@shared/services/flow/quiz-navigation.service';
import { ResetStateService } from '@shared/services/state/reset-state.service';
import { SharedVisibilityService } from '@shared/services/ui/shared-visibility.service';

/**
 * Subscription-LIFECYCLE tests. The suite previously asserted only outcomes, so
 * six navigation subscriptions plus the payload and index subscriptions leaked
 * unnoticed: they were created without takeUntilDestroyed against long-lived
 * root Subjects, while the host component is recreated on every question.
 * These tests fail if that teardown is ever removed again.
 */

/** A DestroyRef we can fire on demand. */
class FakeDestroyRef {
  private callbacks: (() => void)[] = [];
  onDestroy(cb: () => void): () => void {
    this.callbacks.push(cb);
    return () => void 0;
  }
  destroy(): void {
    for (const cb of this.callbacks) cb();
    this.callbacks = [];
  }
}

@Injectable()
class QuizServiceStub {
  questionPayload$ = new Subject<any>();
  currentQuestionIndex$ = new Subject<number>();
  checkedShuffle$ = new Subject<boolean>();
  preReset$ = new Subject<number>();
}

@Injectable()
class NavServiceStub {
  navigationSuccess$ = new Subject<void>();
  navigatingBack$ = new Subject<boolean>();
  navigationToQuestion$ = new Subject<any>();
  explanationReset$ = new Subject<void>();
  renderReset$ = new Subject<void>();
  resetUIForNewQuestion$ = new Subject<void>();
  getIsNavigatingToPrevious = () => new Subject<boolean>();
}

describe('QqcSubscriptionWiringService — subscription lifecycle', () => {
  let service: QqcSubscriptionWiringService;
  let quiz: QuizServiceStub;
  let nav: NavServiceStub;
  let destroyRef: FakeDestroyRef;

  beforeEach(() => {
    quiz = new QuizServiceStub();
    nav = new NavServiceStub();
    destroyRef = new FakeDestroyRef();

    TestBed.configureTestingModule({
      providers: [
        QqcSubscriptionWiringService,
        { provide: QuizService, useValue: quiz },
        { provide: QuizNavigationService, useValue: nav },
        { provide: ResetStateService, useValue: { resetFeedback$: new Subject<void>(), resetState$: new Subject<void>() } },
        { provide: SharedVisibilityService, useValue: { pageVisibility$: new Subject<boolean>() } }
      ]
    });
    service = TestBed.inject(QqcSubscriptionWiringService);
  });

  const ref = () => destroyRef as unknown as DestroyRef;

  it('navigation-event subscriptions STOP after the host is destroyed', () => {
    const calls = {
      onNavigationSuccess: 0, onNavigatingBack: 0, onNavigationToQuestion: 0,
      onExplanationReset: 0, onRenderReset: 0, onResetUIForNewQuestion: 0
    };
    service.createNavigationEventSubscriptions({
      destroyRef: ref(),
      onNavigationSuccess: () => calls.onNavigationSuccess++,
      onNavigatingBack: () => calls.onNavigatingBack++,
      onNavigationToQuestion: () => calls.onNavigationToQuestion++,
      onExplanationReset: () => calls.onExplanationReset++,
      onRenderReset: () => calls.onRenderReset++,
      onResetUIForNewQuestion: () => calls.onResetUIForNewQuestion++
    });

    // Alive: every stream is delivered.
    nav.navigationSuccess$.next();
    nav.navigatingBack$.next(true);
    nav.navigationToQuestion$.next({ question: { questionText: 'q' }, options: [{}] });
    nav.explanationReset$.next();
    nav.renderReset$.next();
    nav.resetUIForNewQuestion$.next();
    expect(calls).toEqual({
      onNavigationSuccess: 1, onNavigatingBack: 1, onNavigationToQuestion: 1,
      onExplanationReset: 1, onRenderReset: 1, onResetUIForNewQuestion: 1
    });

    // Destroyed: nothing may fire again (these are long-lived root Subjects).
    destroyRef.destroy();
    nav.navigationSuccess$.next();
    nav.navigatingBack$.next(true);
    nav.navigationToQuestion$.next({ question: { questionText: 'q' }, options: [{}] });
    nav.explanationReset$.next();
    nav.renderReset$.next();
    nav.resetUIForNewQuestion$.next();
    expect(calls).toEqual({
      onNavigationSuccess: 1, onNavigatingBack: 1, onNavigationToQuestion: 1,
      onExplanationReset: 1, onRenderReset: 1, onResetUIForNewQuestion: 1
    });
  });

  it('the questionPayload subscription stops writing state after destroy', () => {
    let payloads = 0;
    service.createQuestionPayloadSubscription({ destroyRef: ref(), onPayload: () => payloads++ });

    quiz.questionPayload$.next({ question: {}, options: [] });
    expect(payloads).toBe(1);

    destroyRef.destroy();
    quiz.questionPayload$.next({ question: {}, options: [] });
    expect(payloads).toBe(1);
  });

  it('the currentQuestionIndex subscription stops writing state after destroy', () => {
    let indices: number[] = [];
    service.createCurrentQuestionIndexSubscription(ref(), (i) => indices.push(i));

    quiz.currentQuestionIndex$.next(1);
    expect(indices).toEqual([1]);

    destroyRef.destroy();
    quiz.currentQuestionIndex$.next(2);
    expect(indices).toEqual([1]);
  });
});
