import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';

import { ProgressSummary } from '@shared/models';

import { IntroExposedTextDirective } from '../../containers/introduction/intro-exposed-text.directive';

/**
 * Compact "Your Progress" snapshot for the dashboard. Presentational: it only
 * formats a ProgressSummary the parent already derived from the durable
 * best-score store, so Topic Quiz numbers are never mixed with Interview Mode.
 * The full breakdown stays on the /progress page ("View Progress").
 */
@Component({
  selector: 'codelab-dashboard-progress',
  standalone: true,
  imports: [RouterLink, MatIconModule, IntroExposedTextDirective],
  templateUrl: './dashboard-progress.component.html',
  styleUrl: './dashboard-progress.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DashboardProgressComponent {
  readonly summary = input<ProgressSummary | null>(null);

  readonly completed = computed(() => this.summary()?.completedCount ?? 0);
  readonly total = computed(() => this.summary()?.totalCount ?? 0);
  readonly perfect = computed(() => this.summary()?.perfectScores ?? 0);

  /** "78%", or an em dash until at least one quiz has been completed. */
  readonly average = computed(() => {
    const s = this.summary();
    return s && s.completedCount > 0 ? `${s.averageScore}%` : '—';
  });

  /** True once at least one quiz is completed; until then the average is unavailable (never shown as 0%). */
  readonly averageAvailable = computed(() => (this.summary()?.completedCount ?? 0) > 0);

  /** Spoken phrases: each is the ONE exposed text item of its statistic's group (see the template). */
  readonly completedLabel = computed(
    () => $localize`${this.completed()} Quizzes Completed`
  );
  readonly averageLabel = computed(() => {
    const s = this.summary();
    return s && s.completedCount > 0
      ? $localize`${s.averageScore}% Average Score`
      : $localize`Average score not available yet`;
  });
  readonly perfectLabel = computed(
    () => $localize`${this.perfect()} Perfect Scores`
  );

  /**
   * The exposed text of a statistic whose phrase is "<value> <label>". The exposed text is laid out to wrap like the visible
   * statistic, which is TWO rows: the value, then the whole label. A two-word label would otherwise wrap at its own width as
   * "<value> <first word>" / "<second word>", which is not what is on screen (Narrator read only "20 Quizzes" and drew its
   * box around "20"). Joining the label's words with no-break spaces keeps the label on one row, so the exposed rows are
   * exactly the visible ones. The spoken words are unchanged (a no-break space is read as a space). A phrase that is not
   * "<value> <label>" (the average's empty state) is returned as it is.
   */
  private exposedRows(phrase: string, value: string): string {
    const prefix = `${value} `;
    return phrase.startsWith(prefix) ? prefix + phrase.slice(prefix.length).replace(/ /g, '\u00A0') : phrase;
  }

  readonly completedExposed = computed(() => this.exposedRows(this.completedLabel(), String(this.completed())));
  readonly averageExposed = computed(() => this.exposedRows(this.averageLabel(), this.average()));
  readonly perfectExposed = computed(() => this.exposedRows(this.perfectLabel(), String(this.perfect())));
}
