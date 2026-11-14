import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * Compact "Achievements X / N" progress badge for the Quiz Selection screen.
 * Pure presentation — the parent passes the earned/total counts; no storage or
 * rule logic here. Renders nothing until there is a positive total, so it never
 * shows a meaningless "0 / 0".
 *
 * Accessibility: the count is exposed as a single readable label (not just a
 * visual fraction). No live region — this is static ambient progress, not an
 * event to announce.
 */
@Component({
  selector: 'codelab-achievements-summary',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './achievements-summary.component.html',
  styleUrl: './achievements-summary.component.scss'
})
export class AchievementsSummaryComponent {
  /** Number of achievements earned so far. */
  readonly earned = input<number>(0);
  /** Total number of achievements available. */
  readonly total = input<number>(0);

  /** Screen-reader label, e.g. "Achievements: 3 of 6 earned". */
  readonly label = computed(() => `Achievements: ${this.earned()} of ${this.total()} earned`);
}
