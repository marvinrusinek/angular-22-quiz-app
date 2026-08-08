import { MatCheckbox } from '@angular/material/checkbox';
import { MatRadioButton } from '@angular/material/radio';

import { Option } from './Option.model';

import { HighlightOptionDirective } from '../../../app/directives/highlight-option.directive';

export interface OptionBindings {
  appHighlightOption: boolean;
  index: number;
  option: Option;
  /**
   * Known correctness, or `null` when it has not been authorized yet.
   *
   * Tri-state on purpose. `false` means the verdict said this option is WRONG;
   * `null` means nobody has said anything — an unselected option on an
   * incomplete question, or a check still in flight. Collapsing those two into
   * `false` is how an unrevealed option ends up styled as incorrect, and once
   * options arrive from the API carrying no `correct` flag at all, `null` is
   * the honest state at construction time.
   *
   * Read it as `isCorrect === true` / `isCorrect === false`. A bare
   * `if (!binding.isCorrect)` treats unknown as wrong.
   */
  isCorrect: boolean | null;
  feedback: string;
  showFeedback: boolean;
  showFeedbackForOption: { [key: number]: boolean };
  highlightCorrectAfterIncorrect: boolean;
  highlightIncorrect: boolean;
  highlightCorrect: boolean;
  allOptions: Option[];
  type: 'single' | 'multiple';
  appHighlightInputType: 'checkbox' | 'radio';
  appHighlightReset: boolean;
  appResetBackground: boolean;
  optionsToDisplay: Option[];
  highlight?: boolean;
  isSelected: boolean;
  active: boolean;
  checked: boolean;
  change: (element: MatCheckbox | MatRadioButton) => void;
  styleClass?: string;
  disabled: boolean;
  ariaLabel: string;
  directiveInstance?: HighlightOptionDirective;
  cssClasses?: { [key: string]: boolean };
  optionIcon?: string;
  optionCursor?: string;
  _autoRevealedCorrect?: boolean;
  _timerExpiredStamped?: boolean;
  _timerExpiredStampedForIndex?: number;
}