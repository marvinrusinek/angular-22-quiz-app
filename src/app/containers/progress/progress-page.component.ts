import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  afterNextRender,
  computed,
  inject,
  viewChild
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';

import { PerformanceInsightsComponent } from '../../components/performance-insights/performance-insights.component';
import { ProgressSummaryComponent } from '../../components/progress-summary/progress-summary.component';
import { ScrollDownIndicatorComponent } from '../../components/scroll-down-indicator/scroll-down-indicator.component';
import { ThemeToggleComponent } from '../../components/theme-toggle/theme-toggle.component';
import { Quiz, QuizDifficulty } from '@shared/models';
import { TopicQuizMetadataService } from '@shared/services/api/topic-quiz-metadata.service';
import { PerformanceInsightsService } from '@shared/services/progress/performance-insights.service';
import { ProgressService } from '@shared/services/progress/progress.service';
import { swallow } from '@shared/utils/error-logging';

/**
 * Your Progress — aggregate performance across attempts and modes.
 *
 *   Results            → ONE completed attempt
 *   Interview History  → individual historical Interview attempts
 *   Progress (here)    → the aggregate across attempts and modes
 *
 * A page container, not a state layer: every number comes from a service that
 * already owns it (ProgressService for the completion summary,
 * PerformanceInsightsService for the histories). This component only composes
 * them, decides between the dashboard and the empty state, and loads the
 * metadata the summary needs.
 *
 * It is directly reachable by anyone — there is deliberately NO guard. A user
 * with no history gets an empty state, never a redirect. It also touches no
 * storage and never marks engagement, so visiting it changes nothing.
 */
@Component({
  selector: 'codelab-progress-page',
  standalone: true,
  imports: [
    RouterLink,
    ThemeToggleComponent,
    ProgressSummaryComponent,
    PerformanceInsightsComponent,
    ScrollDownIndicatorComponent
  ],
  templateUrl: './progress-page.component.html',
  styleUrls: ['./progress-page.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ProgressPageComponent implements OnInit {
  private readonly metadataApi = inject(TopicQuizMetadataService);
  private readonly progressService = inject(ProgressService);
  private readonly destroyRef = inject(DestroyRef);

  /** The page heading — the focus target on route entry. */
  private readonly heading = viewChild<ElementRef<HTMLElement>>('pageHeading');

  /** Read-only Performance Insights (Topic Quiz, Interview and Practice histories). */
  readonly insights = inject(PerformanceInsightsService).insights;

  /**
   * The minimal catalog ProgressService needs: which quizzes exist, their
   * difficulty, title and question count. Deliberately page-local and limited
   * to those fields — no summary/image/facts/status. `summary` and `image` are
   * required by the Quiz type but never read by the progress summary.
   *
   * Seeded from the bundled catalog on first paint and overwritten when the
   * API answers; a failed request leaves the seed in place (never blank).
   */
  private readonly catalog = computed<Quiz[]>(() => {
    const difficulties = this.metadataApi.difficultyByQuiz();
    const milestones = this.metadataApi.milestoneByQuiz();
    const counts = this.metadataApi.questionCountByQuiz();

    return [...difficulties.keys()].map((quizId): Quiz => ({
      quizId,
      milestone: milestones.get(quizId) ?? quizId,
      summary: '',
      image: '',
      difficulty: (difficulties.get(quizId) ?? undefined) as QuizDifficulty | undefined,
      questionCount: counts.get(quizId) ?? undefined
    }));
  });

  /** Completion summary (overall, difficulty, stats, strongest). Same service Quiz Selection used. */
  readonly summary = computed(() => this.progressService.getProgressSummary(this.catalog()));

  /**
   * Whether the user has any progress at all — DURABLE sources only:
   *
   *   - a completed Topic Quiz in the summary (covers users whose only record
   *     is the best-score store, from before histories existed), or
   *   - any Topic Quiz / Interview / Practice history in Performance Insights.
   *
   * Not `insights().hasData` alone: that never sees best scores, so a legacy
   * user would be shown the empty state despite real completions. And nothing
   * session-scoped (card states, sessionStorage, engagement) — a dashboard of
   * durable history must not depend on what happened in this tab.
   */
  readonly hasProgress = computed(
    () => this.summary().completedCount > 0 || this.insights().hasData
  );

  constructor() {
    // Route entry: move focus to the page heading so keyboard and screen-reader
    // users start at the top of the new page instead of on <body> (the outlet
    // is re-created on every navigation). preventScroll — ngOnInit already
    // scrolled to the top, and focus must not fight it.
    afterNextRender(() => this.heading()?.nativeElement.focus({ preventScroll: true }));
  }

  ngOnInit(): void {
    // Open at the TOP, not at whatever offset the previous (long) page had.
    try {
      window.scrollTo({ top: 0, left: 0 });
    } catch (err: unknown) {
      // Non-fatal in non-browser test environments.
      swallow('progress-page#scrollTop', err);
    }

    // One in-flight request shared by every caller; never rejects, so the
    // error handler is only a safeguard. The bundled seed paints first.
    this.metadataApi
      .load()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ error: () => undefined });
  }
}
