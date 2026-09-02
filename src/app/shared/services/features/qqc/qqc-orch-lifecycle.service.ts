﻿import { Service } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';
import { take } from 'rxjs/operators';

import { Option } from '../../../models/Option.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';

import { swallow } from '../../../utils/error-logging';

import type { QuizQuestionComponent } from '../../../../components/question/quiz-question/quiz-question.component';

type Host = QuizQuestionComponent;

/**
 * Orchestrates QQC lifecycle methods (ngOnInit, ngAfterViewInit, ngOnDestroy).
 * Extracted from QqcComponentOrchestratorService.
 */
@Service()
export class QqcOrchLifecycleService {

  async runOnInit(host: Host): Promise<void> {
    this.wireQuestionStateSubscriptions(host);
    this.wireNavigationSubscriptions(host);

    const initialIdx = host.lifecycle.computeInitialQuestionIndex(host.activatedRoute);
    host.currentQuestionIndex.set(initialIdx.currentQuestionIndex);
    host.fixedQuestionIndex.set(initialIdx.fixedQuestionIndex);

    const loaded = await host.loadQuestion();
    if (!loaded) return;

    this.wireTimerSubscriptions(host);

    await this.bootstrapAndInitialize(host);
  }

  /**
   * The main bootstrap sequence (wrapped in a try so one failing step can't
   * abort the rest): call the super ngOnInit, populate options, wire the
   * render-ready stream, kick off the component-state/question-data loads, seed
   * the first question, run the quiz initializers, then wire the post-load
   * subscriptions. Order + inline awaits preserved from the original.
   */
  private async bootstrapAndInitialize(host: Host): Promise<void> {
    try {
      Object.getPrototypeOf(Object.getPrototypeOf(host)).ngOnInit?.call(host);

      host.populateOptionsToDisplay();

      this.setupRenderReadyStream(host);
      this.bootstrapComponentState(host);
      this.bootstrapQuestionData(host);
      this.setupFirstQuestionData(host);

      await host.initializeQuiz();
      await host.initializeQuizDataAndRouting();

      this.applyFirstQuestion(host);
      this.pushInitialSelectionMessage(host);

      this.wirePostLoadSubscriptions(host);
    } catch (err: unknown) {
      swallow('qqc-orch-lifecycle.service.ts runOnInit', err);
    }
  }

  // ── runOnInit bootstrap phases (extracted verbatim) ──────────────

  /**
   * Wire the render-ready observable (mirrors the question payload into the
   * display signals and toggles renderReady) and register the visibilitychange
   * handler.
   */
  private setupRenderReadyStream(host: Host): void {
    const renderReady$ = host.lifecycle.createRenderReadyObservable({
      questionPayload$: host.questionPayload$,
      setCurrentQuestion: (q: QuizQuestion | null) => { host.currentQuestion.set(q); },
      setOptionsToDisplay: (opts: Option[]) => { host.optionsToDisplay.set(opts); },
      setExplanationToDisplay: (text: string) => { host.explanationToDisplay.set(text); },
      setRenderReady: (val: boolean) => { host.renderReady.set(val); },
      // renderReadySubject was replaced with the renderReady signal
      // in commit 2e084f59; .set() drives both the signal and any
      // toObservable-derived stream consumers.
      emitRenderReady: (val: boolean) => host.renderReady.set(val)
    });
    renderReady$.pipe(takeUntilDestroyed(host.destroyRef)).subscribe();

    document.addEventListener('visibilitychange', host.onVisibilityChange.bind(host));
  }

  /**
   * Kick off the questionLoader component-state init; on resolve, mirror the
   * loaded question/index into the signals and generate its feedback text.
   * Fire-and-forget (matches the original inline .then).
   */
  private bootstrapComponentState(host: Host): void {
    host.questionLoader.initializeComponentState({
      questionsArray: host.questionsArray(),
      currentQuestionIndex: host.currentQuestionIndex(),
    }).then((result: any) => {
      if (!result) return;
      host.questionsArray.set(result.questionsArray);
      host.currentQuestionIndex.set(result.currentQuestionIndex);
      host.currentQuestion.set(result.currentQuestion);
      const cq = host.currentQuestion();
      if (cq) {
        host.generateFeedbackText(cq).then(
          (text: string) => { host.feedbackText.set(text); },
          () => { host.feedbackText.set('Unable to generate feedback.'); }
        );
      }
    });
  }

  /**
   * Kick off the questionLoader data wait; on resolve, set the question/options,
   * apply prior-selection feedback, and (re)initialize the form. Fire-and-forget.
   */
  private bootstrapQuestionData(host: Host): void {
    host.questionLoader.waitForQuestionData({
      currentQuestionIndex: host.currentQuestionIndex(),
      quizId: host.quizService.quizId,
    }).then((waitResult: any) => {
      if (!waitResult.currentQuestion) return;
      host.currentQuestionIndex.set(waitResult.currentQuestionIndex);
      host.currentQuestion.set(waitResult.currentQuestion);
      host.optionsToDisplay.set(waitResult.optionsToDisplay);
      host.quizService.getCurrentOptions(host.currentQuestionIndex()).pipe(take(1)).subscribe((options: Option[]) => {
        host.optionsToDisplay.set(Array.isArray(options) ? options : []);
        const previouslySelectedOption = host.optionsToDisplay().find((opt: Option) => opt.selected);
        if (previouslySelectedOption) {
          host.applyOptionFeedback(previouslySelectedOption);
        }
      });
      host.initializeForm();
      host.questionForm.updateValueAndValidity();
      window.scrollTo(0, 0);
    });
  }

  /** Seed the initial data model from the current question and start loading. */
  private setupFirstQuestionData(host: Host): void {
    const qInit = host.question();
    if (qInit) {
      host.data.set(host.questionLoader.buildInitialData(qInit, host.options() ?? []));
    }
    host.initializeForm();
    host.quizStateService.setLoading(true);
  }

  /**
   * Resolve and apply the first question from the route param: register the
   * quiz-question initializer, set the question/options, and schedule the
   * answered-explanation update.
   */
  private applyFirstQuestion(host: Host): void {
    host.initializer.initializeQuizQuestion({
      destroyRef: host.destroyRef,
      onQuestionsLoaded: (_questions: QuizQuestion[]) => {}
    });

    const questionIndexParam = host.activatedRoute.snapshot.paramMap.get('questionIndex');
    const firstQuestionIndex = host.initializer.parseQuestionIndexFromRoute(questionIndexParam);
    const firstQResult = host.initializer.setQuestionFirst({
      index: firstQuestionIndex,
      questionsArray: host.questionsArray()
    });
    if (firstQResult) {
      host.currentQuestion.set(firstQResult.currentQuestion);
      host.optionsToDisplay.set(firstQResult.optionsToDisplay);
      if (host.lastProcessedQuestionIndex !== firstQResult.questionIndex || firstQResult.questionIndex === 0) {
        host.lastProcessedQuestionIndex = firstQResult.questionIndex;
      }
      setTimeout(() => {
        host.updateExplanationIfAnswered(firstQResult.questionIndex, firstQResult.currentQuestion!);
      }, 50);
    }
  }

  /**
   * On the first question show the start prompt (idx 0); otherwise clear the
   * prior selection for the landed question.
   */
  private pushInitialSelectionMessage(host: Host): void {
    if (host.currentQuestionIndex() === 0) {
      const initialMessage = 'Please start the quiz by selecting an option.';
      if (host.selectionMessage() !== initialMessage) {
        host.selectionMessageService.pushMessage(initialMessage, 0);
      }
    } else {
      host.resetManager.clearSelection(host.correctAnswers, host.currentQuestion());
    }
  }

  // ── subscription-wiring groups (extracted verbatim from runOnInit) ──

  /**
   * Wire the core question-state subscriptions: the index/timer subscription,
   * the current-question-index mirror, the question-payload handler (sets
   * currentQuestion/options/explanation), and the shuffle-preference watcher.
   */
  private wireQuestionStateSubscriptions(host: Host): void {
    this.wireIndexTimerSubscription(host);
    this.wireCoreStateSubscriptions(host);
  }

  /** Wire the index/timer subscription (drives per-question reset + FET prewarm). */
  private wireIndexTimerSubscription(host: Host): void {
    host.lifecycle.createIndexTimerSubscription({
      destroyRef: host.destroyRef,
      currentQuestionIndex$: host.quizService.currentQuestionIndex$,
      elapsedTime$: host.timerService.elapsedTime$,
      timePerQuestion: host.timerService.timePerQuestion,
      normalizeIndex: (idx: number) => host.normalizeIndex(idx),
      resetPerQuestionState: (i0: number) => host.resetPerQuestionState(i0),
      deleteHandledOnExpiry: (i0: number) => host.handledOnExpiry.delete(i0),
      emitPassiveNow: (i0: number) => host.emitPassiveNow(i0),
      prewarmResolveFormatted: (i0: number) => {
        if (!host._formattedByIndex?.has?.(i0)) {
          host.resolveFormatted(i0, { useCache: true, setCache: true }).catch(() => {});
        }
      },
      onTimerExpiredFor: (i0: number) => host.onTimerExpiredFor(i0)
    });
  }

  /**
   * Wire the current-index mirror, the question-payload handler (sets
   * currentQuestion/options/explanation), and the shuffle-preference watcher.
   */
  private wireCoreStateSubscriptions(host: Host): void {
    host.subscriptionWiring.createCurrentQuestionIndexSubscription(host.destroyRef, (index: number) => {
      host.currentQuestionIndex.set(index);
    });

    host.subscriptionWiring.createQuestionPayloadSubscription({
      destroyRef: host.destroyRef,
      onPayload: (payload: any) => {
        host.currentQuestion.set(payload.question);
        host.optionsToDisplay.set(payload.options);
        host.explanationToDisplay.set(payload.explanation ?? '');
        host.updateShouldRenderOptions(host.optionsToDisplay());
      }
    });

    host.subscriptionWiring.createShufflePreferenceSubscription({
      destroyRef: host.destroyRef,
      onShuffle: (shouldShuffle: boolean) => { host.shuffleOptions = shouldShuffle; }
    });
  }

  /**
   * Wire the navigation/route subscriptions: navigation events (success, back,
   * to-question, explanation/render resets), the pre-reset subscription, and the
   * route-param subscription.
   */
  private wireNavigationSubscriptions(host: Host): void {
    this.wireNavigationEventSubscriptions(host);
    this.wirePreResetAndRouteSubscriptions(host);
  }

  /**
   * Wire the navigation-event subscriptions (success, back, to-question,
   * explanation/render/UI resets) and push them onto displaySubscriptions.
   */
  private wireNavigationEventSubscriptions(host: Host): void {
    const navSubs = host.subscriptionWiring.createNavigationEventSubscriptions({
      destroyRef: host.destroyRef,
      onNavigationSuccess: () => host.resetUIForNewQuestion(),
      onNavigatingBack: () => {
        const soc = host.sharedOptionComponent?.();
        if (soc) {
          soc.isNavigatingBackwards.set(true);
        }
        host.resetUIForNewQuestion();
      },
      onNavigationToQuestion: ({ question, options }: { question: QuizQuestion; options: Option[] }) => {
        // Only latch containerInitialized when options are present —
        // loadDynamicComponent early-returns on empty options, so latching
        // unconditionally permanently skips creation on a cold-load race and
        // the options never render. Leave it unlatched to retry on the next
        // options-bearing event.
        if (!host.containerInitialized && host.dynamicAnswerContainer?.()) {
          if (question && Array.isArray(options) && options.length > 0) {
            host.loadDynamicComponent(question, options);
            host.containerInitialized = true;
          }
        }
        host.sharedOptionConfig = null;
      },
      onExplanationReset: () => host.resetExplanation(),
      onRenderReset: () => { host.renderReady.set(false); },
      onResetUIForNewQuestion: () => host.resetUIForNewQuestion()
    });
    for (const sub of navSubs) {
      host.displaySubscriptions.push(sub);
    }
  }

  /** Wire the pre-reset subscription and the route-param subscription. */
  private wirePreResetAndRouteSubscriptions(host: Host): void {
    host.subscriptionWiring.createPreResetSubscription({
      destroyRef: host.destroyRef,
      onPreReset: (idx: number) => host.resetPerQuestionState(idx),
      getLastResetFor: () => host.lastResetFor,
      setLastResetFor: (idx: number) => { host.lastResetFor = idx; }
    });

    host.subscriptionWiring.createRouteParamSubscription({
      activatedRoute: host.activatedRoute,
      onRouteChange: async (questionIndex: number) => {
        host.explanationVisible.set(false);
        host.explanationText.set('');
        try {
          const question = await firstValueFrom(host.quizService.getQuestionByIndex(questionIndex));
          if (!question) return;
        } catch (err: unknown) { swallow('qqc-orch-lifecycle.service.ts getQuestionByIndex', err); }
      }
    });
  }

  /** Wire the timer-expired and timer-stop subscriptions. */
  private wireTimerSubscriptions(host: Host): void {
    host.subscriptionWiring.createTimerExpiredSubscription({
      destroyRef: host.destroyRef,
      timerExpired$: host.timerService.expired$,
      onExpired: () => {
        const idx = host.normalizeIndex(host.currentQuestionIndex() ?? 0);
        // A REVISIT to a question whose deadline had already passed
        // (expireImmediately()) fires this same expired$ event, but it is not a
        // fresh reveal — that happened on the visit that earned it. host.timedOut
        // is reset to false on every question transition (resetUIForNewQuestion),
        // so its own guard cannot tell a revisit apart from a first expiry; only
        // expiredOnArrivalSig can. Re-running the full reveal pipeline here forced
        // "Please click the Next button..." back over the natural nav-derived
        // message on every Previous/return to an expired question.
        if (host.timerService.expiredOnArrivalSig() === idx) return;
        host.onQuestionTimedOut(idx);
      }
    });

    host.subscriptionWiring.createTimerStopSubscription({
      destroyRef: host.destroyRef,
      timerStop$: host.timerService.stop$,
      onTimerStopped: () => {
        const reason = host.timedOut() ? 'timeout' : 'stopped';
        host.handleTimerStoppedForActiveQuestion(reason);
      }
    });
  }

  /**
   * Wire the post-load subscriptions: page-visibility, route listener (drives
   * explanation fetch on route change), feedback/state reset, and total-questions.
   */
  private wirePostLoadSubscriptions(host: Host): void {
    host.subscriptionWiring.createVisibilitySubscription({
      destroyRef: host.destroyRef,
      onHidden: () => host.handlePageVisibilityChange(true),
      onVisible: () => host.handlePageVisibilityChange(false)
    });

    host.subscriptionWiring.createRouteListener({
      activatedRoute: host.activatedRoute,
      getQuestionsLength: () => host.questions()?.length ?? 0,
      onRouteChange: (adjustedIndex: number) => {
        host.quizService.updateCurrentQuestionIndex(adjustedIndex);
        host.fetchAndSetExplanationText(adjustedIndex);
      }
    });

    host.subscriptionWiring.createResetSubscriptions({
      destroyRef: host.destroyRef,
      onResetFeedback: () => host.resetFeedback(),
      onResetState: () => host.resetState()
    });

    host.subscriptionWiring.createTotalQuestionsSubscription({
      quizId: host.quizId()!,
      destroyRef: host.destroyRef,
      onTotal: (totalQuestions: number) => { host.totalQuestions.set(totalQuestions); }
    });
  }

  async runAfterViewInit(host: Host): Promise<void> {
    const idx = host.fixedQuestionIndex() ?? host.currentQuestionIndex() ?? 0;
    host.resetForQuestion(idx);

    this.wireDeferredRenderReady(host);
    await this.runAfterViewQuestionSetup(host);
  }

  /**
   * Defer a render-ready subscription on the shared-option component: poll once
   * on the next microtask and, if not ready, back off via requestAnimationFrame
   * until it is, then markForCheck. Preserves the "wait for next true" semantic
   * without a reactive context inside this callback.
   */
  private wireDeferredRenderReady(host: Host): void {
    host.lifecycle.deferRenderReadySubscription({
      sharedOptionComponent: host.sharedOptionComponent?.(),
      subscribeToRenderReady: () => {
        const soc = host.sharedOptionComponent?.();
        if (!soc) return;
        // soc.renderReady is now a WritableSignal (was a Subject pre-migration).
        const check = (): void => {
          if (soc.renderReady()) {
            host.cdRef.markForCheck();
          } else {
            requestAnimationFrame(check);
          }
        };
        queueMicrotask(check);
      }
    });
  }

  /**
   * Wire the options-loader subscription and run the after-view-init question
   * setup; if setup hasn't resolved yet, retry ngAfterViewInit after a tick.
   */
  private async runAfterViewQuestionSetup(host: Host): Promise<void> {
    host.lifecycle.createOptionsLoaderSubscription({
      options$: host.quizQuestionLoaderService.options$,
      setCurrentOptions: (opts: Option[]) => { host.currentOptions = opts; }
    });

    const index = host.currentQuestionIndex();

    const setupResult = await host.questionLoader.performAfterViewInitQuestionSetup({
      questionsArray: host.questionsArray(),
      currentQuestionIndex: index,
      getFormattedExplanation: (q: QuizQuestion, i: number) => host.explanationManager.getFormattedExplanation(q, i),
      updateExplanationUI: (i: number, text: string) => host.updateExplanationUI(i, text)
    });

    if (!setupResult) {
      setTimeout(() => host.ngAfterViewInit(), 50);
      return;
    }
  }

  runOnDestroy(host: Host): void {
    try { document.removeEventListener('visibilitychange', host.onVisibilityChange.bind(host)); } catch (err: unknown) { swallow('qqc-orch-lifecycle.service.ts removeEventListener', err); }
    try { host.nextButtonStateService.cleanupNextButtonStateStream(); } catch (err: unknown) { swallow('qqc-orch-lifecycle.service.ts cleanupNextButtonStateStream', err); }
    // Defence in depth: every subscription pushed onto displaySubscriptions now
    // also carries takeUntilDestroyed, but this array was previously ONLY cleared
    // by the page-visibility handler — so a plain destroy left them live. Clear it
    // here too, so the teardown never depends on a visibility event happening.
    try {
      for (const sub of (host.displaySubscriptions ?? [])) sub.unsubscribe();
      host.displaySubscriptions = [];
    } catch (err: unknown) { swallow('qqc-orch-lifecycle.service.ts displaySubscriptions', err); }
  }
}