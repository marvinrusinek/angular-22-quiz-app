import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';

import { ProgressSummary } from '@shared/models';

/**
 * Compact "Your Progress" snapshot for the dashboard. Presentational: it only
 * formats a ProgressSummary the parent already derived from the durable
 * best-score store, so Topic Quiz numbers are never mixed with Interview Mode.
 * The full breakdown stays on the /progress page ("View Progress").
 */
@Component({
  selector: 'codelab-dashboard-progress',
  standalone: true,
  imports: [RouterLink, MatIconModule],
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

  /** Spoken phrases: one real-text group per stat (see the template). */
  readonly completedLabel = computed(
    () => $localize`${this.completed()} of ${this.total()} quizzes completed`
  );
  readonly averageLabel = computed(() => {
    const s = this.summary();
    return s && s.completedCount > 0
      ? $localize`Average score ${s.averageScore} percent`
      : $localize`Average score not available yet`;
  });
  readonly perfectLabel = computed(
    () => $localize`${this.perfect()} perfect scores`
  );
}
