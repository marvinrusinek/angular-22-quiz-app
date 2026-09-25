import { Service } from '@angular/core';

import type { QuizQuestionComponent } from '../../../../components/question/quiz-question/quiz-question.component';

import { delay } from '@shared/utils/delay';
import { swallow } from '@shared/utils/error-logging';

type Host = QuizQuestionComponent;

/**
 * Orchestrates QQC reset, per-question state clearing, and selection restore.
 * Extracted from QqcComponentOrchestratorService.
 */
@Service()
export class QqcOrchResetService {

  async runResetQuestionStateBeforeNavigation(
    host: Host,
    options?: { preserveVisualState?: boolean; preserveExplanation?: boolean }
  ): Promise<void> {
    const result = host.resetManager.computeResetQuestionStateBeforeNavigation(options);
    host.currentQuestion.set(result.currentQuestion);
    host.selectedOption = result.selectedOption;
    host.options.set(result.resetOptions);

    if (!result.preserveExplanation) {
      host.feedbackText.set(result.feedbackText);
      host.applyDisplayState(result.displayState);
      host.quizStateService.setDisplayState(host.displayState());
      host.updateDisplayMode(result.displayMode);
      host.applyExplanationFlags(result);
      host.explanationToDisplay.set(result.explanationToDisplay);
      host.emitExplanationChange('', false);
    }
    if (!result.preserveVisualState) {
      host.updateShouldRenderOptions([]);
      host.shouldRenderOptions.set(false);
    }

    host.finalRenderReady.set(false);
    host.renderReady.set(false);
    setTimeout(() => {
      const soc = host.sharedOptionComponent?.();
      if (soc) {
        soc.freezeOptionBindings.set(false);
        soc.showFeedbackForOption = {};
      }
    }, 0);

    const resetDelay = host.resetManager.computeResetDelay(result.preserveVisualState);
    if (resetDelay > 0) await delay(resetDelay);
  }

  runResetPerQuestionState(host: Host, index: number): void {
    if (host._pendingRAF != null) {
      cancelAnimationFrame(host._pendingRAF);
      host._pendingRAF = null;
    }
    host._skipNextAsyncUpdates = false;

    const result = host.resetManager.resetPerQuestionState({
      index,
      normalizeIndex: (idx: number) => host.normalizeIndex(idx),
      formattedByIndex: host._formattedByIndex,
      clearSharedOptionForceDisable: () => host.sharedOptionComponent?.()?.clearForceDisableAllOptions?.(),
      resolveFormatted: (idx: number, opts: any) => host.resolveFormatted(idx, opts)
    });

    host.handledOnExpiry.delete(result.i0);
    host.feedbackConfigs = result.feedbackConfigs;
    host.lastFeedbackOptionId = result.lastFeedbackOptionId;
    host.showFeedbackForOption = result.showFeedbackForOption;

    if (result.hasSelections) {
      host.optionsToDisplay.set(
        host.resetManager.restoreSelectionsAndIcons(
          result.i0, host.optionsToDisplay()
        )
      );
      host.cdRef.markForCheck();
    }

    host.displayExplanation.set(result.displayExplanation);
    host.updateDisplayMode(result.displayMode);
    if (result.hasSelections) {
      host.showExplanationChange?.emit(true);
    } else {
      host.explanationToDisplay.set('');
      host.emitExplanationChange('', false);
    }

    host.questionFresh.set(result.questionFresh);
    host.timedOut.set(result.timedOut);
    host._timerStoppedForQuestion = result.timerStoppedForQuestion;
    host._lastAllCorrect = result.lastAllCorrect;
    host.lastLoggedIndex = result.lastLoggedIndex;
    host.lastLoggedQuestionIndex = result.lastLoggedQuestionIndex;

    try {
      host.questionForm?.enable({ emitEvent: false });
    } catch (err: unknown) { swallow('qqc-orch-reset.service.ts questionForm.enable', err); }
    queueMicrotask(() => host.emitPassiveNow(index));
    host.cdRef.markForCheck();
  }

  runResetState(host: Host): void {
    const result = host.resetManager.resetState();
    host.selectedOption = result.selectedOption;
    host.options.set(result.options);
    host.resetFeedback();
  }

  runResetFeedback(host: Host): void {
    const result = host.resetManager.resetFeedback();
    host.correctMessage.set(result.correctMessage);
    host.showFeedback.set(result.showFeedback);
    host.selectedOption = result.selectedOption;
    host.showFeedbackForOption = result.showFeedbackForOption;
  }

  runResetForQuestion(host: Host, index: number): void {
    const guards = host.resetManager.hardResetClickGuards();
    host._clickGate = guards.clickGate;
    host.waitingForReady = guards.waitingForReady;
    host.deferredClick = guards.deferredClick;
    host.lastLoggedQuestionIndex = guards.lastLoggedQuestionIndex;
    host.lastLoggedIndex = guards.lastLoggedIndex;
    host.resetExplanation(true);
    host.resetPerQuestionState(index);
  }
}