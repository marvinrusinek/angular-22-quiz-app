import { inject, Service } from '@angular/core';

import { Option } from '../../../../shared/models/Option.model';
import { OptionBindings } from '../../../../shared/models/OptionBindings.model';
import { SelectedOption } from '../../../../shared/models/SelectedOption.model';

import { AnswerOptionsService } from './answer-options.service';
import { isOptionCorrect } from '../../../../shared/utils/is-option-correct';
import { norm } from '../../../../shared/utils/text-norm';

@Service()
export class AnswerBindingsService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly answerOptionsService = inject(AnswerOptionsService);

  rebuildOptionBindings(options: Option[]): OptionBindings[] {
    if (!options?.length) return [];

    const cloned: Option[] =
      typeof structuredClone === 'function'
        ? structuredClone(options) : JSON.parse(JSON.stringify(options));

    const rebuilt = cloned.map((option, index) =>
      this.buildFallbackBinding(option, index)
    );

    for (const binding of rebuilt) {
      binding.allOptions = cloned;
      binding.optionsToDisplay = cloned;
    }

    return rebuilt;
  }

  buildFallbackBinding(option: Option, index: number): OptionBindings {
    return {
      option,
      index,
      isSelected: !!option.selected,
      // UNKNOWN at construction — see OptionBindings.isCorrect.
      isCorrect: null,

      showFeedback: true,
      // Whatever feedback the option already carries, and nothing else.
      //
      // This used to pick between "Great job — that answer is correct." and
      // "Not quite — see the explanation above." based on the option's own
      // `correct` flag. That put the answer key straight on screen, before any
      // verdict authorized a reveal and for options the user had not even
      // selected. Authorized feedback comes from FeedbackService once a verdict
      // exists; a fallback binding has no business inventing it.
      feedback: option.feedback?.trim() ?? '',

      highlight: !!option.highlight,

      showFeedbackForOption: {},
      appHighlightOption: false,
      highlightCorrectAfterIncorrect: false,
      highlightIncorrect: false,
      highlightCorrect: false,
      styleClass: '',
      disabled: false,
      type: 'single',
      appHighlightInputType: 'radio',
      allOptions: [],
      appHighlightReset: false,
      ariaLabel: `Option ${index + 1}`,
      appResetBackground: false,
      optionsToDisplay: [],
      checked: !!option.selected,
      change: () => {},
      active: true
    } as OptionBindings;
  }

  updateVisualBindings(
    currentBindings: OptionBindings[],
    enrichedOption: SelectedOption,
    type: 'single' | 'multiple',
  ): OptionBindings[] {
    if (!currentBindings?.length) return [];

    const isSingle = type === 'single';
    const disableOthers = isSingle && enrichedOption.selected === true;

    return currentBindings.map((binding, index) => {
      const bindingId = this.answerOptionsService.getEffectiveOptionId(
        binding.option,
        index
      );

      const matchesClickedOption = bindingId === enrichedOption.optionId;

      if (matchesClickedOption) {
        return this.buildClickedOptionBinding(binding, enrichedOption);
      }

      if (isSingle) {
        return this.buildUnselectedSingleAnswerBinding(binding, disableOthers);
      }

      return binding;
    });
  }

  private buildClickedOptionBinding(
    binding: OptionBindings,
    enrichedOption: SelectedOption
  ): OptionBindings {
    const selected = enrichedOption.selected === true;

    const newOption = {
      ...binding.option,
      selected,
      highlight: selected,
      showIcon: selected
    };

    return {
      ...binding,
      option: newOption,
      isSelected: selected,
      highlight: selected,
      checked: selected,
      showFeedback: true,
      disabled: false
    } as OptionBindings;
  }

  private buildUnselectedSingleAnswerBinding(
    binding: OptionBindings,
    disableOthers: boolean,
  ): OptionBindings {
    const isThisOptionCorrect = isOptionCorrect(binding.option);

    const newOption = {
      ...binding.option,
      selected: false,
      highlight: false,
      showIcon: false
    };

    return {
      ...binding,
      option: newOption,
      isSelected: false,
      highlight: false,
      checked: false,
      disabled:
        disableOthers && !isThisOptionCorrect
          ? true
          : binding.disabled
    } as OptionBindings;
  }

  hydrateBindingsFromSavedSelections(
    currentBindings: OptionBindings[],
    savedSelections: SelectedOption[],
    isMulti: boolean
  ): OptionBindings[] {
    if (!currentBindings?.length || !savedSelections?.length) {
      return currentBindings ?? [];
    }

    const savedIds = new Set(savedSelections.map(selection => String(selection.optionId)));

    const savedTexts = new Set(
      savedSelections.map(selection =>
        norm(selection.text),
      )
    );

    return currentBindings.map(binding => {
      const id = binding.option?.optionId;
      const text = binding.option?.text;

      const idMatch = id != null && savedIds.has(String(id));
      const textMatch =
        !!(text && savedTexts.has(norm(text)));

      const isSelected = isMulti ? false : idMatch || textMatch;

      const newOption = {
        ...binding.option,
        selected: isSelected,
        highlight: isSelected,
        showIcon: isSelected
      };

      return {
        ...binding,
        option: newOption,
        isSelected,
        highlight: isSelected,
        checked: isSelected,
        showFeedback: true
      } as OptionBindings;
    });
  }
}