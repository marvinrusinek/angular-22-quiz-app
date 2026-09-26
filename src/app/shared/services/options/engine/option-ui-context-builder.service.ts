import { Service } from '@angular/core';

import { Option } from '@shared/models';

import { OptionUiSyncContext } from '@shared/services/options/engine/option-ui-sync.service';

@Service()
export class OptionUiContextBuilderService {
  // ── public methods ──────────────────────────────────────────────
  build(ctx: OptionUiSyncContext): OptionUiSyncContext {
    return ctx;
  }

  fromSharedOptionComponent(src: any): OptionUiSyncContext {
    return {
      ...src,
      // Unwrap migrated signal inputs explicitly so consumers see values, not functions
      questionIndex: src.questionIndex?.(),
      quizId: src.quizId?.(),
      config: src.config?.(),
      highlightCorrectAfterIncorrect: src.highlightCorrectAfterIncorrect?.(),
      selectedOptionId: src.selectedOptionId?.(),
      finalRenderReady$: src.finalRenderReady$?.(),
      questionVersion: src.questionVersion?.(),
      // Explicitly bind methods that are on the prototype (spread doesn't copy them)
      keyOf: (o: Option, i: number) => src.keyOf(o, i),
      getActiveQuestionIndex: () => src.getActiveQuestionIndex(),
      getQuestionAtDisplayIndex: (idx: number) => src.getQuestionAtDisplayIndex(idx),
      emitExplanation: (idx: number, skipGuard?: boolean) => src.emitExplanation(idx, skipGuard),
      type: (src.isMultiMode || src.type === 'multiple') ? 'multiple' : 'single',
      isMultiMode: src.isMultiMode,
      currentQuestion: src.currentQuestion,
      
      toggleSelectedOption: (opt: any) => {
        if (opt == null || opt < 0) return;
        src.selectedOptionMap?.set(opt, !src.selectedOptionMap?.get(opt));
      },

      onSelect: (_binding: any, _checked: boolean, _questionIndex: number) => {
        // NO-OP: Do NOT emit optionClicked here.
        // The SOC click handler (handleOptionClick â†’ updateOptionAndUI) already
        // handles selection state, service sync, feedback, and scoring.
        // Emitting optionClicked triggers QQC's onOptionClicked which
        // double-processes the click: setSelectedOption TOGGLES for multi-answer
        // (removing what SOC just added), and updateOptionHighlighting/
        // markBindingSelected re-highlight from stale service state.
      }
    };
  }
}