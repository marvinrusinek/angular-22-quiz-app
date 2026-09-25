import { Service, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { FET_UNLOCK_WATCHDOG_MS } from '@shared/constants/timing';
import { QuizQuestion } from '@shared/models/QuizQuestion.model';

import { ExplanationTextService } from '@shared/services/features/explanation/explanation-text.service';
import { QuestionStateResult } from './quiz-content-loader.service';
import { QuizService } from '@shared/services/data/quiz.service';
import { QuizStateService } from '@shared/services/state/quizstate.service';
import { swallow } from '@shared/utils/error-logging';

/**
 * Handles FET gate control, explanation preparation, and explanation state evaluation.
 * Extracted from QuizContentLoaderService.
 */
@Service()
export class QclFetGateService {

  // ── injects ─────────────────────────────────────────────────────
  private explanationTextService = inject(ExplanationTextService);
  private quizService = inject(QuizService);
  private quizStateService = inject(QuizStateService);

  // ── public methods ──────────────────────────────────────────────
  lockAndPurgeFet(adjustedIndex: number): void {
    const ets = this.explanationTextService;
    try {
      ets._fetLocked = true;
      ets.purgeAndDefer(adjustedIndex);
    } catch (err: unknown) { swallow('qcl-fet-gate.service.ts', err); }
  }

  resetDisplayExplanationText(currentQuestionIndex: number): void {
    const ets = this.explanationTextService;
    ets.unlockExplanation();
    ets.setExplanationText('', { force: true, index: currentQuestionIndex });
    ets.setShouldDisplayExplanation(false, { force: true });
    ets.setIsExplanationTextDisplayed(false, { force: true });
  }

  unlockFetGateAfterRender(
    adjustedIndex: number,
    getCurrentIndex: () => number,
    markForCheck: () => void
  ): void {
    const ets = this.explanationTextService;
    ets._fetLocked = true;
    ets.setShouldDisplayExplanation(false);
    ets.setIsExplanationTextDisplayed(false);
    ets.latestExplanation = '';

    // Capture the token we set with this lock — both the primary unlock
    // chain and the watchdog use it to verify the lock is still ours.
    const lockedToken = ets._gateToken;

    setTimeout(() => {
      markForCheck();
      requestAnimationFrame(() => {
        setTimeout(() => {
          const stillCurrent =
            ets._gateToken === ets._currentGateToken &&
            adjustedIndex === getCurrentIndex();
          if (!stillCurrent) return;
          ets._fetLocked = false;
        }, 100);
      });
    }, 140);

    // Watchdog: if the primary unlock chain above ever fails to complete
    // (exception in markForCheck, etc.), `_fetLocked` would stay true
    // indefinitely. Force-unlock at FET_UNLOCK_WATCHDOG_MS but only if the
    // same token is still active — a newer lock means someone else owns
    // the gate and must manage their own unlock.
    setTimeout(() => {
      if (!ets._fetLocked) return;
      if (ets._currentGateToken !== lockedToken) return;
      ets._fetLocked = false;
    }, FET_UNLOCK_WATCHDOG_MS);
  }

  prepareExplanationForQuestion(params: {
    qIdx: number;
    questionsArray: QuizQuestion[];
    quiz: any;
    currentQuestionIndex: number;
    currentQuestion: QuizQuestion | null;
  }): { explanationHtml: string; question: QuizQuestion | null } {
    const { qIdx, questionsArray, quiz, currentQuestionIndex, currentQuestion } = params;

    this.explanationTextService._activeIndex = qIdx;
    this.explanationTextService.latestExplanationIndex = qIdx;

    const question =
      questionsArray?.[qIdx] ??
      quiz?.questions?.[qIdx] ??
      (currentQuestionIndex === qIdx ? currentQuestion : null);

    if (!question) {
      const fallback = '<span class="muted">No explanation available</span>';
      this.explanationTextService.setExplanationText(fallback, { index: qIdx });
      this.explanationTextService.setShouldDisplayExplanation(true);
      return { explanationHtml: fallback, question: null };
    }

    const rawExpl = (question.explanation || 'No explanation available').trim();

    let formatted = this.explanationTextService.getFormattedSync(qIdx);
    if (!formatted) {
      const correctIndices = this.explanationTextService.getCorrectOptionIndices(
        question,
        question.options,
        qIdx
      );

      formatted = this.explanationTextService.formatExplanation(question, correctIndices, rawExpl);
      this.explanationTextService.setExplanationTextForQuestionIndex(qIdx, formatted);
    }

    this.explanationTextService.explanationsInitialized = true;

    this.explanationTextService.setExplanationText(formatted, { index: qIdx });
    this.explanationTextService.setShouldDisplayExplanation(true);
    this.quizStateService.setDisplayState({ mode: 'explanation', answered: true });

    return { explanationHtml: formatted, question };
  }

  async evaluateQuestionStateAndExplanation(params: {
    quizId: string;
    questionIndex: number;
  }): Promise<QuestionStateResult> {
    const { quizId, questionIndex } = params;
    const noOp: QuestionStateResult = {
      handled: false,
      explanationText: '',
      showExplanation: false,
      shouldLockExplanation: false,
      shouldDisableExplanation: false
    };

    const questionState = this.quizStateService.getQuestionState(quizId, questionIndex);
    if (!questionState) return noOp;

    if (!questionState.selectedOptions) questionState.selectedOptions = [];

    const hasUserSelected = (questionState.selectedOptions?.length ?? 0) > 0;
    if (!hasUserSelected) return noOp;

    const isAnswered = questionState.isAnswered;
    const explanationAlreadyDisplayed = questionState.explanationDisplayed;
    const shouldDisableExplanation = !isAnswered && !explanationAlreadyDisplayed;

    if (isAnswered || explanationAlreadyDisplayed) {
      let explanationText = '';

      if (Number.isFinite(questionIndex) && this.explanationTextService.explanationsInitialized) {
        const explanation$ = this.explanationTextService.getFormattedExplanationTextForQuestion(questionIndex);
        explanationText = (await firstValueFrom(explanation$)) ?? '';

        if (!explanationText?.trim()) {
          explanationText = 'No explanation available';
        }
      } else {
        explanationText = 'No explanation available';
      }

      this.explanationTextService.setExplanationText(explanationText, { index: questionIndex });
      this.explanationTextService.setResetComplete(true);
      this.explanationTextService.setShouldDisplayExplanation(true);
      this.explanationTextService.lockExplanation();

      return {
        handled: true,
        explanationText,
        showExplanation: true,
        shouldLockExplanation: true,
        shouldDisableExplanation: false
      };
    } else if (shouldDisableExplanation) {
      if (!this.explanationTextService.isExplanationLocked()) {
        this.explanationTextService.setResetComplete(false);
        this.explanationTextService.setExplanationText('', { index: questionIndex });
        this.explanationTextService.setShouldDisplayExplanation(false);
      }

      return {
        handled: true,
        explanationText: '',
        showExplanation: false,
        shouldLockExplanation: false,
        shouldDisableExplanation: true
      };
    }

    return noOp;
  }

  resetFetStateForInit(): void {
    try {
      const ets = this.explanationTextService;
      ets._activeIndex = -1;
      ets._fetLocked = true;
      ets.latestExplanation = '';
      ets.setShouldDisplayExplanation(false);
      ets.setIsExplanationTextDisplayed(false);
      ets.formattedExplanationSig.set('');
      requestAnimationFrame(() => ets.emitFormatted(-1, null));
    } catch (err: unknown) { swallow('qcl-fet-gate.service.ts', err); }
  }

  seedFirstQuestionText(): void {
    try {
      const firstQuestion = this.quizService.questions?.[0];
      if (firstQuestion) {
        const trimmed = (firstQuestion.questionText ?? '').trim();
        if (trimmed.length > 0) {
          setTimeout(() => {
            this.explanationTextService._fetLocked = false;
          }, 80);
        }
      }
      this.explanationTextService.setShouldDisplayExplanation(false);
      this.explanationTextService.setIsExplanationTextDisplayed(false);
    } catch (err: unknown) { swallow('qcl-fet-gate.service.ts', err); }
  }

  resolveExplanationChange(
    explanation: string | any,
    index: number | undefined,
    currentExplanation: string
  ): { text: string; index: number | undefined } | null {
    let finalExplanation: string;
    let finalIndex = index;

    if (explanation && typeof explanation === 'object' && 'payload' in explanation) {
      finalExplanation = explanation.payload;
      finalIndex = ('index' in explanation) ? explanation.index : index;
    } else {
      finalExplanation = explanation;
    }

    if (!finalExplanation) return null;

    const currentHasPrefix = currentExplanation?.toLowerCase().includes('correct because');
    const incomingHasPrefix = finalExplanation.toLowerCase().includes('correct because');
    if (currentHasPrefix && !incomingHasPrefix) return null;

    return { text: finalExplanation, index: finalIndex };
  }
}