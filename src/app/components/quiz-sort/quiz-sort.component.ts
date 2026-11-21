import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

import { AlphaDirection, DifficultyDirection } from '@shared/models';

/**
 * Presentational sort control: two compact toggle buttons, `[ Difficulty ↑ ]`
 * and `[ A–Z ]`. They drive two independent dimensions that the parent composes:
 *   - difficulty direction (↑ Beginner → Advanced / ↓ Advanced → Beginner) — the
 *     primary grouping
 *   - alphabetical direction (A–Z / Z–A) applied WITHIN each difficulty group
 * Each button shows the direction currently applied and flips only its own
 * dimension when activated. It holds NO sorting logic and knows nothing about
 * quiz data — it reflects the current values and emits the new one; the parent
 * owns the state and performs the actual sort.
 *
 * The difficulty name states the applied direction; its tooltip explains the
 * action. The alphabetical name includes both the current order and the action.
 * Its tooltip matches that name to avoid a redundant accessible description.
 */
@Component({
  selector: 'app-quiz-sort',
  standalone: true,
  imports: [MatIconModule, MatTooltipModule],
  templateUrl: './quiz-sort.component.html',
  styleUrls: ['./quiz-sort.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class QuizSortComponent {
  readonly difficultyDirection = input.required<DifficultyDirection>();
  readonly alphaDirection = input.required<AlphaDirection>();

  readonly difficultyDirectionChange = output<DifficultyDirection>();
  readonly alphaDirectionChange = output<AlphaDirection>();

  readonly difficultyLabel = computed(() =>
    this.difficultyDirection() === 'asc'
      ? $localize`Sort by difficulty ascending`
      : $localize`Sort by difficulty descending`
  );

  readonly difficultyHint = computed(() =>
    this.difficultyDirection() === 'asc'
      ? $localize`Beginner to Advanced. Select to sort Advanced to Beginner.`
      : $localize`Advanced to Beginner. Select to sort Beginner to Advanced.`
  );

  readonly alphaLabel = computed(() =>
    this.alphaDirection() === 'az'
      ? $localize`Sort alphabetically A to Z within each difficulty. Select to sort Z to A.`
      : $localize`Sort alphabetically Z to A within each difficulty. Select to sort A to Z.`
  );

  toggleDifficulty(): void {
    this.difficultyDirectionChange.emit(this.difficultyDirection() === 'asc' ? 'desc' : 'asc');
  }

  toggleAlpha(): void {
    this.alphaDirectionChange.emit(this.alphaDirection() === 'az' ? 'za' : 'az');
  }
}
