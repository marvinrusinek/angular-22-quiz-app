import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  ViewEncapsulation
} from '@angular/core';
import { TitleCasePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';

import { ActivatedRoute } from '@angular/router';

import { formatMMSS } from '@shared/utils/format-time';
import { BackendInterviewResultService } from '@shared/services/interview/backend-interview-result.service';
import { BackendInterviewSessionService } from '@shared/services/interview/backend-interview-session.service';
import { AssessmentIntegrityService } from '@shared/services/features/interview/assessment-integrity.service';
import { InterviewAnalyticsService } from '@shared/services/features/interview/interview-analytics.service';
import { InterviewHistoryService } from '@shared/services/features/interview/interview-history.service';
import { interviewConfigLabel } from '@shared/models/interview-preset.model';
import { ThemeToggleComponent } from '../../../components/theme-toggle/theme-toggle.component';
import { InterviewReviewComponent } from '../../../components/interview/interview-review/interview-review.component';
import { PerformanceTrendsComponent } from '../../../components/interview/performance-trends/performance-trends.component';
import { TopicPerformanceListComponent } from '../../../components/interview/topic-performance/topic-performance-list.component';
import { InterviewReadinessComponent } from '../../../components/interview/interview-readiness/interview-readiness.component';
import { InterviewReadinessService } from '@shared/services/features/interview/interview-readiness.service';
import { ScrollDownIndicatorComponent } from '../../../components/scroll-down-indicator/scroll-down-indicator.component';
import { InterviewCertificateStatusComponent } from '../../../components/interview/interview-certificate-status/interview-certificate-status.component';
import { AchievementService } from '@shared/services/achievements/achievement.service';

/**
 * Interview Results ("Assessment Complete"). Self-contained score summary +
 * per-topic breakdown from the submitted result. It NEVER writes topic-quiz
 * progress/best-score/achievement state. Full Review (per-question answers +
 * explanations) is added in the next milestone.
 */
@Component({
  selector: 'codelab-interview-results',
  standalone: true,
  imports: [
    TitleCasePipe,
    RouterLink,
    ThemeToggleComponent,
    InterviewReviewComponent,
    PerformanceTrendsComponent,
    TopicPerformanceListComponent,
    InterviewReadinessComponent,
    ScrollDownIndicatorComponent,
    InterviewCertificateStatusComponent
  ],
  templateUrl: './interview-results.component.html',
  styleUrls: ['./interview-results.component.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InterviewResultsComponent {
  private readonly results = inject(BackendInterviewResultService);
  private readonly session = inject(BackendInterviewSessionService);
  private readonly integrity = inject(AssessmentIntegrityService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly analyticsService = inject(InterviewAnalyticsService);
  private readonly history = inject(InterviewHistoryService);
  private readonly readinessService = inject(InterviewReadinessService);
  private readonly achievements = inject(AchievementService);

  constructor() {
    // A completed interview can unlock Interview Master and, in turn, Angular
    // Explorer. Evaluated WITHOUT the quiz bank: Interview Mode is
    // backend-driven and must not load assets/data/quiz.json. Topic-quiz
    // achievements stay with the topic-quiz flow, which already evaluates them.
    // Runs before the certificate-status child checks eligibility. Idempotent.
    this.achievements.evaluateInterviewAchievements();
  }

  /**
   * The frozen backend result. Loaded once by the guard through the shared
   * pipeline, so this page issues no request of its own and never computes a
   * score locally.
   */
  readonly result = this.results.result;
  readonly loadError = this.results.error;
  readonly retrying = this.results.loading;

  private readonly routeSessionId = computed(
    () => this.route.snapshot.paramMap.get('sessionId') ?? ''
  );

  // Role-preset name, or "Custom Interview". Single-sourced from the preset
  // model so the label can never drift from the definitions.
  readonly interviewKindLabel = computed(() => {
    const config = this.result()?.config;
    return interviewConfigLabel(
      config?.mode === 'preset' ? 'preset' : 'custom',
      config?.presetId,
      undefined
    );
  });

  /**
   * A role preset deliberately MIXES difficulties, so there is no single value
   * to show; only a custom interview has one the user chose.
   */
  readonly difficultyLabel = computed(() => this.result()?.config.difficulty ?? '');

  /** Client-observed only. Never scored, never sent to the backend. */
  readonly focusChanges = this.integrity.focusLossCount;

  readonly reviewQuestions = computed(() => this.result()?.review ?? []);
  readonly timeUsed = computed(() => formatMMSS(this.result()?.timeUsedSeconds ?? 0));

  // Topic Performance analytics — derived from the FROZEN backend per-topic
  // buckets. No re-scoring, and topic titles are never re-resolved locally.
  readonly analytics = computed(() => {
    const r = this.result();
    if (!r) return this.analyticsService.analyze(null);
    return this.analyticsService.analyze({
      total: r.total,
      answered: r.answered,
      unanswered: r.unanswered,
      correct: r.correct,
      incorrect: r.incorrect,
      percentage: r.percentage,
      timeUsedSeconds: r.timeUsedSeconds,
      timeRemainingSeconds: 0,
      difficulty: (r.config.difficulty ?? 'mixed') as never,
      topicIds: [...r.config.topicIds],
      perTopic: r.byTopic.map((t) => ({
        quizId: t.topicId,
        title: t.title,
        correct: t.correct,
        total: t.total,
        percentage: t.percentage
      })),
      submittedByExpiry: r.submittedByExpiry,
      focusChanges: this.integrity.focusLossCount()
    });
  });

  /** Retry after a backend outage — same pipeline the guard used. */
  async retryLoad(): Promise<void> {
    await this.results.reload(this.routeSessionId());
  }

  // Performance Trends — derived purely from the persisted attempt history (which
  // already includes this attempt: it is recorded at submission, before Results
  // renders). Presentation only; storage + trend math live in the history service.
  readonly trends = this.history.trends;

  // Interview Readiness — coaching indicator derived from retained history (which
  // already includes this attempt). Presentation-free scoring lives in the service.
  readonly readiness = this.readinessService.readiness;

  // The just-recorded attempt (last in history) — supplies Review's header meta
  // (attempt number + date). Read-only; never mutated.
  readonly latestAttempt = computed(() => this.history.history().at(-1) ?? null);
  readonly showReview = signal(false);

  toggleReview(): void {
    this.showReview.update((v) => !v);
  }

  buildAnother(): void {
    this.endSession();
    this.router.navigate(['/interview']);
  }

  returnToSelection(): void {
    this.endSession();
    this.router.navigate(['/quiz']);
  }

  /**
   * Leaving Results ends the attempt: the in-memory result is dropped and the
   * session reference cleared, so the backend review is no longer reachable.
   * History keeps the sanitized summary.
   */
  private endSession(): void {
    this.results.clear();
    this.session.clearSession();
    this.integrity.reset();
  }
}
