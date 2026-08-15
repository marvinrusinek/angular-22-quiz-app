import { Service } from '@angular/core';

import { Option } from '../../../models/Option.model';
import { OptionBindings } from '../../../models/OptionBindings.model';

@Service()
export class OptionService {
  // ── public methods ──────────────────────────────────────────────
  /**
   * Use the same key shape everywhere (STRING so we don't lose non-numeric ids)
   * Stable per-row key: prefer numeric optionId; fallback to stableKey + index
   */
  keyOf(o: Option, i: number): string {
    const idPart = 
      (o && o.optionId != null && o.optionId !== -1) ? String(o.optionId) : 'opt';
    return `${idPart}-${i}`;
  }

  /**
   * Returns display text for an option, allowing for custom formatting if needed
   */
  getOptionDisplayText(option: Option, idx: number): string {
    return `${idx + 1}. ${option.text || ''}`;
  }

  /**
   * Returns the icon to display for an option based on its state
   */
  getOptionIcon(binding: OptionBindings, _i: number): string {
    const option = binding.option;
    if (option.showIcon === false) { return ''; }

    if (option.correct) return 'check';
    if (binding.isSelected && !option.correct) return 'close';

    return '';
  }

  /**
   * Returns CSS classes for an option based on its bindings and state
   */
  getOptionClasses(
    binding: OptionBindings,
    idx: number,
    highlightedOptionIds: Set<number | string>,
    flashDisabledSet: Set<number | string>,
    isLocked: boolean = false,
    timerExpiredForQuestion: boolean = false
  ): { [key: string]: boolean } {
    const option = binding.option;
    const optId = option.optionId ?? -1;
    const isSelected = binding.isSelected === true;
    const isHighlighted = !!option.highlight;

    // PAINT FROM THE AUTHORIZED VERDICT, NOT THE LOCAL ANSWER KEY.
    //
    // These two classes used to read `option.correct`. Once bindings stopped
    // carrying local correct flags — they are constructed `isCorrect: null` and
    // filled in from the verdict — `option.correct` became undefined on every
    // binding, so `!option.correct` was ALWAYS true and every highlighted
    // option painted red, including the correct ones.
    //
    // `binding.isCorrect` is tri-state on purpose:
    //   true  -> authorized correct   -> green
    //   false -> authorized incorrect -> red
    //   null  -> NOT KNOWN YET        -> neither, paint nothing
    // Unknown must not fall through to "incorrect"; that is the bug above.
    const verdictCorrect = binding.isCorrect === true;
    const verdictIncorrect = binding.isCorrect === false;

    // Timeout reveal is the same authority: option-lock-policy fills isCorrect
    // from the expired verdict's correctOptionTexts, so no local flag is needed.
    const showCorrectOnTimeout = timerExpiredForQuestion && verdictCorrect;

    return {
      'selected': isSelected,
      'selected-option': isSelected,
      // Correct MAY be revealed on an option the user never picked — that is
      // the point of the terminal/timeout reveal.
      'correct-option': (isHighlighted && verdictCorrect) || showCorrectOnTimeout,
      // Incorrect may NOT. Red means "you chose this and it was wrong", so it
      // requires the user's own selection, not merely a highlight.
      //
      // On a terminal verdict applyAuthorizedCorrectness stamps isCorrect onto
      // EVERY binding, so unselected wrong options also carry `false`. Gating
      // on `isHighlighted` alone painted those red too — the user picked one
      // wrong option and a second, untouched one turned red beside it. It also
      // disclosed the correctness of options they never chose, which is the
      // same leak unselected-disclosure.spec.ts forbids for disabled state.
      'incorrect-option': !!(isSelected && verdictIncorrect),
      'highlighted': isHighlighted || highlightedOptionIds.has(idx),
      'flash-red': flashDisabledSet.has(optId),  // match original 'flash-red'
      'disabled-option': !!binding.disabled,     // match original 'disabled-option'
      'locked-option': isLocked && !binding.disabled  // match original 'locked-option'
    };
  }

  /**
   * Returns cursor style for option - 'not-allowed' for disabled/incorrect
   * options or when timer expired
   */
  getOptionCursor(
    _binding: OptionBindings,
    _index: number,
    isDisabled: boolean,
    timerExpiredForQuestion: boolean
  ): string {
    if (isDisabled || timerExpiredForQuestion) return 'default';

    return 'pointer';
  }
}