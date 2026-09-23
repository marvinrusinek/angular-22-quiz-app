import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { MatExpansionModule } from '@angular/material/expansion';

import { ProgressSummary } from '../../shared/models/progress.model';
import { PerformanceInsightsService } from '../../shared/services/progress/performance-insights.service';
import { PerformanceInsightsComponent } from '../performance-insights/performance-insights.component';
import { QuizCardProgressState } from '../quiz-card-progress/quiz-card-progress.component';
import { ProgressSummaryComponent } from '../progress-summary/progress-summary.component';

/**
 * Compact, collapsible "Your Progress" panel for the Quiz Selection page.
 *
 * - Renders NOTHING unless the user has activity (≥1 quiz In Progress or
 *   Completed), derived from the passed card states — no extra persisted flag.
 * - Collapsed by default; the header stays useful without expanding
 *   ("Your Progress — 3 of 15 completed · 20%").
 * - The full breakdown (difficulty / strongest / needs-review) lives in the
 *   expanded body via ProgressSummaryComponent's 'details' variant, so nothing
 *   is duplicated between header and body.
 *
 * Pure presentation. Keyboard access + expanded/collapsed semantics come from
 * MatExpansionPanel; the header summary is plain text (never color-only).
 */
@Component({
  selector: 'codelab-progress-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatExpansionModule, ProgressSummaryComponent, PerformanceInsightsComponent],
  template: `
    @if (hasActivity() && summary(); as s) {
      <mat-accordion class="progress-panel">
        <mat-expansion-panel class="progress-panel__panel">
          <mat-expansion-panel-header class="progress-panel__header">
            <mat-panel-title class="progress-panel__title" i18n>Your Progress</mat-panel-title>
            <mat-panel-description class="progress-panel__desc" i18n>
              {{ s.completedCount }} of {{ s.totalCount }} completed · {{ s.completionPercentage }}%
            </mat-panel-description>
          </mat-expansion-panel-header>

          <codelab-progress-summary [summary]="s" variant="details" />
          <codelab-performance-insights [insights]="insights()" />
        </mat-expansion-panel>
      </mat-accordion>
    }
  `,
  styles: [`
    .progress-panel {
      display: block;
      max-width: 560px;
      margin: 4px auto 18px;
    }

    .progress-panel__panel {
      background: var(--bg-secondary, rgba(255, 255, 255, 0.6));
    }

    .progress-panel__title {
      flex: 0 0 auto;
      margin-right: 16px;
      font-weight: 700;
      color: var(--text-primary, #212121);
    }

    .progress-panel__desc {
      justify-content: flex-start;
      font-variant-numeric: tabular-nums;
      color: var(--text-secondary, #555555);
    }

    @media (max-width: 600px) {
      .progress-panel {
        margin: 4px 8px 16px;
      }
    }
  `]
})
export class ProgressPanelComponent {
  /** Read-only Performance Insights, shown beneath the progress breakdown. */
  protected readonly insights = inject(PerformanceInsightsService).insights;

  /** Derived aggregate progress shown in the header + expanded body. */
  readonly summary = input<ProgressSummary | null>(null);
  /** Per-quiz card states; the panel shows only when at least one is not 'not-started'. */
  readonly cardStates = input<readonly QuizCardProgressState[]>([]);

  /**
   * True when the user has any In Progress or Completed quiz, OR any real
   * progress Performance Insights already represents (Topic Quiz, Interview
   * or Practice — see PerformanceInsights.hasData). `cardStates` alone is
   * Topic-Quiz-tile-state only and knows nothing about Interview history, so
   * a Custom or preset Interview completed without ever touching a Topic
   * Quiz tile would otherwise leave this panel hidden even after the parent
   * (QuizSelectionComponent.showSelectionProgress) opens for exactly that
   * attempt. Reuses the ALREADY-injected PerformanceInsightsService signal —
   * no new injection, no new storage read, no duplicated history logic.
   */
  readonly hasActivity = computed(() =>
    this.cardStates().some(state => state !== 'not-started') || this.insights().hasData
  );
}
