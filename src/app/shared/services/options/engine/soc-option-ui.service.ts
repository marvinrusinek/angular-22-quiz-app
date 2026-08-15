import { Service, inject } from '@angular/core';

import { isOptionCorrect } from '../../../utils/is-option-correct';
import { resolveIsMultiAnswer } from '../../../utils/question-type-authority';

import { OptionBindings } from '../../../models/OptionBindings.model';
import { SelectedOption } from '../../../models/SelectedOption.model';

import { OptionLockService } from '../policy/option-lock.service';
import { OptionSelectionPolicyService } from '../policy/option-selection-policy.service';
import { OptionService } from '../view/option.service';
import { SelectedOptionService } from '../../state/selectedoption.service';

/**
 * Handles option UI utility methods: selection, highlighting, binding snapshots,
 * backward navigation clicks, and display enforcement.
 * Extracted from SharedOptionClickService.
 */
@Service()
export class SocOptionUiService {
  // ── injects ─────────────────────────────────────────────────────
  private optionLockService = inject(OptionLockService);
  private optionSelectionPolicyService = inject(OptionSelectionPolicyService);
  private optionService = inject(OptionService);
  private selectedOptionService = inject(SelectedOptionService);

  // ── public methods ──────────────────────────────────────────────

  handleSelection(comp: any, option: SelectedOption, index: number, optionId: number): void {
    const normalizedId = (optionId != null && !isNaN(Number(optionId))) ? Number(optionId) : null;
    const effectiveId = (normalizedId !== null && normalizedId > -1) ? normalizedId : index;

    const currentQuestion = comp.currentQuestion();
    const correctCount = (currentQuestion?.options?.filter((o: any) => isOptionCorrect(o)).length ?? 0);
    // DECLARED TYPE FIRST. This decides whether a click CLEARS the other
    // options or toggles just this one, so a declared single-answer question
    // the local bank happened to flag twice used to behave as a checkbox group.
    // The type is read from the same question object the count came from.
    // REMOVE THE COUNT IN /questions CONTENT CUTOVER.
    // MODE INPUTS STILL PROMOTE — declared type replaces the COUNT only.
    const isMultiMode = comp.type === 'multiple'
      || comp.config()?.type === 'multiple'
      || resolveIsMultiAnswer(currentQuestion, correctCount > 1);

    if (!isMultiMode) {
      for (const opt of comp.optionsToDisplay || []) opt.selected = false;
      for (const b of comp.optionBindings() || []) {
        b.isSelected = false;
        b.option.selected = false;
      }

      option.selected = true;
      if (comp.optionsToDisplay?.[index]) {
        comp.optionsToDisplay[index].selected = true;
      }
      const cfgClick = comp.config();
      if (cfgClick) cfgClick.selectedOptionIndex = index;
      comp.selectedOption.set(option);

      comp.selectedOptions.clear();
      comp.selectedOptions.add(effectiveId);
      (option as any).displayIndex = index;
      this.selectedOptionService.setSelectedOption(option);
    } else {
      const qIdx = comp.getActiveQuestionIndex() ?? 0;

      option.selected = !option.selected;
      if (comp.optionsToDisplay?.[index]) {
        comp.optionsToDisplay[index].selected = option.selected;
      }

      option.selected
        ? comp.selectedOptions.add(effectiveId)
        : comp.selectedOptions.delete(effectiveId);

      const selOpt: SelectedOption = {
        ...option,
        optionId: (option.optionId != null && option.optionId !== -1) ? option.optionId : effectiveId,
        displayIndex: index,
        questionIndex: qIdx,
        selected: option.selected
      } as SelectedOption;
      (selOpt as any).index = index;
      (option as any).displayIndex = index;
      this.selectedOptionService.addOption(qIdx, selOpt);
    }

    const optionBinding = comp.optionBindings()[index];
    if (optionBinding) optionBinding.isSelected = option.selected;
  }

  handleBackwardNavigationOptionClick(comp: any, option: any, index: number): void {
    const optionBinding = comp.optionBindings()[index];

    if (comp.type === 'single') {
      for (const binding of comp.optionBindings()) {
        const isThis = binding === optionBinding;
        binding.isSelected = isThis;
        binding.option.showIcon = isThis;
      }
      comp.selectedOption.set(option);
      comp.selectedOptions.clear();
      const optId = option.optionId ?? -1;
      comp.selectedOptions.add(optId);
    } else {
      optionBinding.isSelected = !optionBinding.isSelected;
      optionBinding.option.showIcon = optionBinding.isSelected;
      const id = option.optionId;
      const effectiveId = (id != null && id !== -1) ? id : index;
      if (optionBinding.isSelected) {
        comp.selectedOptions.add(Number(effectiveId));
      } else {
        comp.selectedOptions.delete(Number(effectiveId));
      }
    }

    comp.showFeedback.set(true);
    comp.emitExplanation(comp.resolvedQuestionIndex ?? 0);
    comp.cdRef.markForCheck();
    comp.isNavigatingBackwards.set(false);
  }

  applySelectionsUI(comp: any, selectedOptions: any[]): void {
    if (!comp.optionsToDisplay?.length) return;
    if (comp.hasUserClicked() || comp.freezeOptionBindings()) return;

    const selIndices = new Set<number>();
    for (const s of selectedOptions) {
      const sIdx = (s as any).displayIndex ?? (s as any).index ?? (s as any).idx;
      if (sIdx != null && Number.isFinite(Number(sIdx))) {
        selIndices.add(Number(sIdx));
      }
    }

    for (let i = 0; i < comp.optionsToDisplay.length; i++) {
      const opt = comp.optionsToDisplay[i];
      const isSelected = selIndices.has(i);
      opt.selected = isSelected;
      opt.showIcon = isSelected;
      opt.highlight = isSelected;
    }

    comp.generateOptionBindings();
    comp.cdRef.markForCheck();
  }

  updateBindingSnapshots(comp: any): void {
    if (!comp.optionBindings()?.length) return;

    for (const binding of comp.optionBindings()) {
      if (binding && binding.option) {
        binding.disabled = comp.computeDisabledState(binding.option, binding.index);

        const qIndex = comp.currentQuestionIndex;
        const isLocked = this.optionLockService.isLocked(binding, binding.index, qIndex);

        binding.cssClasses = this.optionService.getOptionClasses(
          binding,
          binding.index,
          comp.highlightedOptionIds,
          comp.flashDisabledSet,
          isLocked,
          comp.timerExpiredForQuestion()
        );

        binding.optionIcon = this.optionService.getOptionIcon(binding, binding.index);

        binding.optionCursor = this.optionService.getOptionCursor(
          binding,
          binding.index,
          binding.disabled,
          comp.timerExpiredForQuestion()
        );
      }
    }
    comp.cdRef.markForCheck();
  }

  preserveOptionHighlighting(comp: any): void {
    const isMulti = comp.isMultiMode;

    for (const option of comp.optionsToDisplay) {
      if (!option.selected) {
        option.highlight = false;
        option.showIcon = false;
        continue;
      }

      const isCorrect = isOptionCorrect(option);
      if (isMulti) {
        if (isCorrect) {
          let lastCorrectIdx = -1;
          if (comp.selectedOptionHistory?.length > 0) {
            for (let j = comp.selectedOptionHistory.length - 1; j >= 0; j--) {
              const histId = comp.selectedOptionHistory[j];
              let hIdx = comp.optionsToDisplay.findIndex((_: any, oIdx: number) => oIdx === histId || String(oIdx) === String(histId));
              if (hIdx === -1) {
                hIdx = comp.optionsToDisplay.findIndex((o: any) => (o.optionId != null && o.optionId !== -1 && o.optionId == histId));
              }

              if (hIdx !== -1) {
                const oH = comp.optionsToDisplay[hIdx];
                if (oH?.selected && isOptionCorrect(oH)) {
                  lastCorrectIdx = hIdx;
                  break;
                }
              }
            }
          }
          const _v = (comp.optionsToDisplay.indexOf(option) === lastCorrectIdx);
          option.highlight = _v;
        } else {
          option.highlight = true;
        }
      } else {
        option.highlight = true;
      }
      option.showIcon = true;
    }
  }

  ensureOptionsToDisplay(comp: any): void {
    const activeIdx = comp.getActiveQuestionIndex();
    const displayQuestion = comp.getQuestionAtDisplayIndex(activeIdx);
    const fallbackOptions =
      displayQuestion?.options?.length
        ? displayQuestion.options : comp.currentQuestion()?.options;

    if (
      Array.isArray(comp.optionsToDisplay) &&
      comp.optionsToDisplay.length > 0
    ) return;

    if (Array.isArray(fallbackOptions) && fallbackOptions.length > 0) {
      comp.optionsToDisplay = fallbackOptions.map((option: any) => ({
        ...option,
        active: option.active ?? true,
        feedback: option.feedback ?? undefined,
        showIcon: option.showIcon ?? false
      }));
    } else {
      comp.optionsToDisplay = [];
    }

    comp.ensureOptionIds();
  }

  enforceSingleSelection(comp: any, selectedBinding: OptionBindings): void {
    this.optionSelectionPolicyService.enforceSingleSelection({
      optionBindings: comp.optionBindings(),
      selectedBinding,
      showFeedbackForOption: comp.showFeedbackForOption,
      updateFeedbackState: (id: number) => {
        if (!comp.showFeedbackForOption) comp.showFeedbackForOption = {};
        comp.showFeedback.set(true);
        comp.showFeedbackForOption[id] = true;
      }
    });
  }

}