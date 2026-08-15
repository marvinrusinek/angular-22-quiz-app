import { ComponentRef, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { debounceTime, take } from 'rxjs/operators';

import { Option } from '../../../models/Option.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';

import { isOptionCorrect } from '../../../utils/is-option-correct';
import { resolveIsMultiAnswer } from '../../../utils/question-type-authority';
import { reportError, swallow } from '../../../utils/error-logging';

import type { QuizQuestionComponent } from '../../../../components/question/quiz-question/quiz-question.component';

type Host = QuizQuestionComponent;

interface LoadPrep {
  shouldPreserveVisualState: boolean;
  shouldKeepExplanationVisible: boolean;
  explanationSnapshot: any;
}

/**
 * Orchestrates QQC question loading and dynamic component initialization.
 * Extracted from QqcComponentOrchestratorService.
 */
@Service()
export class QqcOrchQuestionLoadService {

  async runLoadDynamicComponent(host: Host, question: QuizQuestion, options: Option[]): Promise<void> {
    try {
      const container = host.dynamicAnswerContainer?.();
      if (
        !question ||
        !Array.isArray(options) ||
        !options.length ||
        !container ||
        !('questionText' in question)
      ) {
        return;
      }

      let isMultipleAnswer = false;
      try {
        isMultipleAnswer = await firstValueFrom(
          host.quizQuestionManagerService.isMultipleAnswerQuestion(question)
        );
      } catch {
        // Do NOT abort the whole render on a transient resolution failure
        // (firstValueFrom throws EmptyError if the observable completes without
        // emitting on a cold load). Resolve multi-answer SYNCHRONOUSLY so the
        // component still renders — this is the cold-load path, so introducing
        // a wait here would be worse than the wrong answer it replaces.
        //
        // DECLARED TYPE FIRST. `question` is the object being rendered, passed
        // in directly, so there is no index arithmetic and nothing to get wrong
        // under shuffle. The count survives only for a question that carries no
        // declared type. REMOVE THE COUNT IN /questions CONTENT CUTOVER.
        isMultipleAnswer = resolveIsMultiAnswer(
          question,
          (question.options ?? []).filter((o: Option) => isOptionCorrect(o)).length > 1
        );
      }

      container.clear();
      await Promise.resolve();
      let componentRef: ComponentRef<any>;
      try {
        componentRef = await host.dynamicComponentService.loadComponent(
          container,
          isMultipleAnswer,
          host.onOptionClicked.bind(host)
        );
      } catch (err: unknown) {
        // Creation failed — unlatch so the reactive effect retries on the next
        // signal change instead of being permanently stuck (the latch was set
        // by the caller when this was invoked, not when it succeeded). Log it:
        // this is the catch that hid the StackBlitz cold-load chunk-fetch throw.
        reportError('loadDynamicComponent.loadComponent', err);
        host.containerInitialized = false;
        return;
      }
      if (!componentRef?.instance) {
        host.containerInitialized = false;
        return;
      }
      const instance = componentRef.instance;

      const configured = host.questionLoader.configureDynamicInstance({
        instance,
        componentRef,
        question,
        options,
        isMultipleAnswer,
        currentQuestionIndex: host.currentQuestionIndex(),
        navigatingBackwards: false,
        defaultConfig: host.getDefaultSharedOptionConfig?.(),
        onOptionClicked: host.onOptionClicked.bind(host)
      });
      host.questionData.set(configured.questionData);
      host.sharedOptionConfig = configured.sharedOptionConfig;
      host.cdRef.markForCheck();
      await (instance as any).initializeSharedOptionConfig(configured.clonedOptions);
      if (!Object.prototype.hasOwnProperty.call(instance, 'onOptionClicked')) {
        instance.onOptionClicked = host.onOptionClicked.bind(host);
      }
      host.updateShouldRenderOptions(instance.optionsToDisplay());
      if (host.displayStateManager.computeRenderReadiness(instance.optionsToDisplay())) {
        host.shouldRenderOptions.set(true);
      }
      try { componentRef.changeDetectorRef.markForCheck(); } catch (err: unknown) { swallow('qqc-orch-question-load.service.ts markForCheck', err); }
    } catch (err: unknown) {
      // Any failure after entry — unlatch so the effect can retry.
      reportError('loadDynamicComponent', err);
      host.containerInitialized = false;
    }
  }

  async runLoadQuestion(host: Host, signal?: AbortSignal): Promise<boolean> {
    const prep = this.prepareForLoad(host);
    try {
      return await this.performLoad(host, prep, signal);
    } catch (err: unknown) {
      reportError('runLoadQuestion', err);
      this.applyLoadError(host);
      return false;
    } finally {
      host.isLoading.set(false);
      host.quizStateService.setLoading(false);
    }
  }

  // Set pre-load flags, snapshot the explanation, run the pre-load reset, and
  // apply loading state. Returns the flags + snapshot the load path needs.
  private prepareForLoad(host: Host): LoadPrep {
    this.applyPreLoadFlags(host);

    const shouldPreserveVisualState = host.questionLoader.canRenderQuestionInstantly(
      host.questionsArray(),
      host.currentQuestionIndex()
    );
    const explanationSnapshot = this.captureExplanationSnapshot(host, shouldPreserveVisualState);
    const shouldKeepExplanationVisible = explanationSnapshot.shouldRestore;

    host.questionLoader.performPreLoadReset({
      shouldPreserveVisualState,
      shouldKeepExplanationVisible,
      currentQuestionIndex: host.currentQuestionIndex()
    });

    this.applyLoadingState(host, shouldPreserveVisualState);

    return { shouldPreserveVisualState, shouldKeepExplanationVisible, explanationSnapshot };
  }

  // Reset, restore/clear the explanation, load the question, and publish the
  // result. Throws propagate to runLoadQuestion's catch; redirect/empty -> false.
  private async performLoad(host: Host, prep: LoadPrep, signal?: AbortSignal): Promise<boolean> {
    host.selectedOptionId = null;
    const lockedIndex = host.currentQuestionIndex();

    await host.resetQuestionStateBeforeNavigation({
      preserveVisualState: prep.shouldPreserveVisualState,
      preserveExplanation: prep.shouldKeepExplanationVisible
    });

    this.applyExplanationClearOrRestore(
      host, prep.shouldKeepExplanationVisible, prep.explanationSnapshot, lockedIndex
    );

    const loadResult = await host.questionLoader.performLoadQuestionPostReset({
      currentQuestionIndex: host.currentQuestionIndex(),
      questionsArray: host.questionsArray(),
      quizId: host.quizId(),
      signal,
      questions: host.questions()
    });

    if (!loadResult) return false;
    if (loadResult.shouldRedirect) {
      await host.router.navigate(['/results', host.quizId()]);
      return false;
    }

    this.applyLoadResult(host, loadResult);
    return true;
  }

  private applyPreLoadFlags(host: Host): void {
    host.readyForExplanationDisplay.set(false);
    host.isExplanationReady.set(false);
    host.isExplanationLocked.set(true);
    host.forceQuestionDisplay.set(true);
  }

  private captureExplanationSnapshot(host: Host, shouldPreserveVisualState: boolean): any {
    return host.explanationManager.captureExplanationSnapshot({
      preserveVisualState: shouldPreserveVisualState,
      index: host.currentQuestionIndex(),
      explanationToDisplay: host.explanationToDisplay() ?? '',
      quizId: host.quizId(),
      isAnswered: host.isAnswered(),
      displayMode: host.displayMode(),
      shouldDisplayExplanation: host.shouldDisplayExplanation(),
      explanationVisible: host.explanationVisible(),
      displayExplanation: host.displayExplanation(),
      displayStateAnswered: host.displayState().answered
    });
  }

  private applyLoadingState(host: Host, shouldPreserveVisualState: boolean): void {
    if (shouldPreserveVisualState) {
      host.isLoading.set(false);
    } else {
      host.isLoading.set(true);
      host.quizStateService.setLoading(true);
      host.quizStateService.setAnswerSelected(false);
      if (!host.quizStateService.isLoading()) host.quizStateService.startLoading();
    }
  }

  private applyExplanationClearOrRestore(
    host: Host,
    shouldKeepExplanationVisible: boolean,
    explanationSnapshot: any,
    lockedIndex: number
  ): void {
    if (!shouldKeepExplanationVisible) {
      const clearResult = host.questionLoader.performPostResetExplanationClear();
      host.renderReady.set(false);
      host.displayMode.set(clearResult.displayState.mode);
      host.isAnswered.set(clearResult.displayState.answered);
      host.forceQuestionDisplay.set(clearResult.forceQuestionDisplay);
      host.readyForExplanationDisplay.set(clearResult.readyForExplanationDisplay);
      host.isExplanationReady.set(clearResult.isExplanationReady);
      host.isExplanationLocked.set(clearResult.isExplanationLocked);
      host.feedbackText.set(clearResult.feedbackText);
    } else {
      const restoreResult = host.explanationFlow.computeRestoreAfterReset({
        questionIndex: lockedIndex,
        explanationText: explanationSnapshot.explanationText,
        questionState: explanationSnapshot.questionState,
        quizId: host.quizId(),
        quizServiceQuizId: host.quizService.quizId,
        currentQuizId: host.quizService.getCurrentQuizId(),
      });
      if (!restoreResult.shouldSkip) {
        host.explanationToDisplay.set(restoreResult.explanationText);
        host.updateDisplayMode(restoreResult.displayMode);
        host.applyDisplayState(restoreResult.displayState);
        host.applyExplanationFlags(restoreResult);
        host.emitExplanationChange(restoreResult.explanationText, true);
      }
    }
  }

  private applyLoadResult(host: Host, loadResult: any): void {
    host.questionsArray.set(loadResult.questionsArray);
    host.currentQuestion.set(loadResult.currentQuestion);
    host.optionsToDisplay.set(loadResult.optionsToDisplay);
    host.updateShouldRenderOptions(host.optionsToDisplay());

    const banner = host.feedbackManager.computeCorrectAnswersBanner({
      currentQuestion: host.currentQuestion(),
      currentQuestionIndex: host.currentQuestionIndex()
    });
    host.quizService.updateCorrectAnswersText(banner.bannerText);

    host.sharedOptionComponent?.()?.initializeOptionBindings();
    host.cdRef.markForCheck();

    const cq = host.currentQuestion();
    if (cq && host.optionsToDisplay()?.length > 0) {
      host.questionAndOptionsReady.emit();
      host.quizService.emitQuestionAndOptions(
        cq,
        host.optionsToDisplay(),
        host.currentQuestionIndex()
      );
    }
  }

  private applyLoadError(host: Host): void {
    host.feedbackText.set('Error loading question. Please try again.');
    host.currentQuestion.set(null);
    host.optionsToDisplay.set([]);
  }

  runSetupRouteChangeHandler(host: Host): void {
    host.subscriptionWiring.createRouteChangeHandlerSubscription({
      activatedRoute: host.activatedRoute,
      getTotalQuestions: () => host.totalQuestions(),
      parseRouteIndex: (rawParam: string | null) =>
        host.initializer.handleRouteChangeParsing({ rawParam, totalQuestions: host.totalQuestions() }),
      onRouteChange: async (zeroBasedIndex: number, _displayIndex: number) => {
        host.currentQuestionIndex.set(zeroBasedIndex);
        host.explanationVisible.set(false);
        host.explanationText.set('');

        const routeResult = await host.questionLoader.performRouteChangeUpdate({
          zeroBasedIndex,
          questionsArray: host.questionsArray(),
          loadQuestion: () => host.loadQuestion(),
          isAnyOptionSelected: (idx: number) => host.isAnyOptionSelected(idx),
          updateExplanationText: (idx: number) => host.updateExplanationText(idx),
          shouldDisplayExplanation: host.shouldDisplayExplanation(),
          questionForm: host.questionForm
        });

        if (!routeResult) return;
        host.currentQuestion.set(routeResult.currentQuestion);
        host.optionsToDisplay.set(routeResult.optionsToDisplay);

        if (host.shouldDisplayExplanation()) {
          host.showExplanationChange.emit(true);
          const transition = host.explanationDisplay.computeExplanationModeTransition(
            host.shouldDisplayExplanation(),
            host.displayMode()
          );
          if (transition) {
            host.applyDisplayState(transition.displayState);
            host.updateDisplayMode(transition.displayMode);
            const f = transition.explanationFlags;
            host.shouldDisplayExplanation.set(f.shouldDisplayExplanation);
            host.explanationVisible.set(f.explanationVisible);
            host.forceQuestionDisplay.set(f.forceQuestionDisplay);
            host.readyForExplanationDisplay.set(f.readyForExplanationDisplay);
            host.isExplanationReady.set(f.isExplanationReady);
            host.isExplanationLocked.set(f.isExplanationLocked);
          }
        }
      }
    });
  }

  async runInitializeQuiz(host: Host): Promise<void> {
    if (host.initialized()) return;
    host.initialized.set(true);

    host.quizId.set(host.activatedRoute.snapshot.paramMap.get('quizId'));
    host.isLoading.set(true);
    try {
      const result = await host.initializer.performFullQuizInit({
        currentQuestionIndex: host.currentQuestionIndex(),
        questionsArray: host.questionsArray(),
        routeQuizId: host.quizId() ?? null,
        setQuestionOptions: () => host.setQuestionOptions(),
        questionLoader: host.questionLoader,
        prepareExplanationForQuestion: (p: any) => host.initializer.prepareExplanationForQuestion(p),
        getExplanationText: (idx: number) => host.explanationManager.getExplanationText(idx)
      });
      if (result) {
        host.questionsArray.set(result.questionsArray);
        host.questions.set(result.questions);
        host.quizId.set(result.quizId);
      }
    } finally {
      host.isLoading.set(false);
    }
  }

  async runInitializeQuizDataAndRouting(host: Host): Promise<void> {
    const result = 
      await host.questionLoader.performQuizDataAndRoutingInit(
        { quizId: host.quizId() }
      );
    if (!result) return;

    host.questions.set(result.questions);
    host.questionsArray.set(result.questions);
    if (result.quiz) host.quiz.set(result.quiz);
    if (!host.quiz()) return;

    host.quizService.questionsLoaded$.pipe(
      take(1), debounceTime(100)
    ).subscribe((loaded: boolean) => {
      if (loaded) host.setupRouteChangeHandler();
    });
  }
}