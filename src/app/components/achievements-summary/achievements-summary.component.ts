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
  template: `
    @if (total() > 0) {
      <section
        class="achievements-summary"
        [attr.aria-label]="label()"
      >
        <span
          class="achievements-summary__icon"
          aria-hidden="true"
        >
          🏆
        </span>
        <span
          class="achievements-summary__label"
          aria-hidden="true"
        >
          <ng-container i18n>Achievements</ng-container>
        </span>
        <span
          class="achievements-summary__count"
          aria-hidden="true"
        >
          {{ earned() }} / {{ total() }}
        </span>
      </section>
    }
  `,
  styles: [
    `
      .achievements-summary {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        border: 1px solid var(--border-color, #e0e0e0);
        border-radius: 999px;
        background: var(--bg-secondary, #f5f5f5);
        font-size: 13px;
        color: var(--text-primary, #212121);
        white-space: nowrap; /* keep "Achievements X / N" on ONE line (never wraps) */
      }

      .achievements-summary__icon {
        font-size: 15px;
        line-height: 1;
      }

      .achievements-summary__label {
        font-weight: 600;
      }

      .achievements-summary__count {
        font-variant-numeric: tabular-nums;
        color: var(--text-secondary, #555555);
      }
    `
  ]
})
export class AchievementsSummaryComponent {
  /** Number of achievements earned so far. */
  readonly earned = input<number>(0);
  /** Total number of achievements available. */
  readonly total = input<number>(0);

  /** Screen-reader label, e.g. "Achievements: 3 of 6 earned". */
  readonly label = computed(() => `Achievements: ${this.earned()} of ${this.total()} earned`);
}
