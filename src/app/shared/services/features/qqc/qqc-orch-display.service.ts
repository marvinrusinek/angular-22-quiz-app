import { Service } from '@angular/core';
import { take } from 'rxjs/operators';

import { Option } from '@shared/models/Option.model';
import { QuizQuestion } from '@shared/models/QuizQuestion.model';

import type { QuizQuestionComponent } from '../../../../components/question/quiz-question/quiz-question.component';

import { ArrayUtils } from '@shared/utils/array-utils';

type Host = QuizQuestionComponent;

/**
 * Orchestrates QQC display state, option rendering, feedback, and misc wrappers.
 * Extracted from QqcComponentOrchestratorService.
 */
@Service()
export class QqcOrchDisplayService {

  runUpdateOptionsSafely(host: Host, newOptions: Option[]): void {
    const result = host.displayStateManager.prepareOptionSwap({
      newOptions,
      currentOptionsJson: JSON.stringify(host.optionsToDisplay())
    });

    if (result.needsSwap) {
      host.renderReady.set(false);
      host.finalRenderReady.set(false);
      host.questionForm = result.formGroup;
      if (result.serialized !== host.lastSerializedOptions) {
        host.lastSerializedOptions = result.serialized;
      }
      host.optionsToDisplay.set(result.cleanedOptions);
      const soc = host.sharedOptionComponent?.();
      if (soc) {
        soc.initializeOptionBindings();
      }
      setTimeout(() => {
        if (host.displayStateManager.computeRenderReadiness(host.optionsToDisplay())) {
          host.markRenderReady();
        }
      }, 0);
    } else if (
      host.displayStateManager.computeRenderReadiness(host.optionsToDisplay()) &&
      !host.finalRenderReady
    ) {
      host.markRenderReady();
    }
  }

  runHydrateFromPayload(host: Host, payload: any): void {
    const result = host.displayStateManager.hydrateFromPayload({
      payload,
      currentQuestionText: host.currentQuestion()?.questionText?.trim(),
      isAlreadyRendered: host.finalRenderReady()
    });
    if (!result) return;

    // renderReady / finalRenderReady were converted from Subjects to signals
    // in commit 2e084f59; the matching .next calls and plain assignments need
    // signal API (.set) to keep the host fields valid signals.
    host.renderReady.set(false);
    host.finalRenderReady.set(false);
    host.cdRef.markForCheck();

    host.currentQuestion.set(result.currentQuestion);
    host.optionsToDisplay.set(result.optionsToDisplay);
    host.updateShouldRenderOptions(host.optionsToDisplay());
    host.explanationToDisplay.set(result.explanationToDisplay);

    if (!host.containerInitialized && host.dynamicAnswerContainer?.()) {
      const cq = host.currentQuestion();
      const opts = host.optionsToDisplay();
      // Only latch containerInitialized when options are actually present.
      // loadDynamicComponent early-returns on empty options, so latching here
      // unconditionally would permanently skip creation on a cold-load race
      // where the payload arrives before options are ready — the options would
      // never render. Leaving it unlatched lets the next options-bearing
      // payload retry.
      if (cq && Array.isArray(opts) && opts.length > 0) {
        host.loadDynamicComponent(cq, opts);
        host.containerInitialized = true;
      }
    }
    host.sharedOptionComponent?.()?.initializeOptionBindings();

    setTimeout(() => {
      const soc = host.sharedOptionComponent?.();
      const bindingsReady =
        Array.isArray(soc?.optionBindings) &&
        soc!.optionBindings.length > 0 &&
        soc!.optionBindings.every((b: any) => !!b.option);
      if (
        host.displayStateManager.computeRenderReadiness(host.optionsToDisplay()) &&
        bindingsReady
      ) {
        soc?.markRenderReady('Hydrated from new payload');
      }
    }, 0);
  }

  runSetQuestionOptions(host: Host): void {
    host.quizService.getQuestionByIndex(host.currentQuestionIndex()).pipe(take(1)).subscribe((currentQuestion: QuizQuestion | null) => {
      if (!currentQuestion) return;
      host.currentQuestion.set(currentQuestion);
      host.currentOptions = host.displayStateManager.buildOptionsWithCorrectness(currentQuestion);
      if (host.currentOptions.length === 0) return;
      if (host.shuffleOptions) ArrayUtils.shuffleArray(host.currentOptions);
      host.currentOptions = host.displayStateManager.applyDisplayOrder(host.currentOptions);
      host.optionsToDisplay.set(host.currentOptions.map((o: any) => ({ ...o })));
      host.updateShouldRenderOptions(host.optionsToDisplay());
      host.quizService.nextOptionsSig.set(host.optionsToDisplay().map((o: any) => ({ ...o })));
      host.cdRef.markForCheck();
    });
  }

  runUpdateOptionHighlighting(host: Host, selectedKeys: Set<string | number>): void {
    host.optionsToDisplay.set(host.feedbackManager.updateOptionHighlighting(host.optionsToDisplay(), selectedKeys, host.currentQuestionIndex(), host.question()?.type));
    host.cdRef.markForCheck();
  }

  runRefreshFeedbackFor(host: Host, opt: Option): void {
    const soc = host.sharedOptionComponent?.();
    if (!soc) return;
    if (opt.optionId !== undefined) soc.lastFeedbackOptionId = opt.optionId;
    const cfg = host.feedbackManager.buildFeedbackConfigForOption(opt, host.optionBindings(), host.currentQuestion()!, soc.feedbackConfigs);
    soc.feedbackConfigs = { ...soc.feedbackConfigs, [opt.optionId!]: cfg };
    host.cdRef.markForCheck();
  }

  runPopulateOptionsToDisplay(host: Host): Option[] {
    const result = host.questionLoader.populateOptionsToDisplay(host.currentQuestion(), host.optionsToDisplay(), host.lastOptionsQuestionSignature);
    host.optionsToDisplay.set(result.options);
    host.lastOptionsQuestionSignature = result.signature;
    return host.optionsToDisplay();
  }

  runInitializeForm(host: Host): void {
    const form = host.initializer.buildFormFromOptions(host.currentQuestion(), host.fb);
    if (form) {
      host.questionForm = form;
    }
  }

  async runResolveFormatted(host: Host, index: number, opts: { useCache?: boolean; setCache?: boolean; timeoutMs?: number } = {}): Promise<string> {
    return host.timerEffect.resolveFormatted({
      index,
      normalizeIndex: (idx: number) => host.normalizeIndex(idx),
      formattedByIndex: host._formattedByIndex,
      useCache: opts.useCache,
      setCache: opts.setCache,
      timeoutMs: opts.timeoutMs,
      updateExplanationText: (idx: number) => host.updateExplanationText(idx)
    });
  }

  runDisableAllBindingsAndOptions(host: Host): { optionBindings: any[]; optionsToDisplay: Option[] } {
    const result = host.displayStateManager.disableAllBindingsAndOptions(host.optionBindings(), host.optionsToDisplay());
    host.optionBindings.set(result.optionBindings);
    host.optionsToDisplay.set(result.optionsToDisplay);
    return result;
  }

  runRevealFeedbackForAllOptions(host: Host, canonicalOpts: Option[]): void {
    const result = host.feedbackManager.revealFeedbackForAllOptions(canonicalOpts, host.feedbackConfigs, host.showFeedbackForOption);
    host.feedbackConfigs = result.feedbackConfigs;
    host.showFeedbackForOption = result.showFeedbackForOption;

    const soc = host.sharedOptionComponent?.();
    if (soc) {
      soc.feedbackConfigs = result.feedbackConfigs as any;
      soc.showFeedbackForOption = result.showFeedbackForOption;
      soc.cdRef.markForCheck();
    }

    host.cdRef.markForCheck();
  }

  runUpdateShouldRenderOptions(host: Host, options: Option[] | null | undefined): void {
    const v = host.displayStateManager.computeRenderReadiness(options);
    if (host.shouldRenderOptions() !== v) {
      host.shouldRenderOptions.set(v);
      host.cdRef.markForCheck();
    }
  }

  runSafeSetDisplayState(host: Host, state: { mode: 'question' | 'explanation'; answered: boolean }): void {
    if (host.displayStateManager.shouldSuppressDisplayState({
      visibilityRestoreInProgress: host._visibilityRestoreInProgress,
      suppressDisplayStateUntil: host._suppressDisplayStateUntil
    })) {
      return;
    }
    host.displayMode.set(state.mode);
    host.isAnswered.set(state.answered);
  }
}