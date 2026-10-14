import { Option } from './Option.model';

export interface SelectedOption extends Option {
  questionIndex?: number;
  displayIndex?: number;

  /**
   * Legacy index extensions. Some click-pipeline paths attach `.index`
   * directly to a SelectedOption (e.g. option-interaction's `newOpt`
   * construction passes both `index` and `displayIndex` for backward
   * compatibility). `.idx` is read defensively but never written; it
   * exists so the reader's `displayIndex ?? index ?? idx` fallback
   * chain type-checks without `as any`.
   *
   * Prefer `displayIndex` for new code.
   */
  index?: number;
  idx?: number;
}
