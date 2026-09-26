import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';

import type { DifficultyFilter } from '@shared/models';

/**
 * Presentational difficulty FILTER: a compact Material select offering
 * "All Difficulties", "Beginner", "Intermediate" and "Advanced".
 *
 * It only reflects the value it is given and emits the new one; it knows nothing
 * about quiz data, search or sorting — the parent owns the state and performs the
 * filtering. It is deliberately separate from the sort control: choosing a
 * difficulty here changes WHICH quizzes are shown, never their order.
 *
 * Accessibility comes from MatSelect itself (combobox/listbox semantics, arrow
 * keys, type-ahead, Escape, focus return, the selected value announced); this
 * component only supplies the accessible name and a tooltip. Both are the same
 * fixed text ("Filter quizzes by difficulty") whichever difficulty is selected —
 * the selected value itself is what the control displays.
 */
@Component({
  selector: 'app-quiz-difficulty-filter',
  standalone: true,
  imports: [MatSelectModule, MatTooltipModule],
  templateUrl: './quiz-difficulty-filter.component.html',
  styleUrls: ['./quiz-difficulty-filter.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class QuizDifficultyFilterComponent {
  readonly difficulty = input.required<DifficultyFilter>();

  readonly difficultyChange = output<DifficultyFilter>();

  // Whether the option list is open. The tooltip is switched off while it is, so it
  // is not left showing (half-hidden) behind the list.
  readonly panelOpen = signal(false);

  onSelectionChange(value: DifficultyFilter): void {
    this.difficultyChange.emit(value);
  }
}
