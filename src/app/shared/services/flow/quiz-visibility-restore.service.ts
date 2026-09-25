import { Service, WritableSignal, inject } from '@angular/core';

import { Option } from '@shared/models/Option.model';
import { QuestionPayload } from '@shared/models/QuestionPayload.model';
import { QuizQuestion } from '@shared/models/QuizQuestion.model';

import { ExplanationTextService } from '@shared/services/features/explanation/explanation-text.service';
import { QuizStateService } from '@shared/services/state/quizstate.service';

interface DisplayState {
  mode: 'question' | 'explanation';
  answered: boolean;
}

export interface VisibilityRestoreParams {
  currentQuestion: QuizQuestion | null;
  optionsToDisplay: Option[];
  explanationToDisplay: string;
  combinedQuestionData: WritableSignal<QuestionPayload | null>;
  optionsToDisplaySig: WritableSignal<Option[]>;
}

/**
 * Handles tab visibility change save/restore for quiz display state.
 * Extracted from QuizComponent to reduce its size.
 */
@Service()
export class QuizVisibilityRestoreService {
  // ── injects ─────────────────────────────────────────────────────
  private explanationTextService = inject(ExplanationTextService);
  private quizStateService = inject(QuizStateService);

  // ── properties ──────────────────────────────────────────────────
  private _savedDisplayState: DisplayState | null = null;

  // ── public methods ──────────────────────────────────────────────

  /**
   * Handle a visibility change. Returns true if a re-render is needed
   * (caller should call cdRef.markForCheck()).
   */
  handleVisibilityChange(isHidden: boolean, params: VisibilityRestoreParams): boolean {
    if (isHidden) {
      const currentDisplayState = this.quizStateService.displayStateSig();
      if (currentDisplayState) {
        this._savedDisplayState = { ...currentDisplayState };
      }
      return false;
    }

    if (!this._savedDisplayState) return false;

    this.quizStateService.lockDisplayStateForVisibilityRestore(500);
    this.quizStateService.setDisplayState(this._savedDisplayState, { force: true });

    const showingExplanation = this._savedDisplayState.mode === 'explanation';
    this.explanationTextService.setShouldDisplayExplanation(showingExplanation);
    this.explanationTextService.setIsExplanationTextDisplayed(showingExplanation);

    if (params.currentQuestion) {
      const currentPayload = params.combinedQuestionData();
      const payloadToEmit: QuestionPayload = currentPayload || {
        question: params.currentQuestion,
        options: params.optionsToDisplay || [],
        explanation: params.explanationToDisplay || ''
      };

      params.combinedQuestionData.set(payloadToEmit);

      if (params.optionsToDisplay && params.optionsToDisplay.length > 0) {
        params.optionsToDisplaySig.set(params.optionsToDisplay);
      }
    }

    return true;
  }

  /** Clear cached display state — called by Restart so a stale save doesn't
   *  re-apply on the next tab-visibility cycle after the restart. */
  resetSavedState(): void {
    this._savedDisplayState = null;
  }
}