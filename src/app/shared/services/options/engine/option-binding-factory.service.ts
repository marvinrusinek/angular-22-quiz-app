import { Service } from '@angular/core';

import { Option } from '../../../models/Option.model';
import { OptionBindings } from '../../../models/OptionBindings.model';
import { SelectedOption } from '../../../models/SelectedOption.model';

export interface OptionBindingFactoryConfig {
  optionsToDisplay: Option[];
  type: 'single' | 'multiple';

  // UI/config flags from SOC
  showFeedback: boolean;
  showFeedbackForOption: Record<number, boolean> | null | undefined;

  highlightCorrectAfterIncorrect: boolean;
  shouldResetBackground: boolean;

  // Used by template/aria
  ariaLabelPrefix?: string;

  // Called when a binding is “changed” (click/change event)
  onChange: (opt: SelectedOption, idx: number) => void;

  /**
   * Provide selection truth. Prefer passing a function that reads your
   * SelectedOptionService / bindings selection state.
   */
  isSelected: (opt: Option) => boolean;

  /**
   * Provide disabled truth. Default is false; you can later wire
   * lock/disable policies here instead of using option.selected.
   */
  isDisabled?: (opt: Option, idx: number) => boolean;
}

@Service()
export class OptionBindingFactoryService {
  // ── public methods ──────────────────────────────────────────────
  createBindings(cfg: OptionBindingFactoryConfig): OptionBindings[] {
    const opts = Array.isArray(cfg.optionsToDisplay) ? cfg.optionsToDisplay : [];

    // Radio vs checkbox follows the question's TYPE, which the caller already
    // resolved from the declared type. It used to be inferred by counting
    // correct options — an answer-key read for a rendering decision, and one
    // that would silently turn every question into a radio group once options
    // arrive without correctness.
    const inputType = cfg.type === 'multiple' ? 'checkbox' : 'radio';
    const ariaPrefix = (cfg.ariaLabelPrefix ?? 'Option').trim() || 'Option';

    const bindings: OptionBindings[] = [];

    for (let idx = 0; idx < opts.length; idx++) {
      const option = opts[idx];
      const selected = cfg.isSelected(option);
      const disabled = cfg.isDisabled ? cfg.isDisabled(option, idx) : false;

      const cloned = {
        ...structuredClone(option),
        feedback: option?.feedback ?? 'No feedback available',
        // Clear stale visual flags carried over from prior question state
        highlight: false,
        selected: false
      };

      bindings.push({
        option: cloned,
        index: idx,

        feedback: option?.feedback ?? 'No feedback available',

        // UNKNOWN at construction. A freshly built binding has no authorized
        // verdict, so it cannot claim correctness in either direction — the
        // option object it is built from may carry no `correct` flag at all.
        // QuestionVerdictService fills this in once an answer or a reveal
        // authorizes it.
        isCorrect: null,

        showFeedback: cfg.showFeedback,
        showFeedbackForOption: cfg.showFeedbackForOption,

        highlightCorrectAfterIncorrect: cfg.highlightCorrectAfterIncorrect,
        // Visual state, not correctness — nothing is highlighted at build time.
        // These used to read the option's `correct` flag, which meant a brand
        // new binding could paint a verdict nobody had earned.
        highlightIncorrect: false,
        highlightCorrect: false,

        allOptions: opts,

        // Prefer the canonical type passed by SOC; keep inferred for input type only
        type: cfg.type,

        appHighlightOption: false,
        appHighlightInputType: inputType,
        appHighlightReset: cfg.shouldResetBackground,
        appResetBackground: cfg.shouldResetBackground,

        optionsToDisplay: opts,

        isSelected: selected,
        active: option?.active ?? true,

        // Event handler
        change: () => cfg.onChange(option as unknown as SelectedOption, idx),

        // Never derive disabled from option.selected
        disabled: !!disabled,

        ariaLabel: `${ariaPrefix} ${idx + 1}`,
        checked: selected,
        cssClasses: {},
        optionIcon: '',
        optionCursor: 'default'
      } as OptionBindings);
    }

    return bindings;
  }
}