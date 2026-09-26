import { Service } from '@angular/core';

import { Option, QuizQuestion } from '@shared/models';

import type { QuizQuestionComponent } from '../../../../components/question/quiz-question/quiz-question.component';
import { delay } from '@shared/utils/delay';
import { norm } from '@shared/utils/text-norm';

type Host = QuizQuestionComponent;

/**
 * Orchestrates QQC explanation display, visibility restore, and explanation state management.
 * Extracted from QqcComponentOrchestratorService.
 */
@Service()
export class QqcOrchExplanationService {

  async runOnVisibilityChange(host: Host): Promise<void> {
    // Self-heal qIdx by text fingerprint. host.currentQuestionIndex() can
    // be stuck at 0 while the user is on Q2/Q3 (same desync the click
    // handlers self-heal). Using the stale index for persist/restore
    // writes Q1's slot and reads Q1's data on tab return.
    const resolveIdx = (): number => {
      const fallback = host.currentQuestionIndex?.() ?? 0;
      try {
        const liveQText = norm(host.currentQuestion?.()?.questionText);
        const allQs = host.quizService?.questions ?? [];
        if (liveQText && allQs.length) {
          const atFallback = norm(allQs[fallback]?.questionText);
          if (liveQText !== atFallback) {
            const fixed = allQs.findIndex((q: any) => norm(q?.questionText) === liveQText);
            if (fixed >= 0) return fixed;
          }
        }
      } catch { /* ignore */ }
      return fallback;
    };

    if (document.visibilityState === 'hidden') {
      host.navigationHandler.persistStateOnHide({
        quizId: host.quizId()!,
        currentQuestionIndex: resolveIdx(),
        displayExplanation: host.displayExplanation()
      });
      host.navigationHandler.resetExplanationStateOnHide();
      await host.navigationHandler.captureElapsedOnHide();
      return;
    }

    try {
      const { shouldExpire, expiredIndex } = await host.navigationHandler.handleFastPathExpiry({
        currentQuestionIndex: resolveIdx(),
        displayExplanation: host.displayExplanation(),
        normalizeIndex: (idx: number) => host.normalizeIndex(idx)
      });
      if (shouldExpire) {
        host.timerService.stopTimer?.(undefined, { force: true });
        host.onTimerExpiredFor(expiredIndex);
        return;
      }
    } catch {}

    try {
      if (document.visibilityState !== 'visible') return;
      host._visibilityRestoreInProgress = true;
      (host.explanationTextService as any)._visibilityLocked = true;
      host._suppressDisplayStateUntil = performance.now() + 300;

      const idxForRestore = resolveIdx();
      const restoreResult = await host.navigationHandler.performFullVisibilityRestore({
        quizId: host.quizId()!,
        currentQuestionIndex: idxForRestore,
        optionsToDisplay: host.optionsToDisplay(),
        currentQuestion: host.currentQuestion(),
        generateFeedbackText: (q: QuizQuestion) => host.generateFeedbackText(q),
        applyOptionFeedback: (opt: Option) => host.applyOptionFeedback(opt),
        restoreFeedbackState: () => {
          host.optionsToDisplay.set(host.feedbackManager.restoreFeedbackState(
            host.currentQuestion(),
            host.optionsToDisplay(),
            host.correctMessage()
          ));
        }
      });

      host.displayMode.set(restoreResult.displayMode as 'question' | 'explanation');
      host.optionsToDisplay.set(restoreResult.optionsToDisplay);
      host.feedbackText.set(restoreResult.feedbackText);
      host.displayExplanation.set(restoreResult.shouldShowExplanation);
      host.safeSetDisplayState(
        restoreResult.shouldShowExplanation
          ? { mode: 'explanation', answered: true }
          : { mode: 'question', answered: false }
      );

      setTimeout(() => {
        (host.explanationTextService as any)._visibilityLocked = false;
        host._visibilityRestoreInProgress = false;
        setTimeout(
          () => host.navigationHandler.refreshExplanationStatePostRestore(idxForRestore),
          400
        );
      }, 350);
    } catch {}
  }

  async runUpdateExplanationDisplay(host: Host, shouldDisplay: boolean): Promise<void> {
    if (host._isDestroyed) return;
    host.showExplanationChange.emit(shouldDisplay);
    host.displayExplanation.set(shouldDisplay);
    if (shouldDisplay) {
      setTimeout(async () => {
        const result = await host.explanationDisplay.performUpdateExplanationDisplay({
          shouldDisplay: true,
          currentQuestionIndex: host.currentQuestionIndex(),
        });
        host.explanationToDisplay.set(result.explanationToDisplay);
        host.explanationToDisplayChange.emit(result.explanationToDisplay);
        host.cdRef.markForCheck();
      }, 50);
    } else {
      const result = await host.explanationDisplay.performUpdateExplanationDisplay({
        shouldDisplay: false,
        currentQuestionIndex: host.currentQuestionIndex(),
      });
      if (result.explanationToDisplay !== undefined) {
        host.explanationToDisplay.set(result.explanationToDisplay);
        host.explanationToDisplayChange.emit(result.explanationToDisplay);
      }
      if (result.shouldResetQuestionState) host.resetQuestionStateBeforeNavigation();
    }
  }

  async runFetchAndSetExplanationText(host: Host, questionIndex: number): Promise<void> {
    if (host._isDestroyed) return;
    host.resetExplanation();

    const ensureLoaded = async () => {
      const r = await host.questionLoader.ensureQuestionsLoaded(host.questionsArray(), host.quizId());
      if (r.loaded && r.questions) {
        host.questions.set(r.questions);
        host.questionsArray.set(r.questions);
      }
      return r.loaded;
    };

    const result = await host.explanationFlow.performFetchAndSetExplanation({
      questionIndex,
      questionsArray: host.questionsArray(),
      quizId: host.quizId(),
      isAnswered: host.isAnswered(),
      shouldDisplayExplanation: host.shouldDisplayExplanation(),
      ensureQuestionsLoaded: ensureLoaded,
      ensureQuestionIsFullyLoaded: (idx: number) =>
        host.questionLoader.ensureQuestionIsFullyLoaded(idx, host.questionsArray(), host.quizId()),
      prepareExplanationText: (idx: number) => host.prepareAndSetExplanationText(idx),
      isAnyOptionSelected: (idx: number) => host.isAnyOptionSelected(idx)
    });

    if (result.success && !host._isDestroyed) {
      host.currentQuestionIndex.set(questionIndex);
      host.explanationToDisplay.set(result.explanationToDisplay);
      host.explanationTextService.updateFormattedExplanation(host.explanationToDisplay() ?? '');
      host.explanationToDisplayChange.emit(host.explanationToDisplay() ?? '');
    } else if (result.explanationToDisplay) {
      host.explanationToDisplay.set(host.explanationFlow.getExplanationErrorText());
      if (host.isAnswered() && host.shouldDisplayExplanation()) {
        host.emitExplanationChange(host.explanationToDisplay() ?? '', true);
      }
    }
  }

  runUpdateExplanationUI(host: Host, questionIndex: number, explanationText: string): void {
    const validated = host.explanationFlow.performUpdateExplanationUI({
      questionsArray: host.questionsArray(),
      questionIndex
    });
    if (!validated) return;

    try {
      host.quizService.setCurrentQuestion(validated.currentQuestion);
      delay(100)
        .then(async () => {
          if (host.shouldDisplayExplanation() && (await host.isAnyOptionSelected(validated.adjustedIndex))) {
            host.emitExplanationChange('', false);
            host.explanationToDisplay.set(explanationText);
            host.emitExplanationChange(host.explanationToDisplay() ?? '', true);
            host.isAnswerSelectedChange.emit(true);
          }
        })
        .catch(() => {});
    } catch {}
  }

  async runUpdateExplanationIfAnswered(host: Host, index: number, question: QuizQuestion): Promise<void> {
    const result = await host.explanationFlow.updateExplanationIfAnswered({
      index,
      question,
      shouldDisplayExplanation: host.shouldDisplayExplanation(),
      isAnyOptionSelected: (idx: number) => host.isAnyOptionSelected(idx),
      getFormattedExplanation: (q: QuizQuestion, idx: number) =>
        host.explanationManager.getFormattedExplanation(q, idx)
    });
    if (result.shouldUpdate && !host._isDestroyed) {
      host.explanationToDisplay.set(result.explanationText);
      host.emitExplanationChange(host.explanationToDisplay() ?? '', true);
      host.isAnswerSelectedChange.emit(true);
    }
  }

  runHandlePageVisibilityChange(host: Host, isHidden: boolean): void {
    const action = host.navigationHandler.computeVisibilityAction(isHidden);
    if (action.shouldClearSubscriptions) {
      for (const sub of (host.displaySubscriptions ?? [])) {
        sub.unsubscribe();
      }
      host.displaySubscriptions = [];
      const cleanup = host.navigationHandler.computeDisplaySubscriptionCleanup();
      host.explanationToDisplay.set(cleanup.explanationToDisplay);
      host.emitExplanationChange('', cleanup.showExplanation);
    }
    if (action.shouldRefreshExplanation) {
      host.prepareAndSetExplanationText(host.currentQuestionIndex());
    }
  }

  runApplyExplanationTextInZone(host: Host, text: string): void {
    if (host._isDestroyed) return;
    host.explanationToDisplay.set(text);
    host.explanationToDisplayChange.emit(text);
    host.cdRef.markForCheck();
  }

  runApplyExplanationFlags(host: Host, flags: any): void {
    host.forceQuestionDisplay.set(flags.forceQuestionDisplay);
    host.readyForExplanationDisplay.set(flags.readyForExplanationDisplay);
    host.isExplanationReady.set(flags.isExplanationReady);
    host.isExplanationLocked.set(flags.isExplanationLocked);
    host.explanationLocked = flags.explanationLocked;
    host.explanationVisible.set(flags.explanationVisible);
    host.displayExplanation.set(flags.displayExplanation);
    host.shouldDisplayExplanation.set(flags.shouldDisplayExplanation);
  }

  runResetExplanation(host: Host, force = false): void {
    const result = host.explanationFlow.performResetExplanation({ force, questionIndex: host.fixedQuestionIndex() ?? host.currentQuestionIndex() ?? 0 });
    host.displayExplanation.set(result.displayExplanation);
    host.explanationToDisplay.set(result.explanationToDisplay);
    if (!result.blocked) {
      host.emitExplanationChange('', false);
      host.cdRef?.markForCheck?.();
    }
  }

  async runPrepareAndSetExplanationText(host: Host, questionIndex: number): Promise<string> {
    host.explanationToDisplay.set(await host.explanationFlow.prepareExplanationText(questionIndex));
    return host.explanationToDisplay() ?? '';
  }

  async runUpdateExplanationText(host: Host, index: number): Promise<string> {
    return host.explanationDisplay.updateExplanationText(
      { index, 
        normalizeIndex: (idx: number) => host.normalizeIndex(idx), 
        questionsArray: host.questionsArray(), 
        currentQuestionIndex: host.currentQuestionIndex(), 
        currentQuestion: host.currentQuestion(), 
        optionsToDisplay: host.optionsToDisplay(), 
        options: host.options() ?? []
      });
  }
}