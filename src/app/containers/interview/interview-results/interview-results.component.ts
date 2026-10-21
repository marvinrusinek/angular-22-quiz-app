import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  signal,
  viewChild,
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
import { interviewConfigLabel } from '@shared/models';
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
  private readonly injector = inject(Injector);

  private readonly reviewToggleBtn = viewChild<ElementRef<HTMLButtonElement>>('reviewToggleBtn');
  private readonly reviewHeading = viewChild<ElementRef<HTMLHeadingElement>>('reviewHeading');
  private readonly resultsHeading = viewChild<ElementRef<HTMLHeadingElement>>('resultsHeading');

  /**
   * null until the first real open/close transition — distinguishes "just
   * mounted, showReview() read for the first time" (must NOT steal focus on
   * page load) from an actual toggle.
   */
  private previousShowReview: boolean | null = null;
  private hasFocusedResultsHeading = false;

  constructor() {
    // A completed interview can unlock Interview Master and, in turn, Angular
    // Explorer. Evaluated WITHOUT the quiz bank: Interview Mode is
    // backend-driven and must not load assets/data/quiz.json. Topic-quiz
    // achievements stay with the topic-quiz flow, which already evaluates them.
    // Runs before the certificate-status child checks eligibility. Idempotent.
    this.achievements.evaluateInterviewAchievements();

    // Review focus management. toggleReview() has no focus-management code
    // of its own: the Review section is an ordinary inline area (not a
    // dialog — no focus trap, no role="dialog", confirmed by inspection), so
    // this only needs to move focus to a sensible landing point on open and
    // back to the (now stable, see the template) toggle button on close —
    // never leaving it stranded on <body>.
    effect(() => {
      const open = this.showReview();
      const previous = this.previousShowReview;
      this.previousShowReview = open;
      if (previous === null || previous === open) return; // mount, or no real transition

      // afterNextRender: the heading/button must already be in the DOM
      // (showReview's new value has been rendered) before .focus() can land
      // on them — an arbitrary setTimeout would be a race against that same
      // render, not a guarantee of it.
      afterNextRender(
        () => {
          if (open) {
            this.reviewHeading()?.nativeElement.focus();
          } else {
            this.reviewToggleBtn()?.nativeElement.focus();
          }
        },
        { injector: this.injector }
      );
    });

    /**
     * CONFIRMED (2026-10-17, same traced mechanism as the Interview Session's
     * first-question fix): arriving here from the session's "Submit
     * Assessment" flow leaves focus on `document.body` — the submit button
     * that held focus (restored there by MatDialog when the confirmation
     * dialog closes) is destroyed when the session component tears down,
     * and nothing on this page claims focus afterward. `BackendInterviewTimerService.stop()`
     * is called before navigating (confirmed by reading `submit()`), so no
     * timer interval keeps running or updating after this point — the
     * carried-over speech is Narrator finishing whatever it had QUEUED on
     * the session screen (e.g. "Submitting your assessment…"), not live
     * content still changing. Moves focus to "Assessment Complete" ONCE, the
     * first time a real result renders, giving Narrator a genuine new focus
     * target to interrupt stale queued speech with — the same fix shape as
     * the session's first-question focus, scoped to this page's own entry.
     */
    effect(() => {
      if (this.hasFocusedResultsHeading || !this.result()) return;
      this.hasFocusedResultsHeading = true;
      afterNextRender(() => this.resultsHeading()?.nativeElement.focus(), {
        injector: this.injector
      });
    });
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

  /**
   * CONFIRMED (manual Narrator report, 2026-10-18): "Focus changes:" and
   * its value were read separately. Verified NOT a Tab-stop issue first
   * (traced a full keyboard Tab cycle in the real page: this paragraph
   * has no tabindex and is never focused) — the split is a reading
   * artifact, same class as the stat-grid's, fixed the same confirmed
   * way: one real-text phrase, exposed through the existing paragraph
   * (role="group" replacing the unused role="status" — nothing here
   * ever live-updates after the frozen result loads, so "status" was
   * never doing anything), with the always-visible text aria-hidden so
   * it isn't ALSO read. Comma phrasing matches every other stat's
   * "Label, value" convention.
   */
  readonly focusChangesAccessibleLabel = computed(() => $localize`Focus changes, ${this.focusChanges()}`);

  readonly reviewQuestions = computed(() => this.result()?.review ?? []);
  readonly timeUsed = computed(() => formatMMSS(this.result()?.timeUsedSeconds ?? 0));

  /**
   * CONFIRMED (manual Narrator Scan Mode report, 2026-10-18): the score
   * hero and each stat-grid entry were read as SEPARATE lines — "70%" then
   * "7 / 10 correct" as two stops; "Answered" then "10" as two more — not
   * as one coherent phrase. Inspecting the real markup: `dt`/`dd` are
   * block-level by default, and Scan Mode treats each block as its own
   * line, independent of any ARIA role on an ancestor `<div>`.
   *
   * ORIGINAL FIX for both (still what the stat-grid labels below use),
   * reusing the technique already confirmed working for the catalog-stats
   * row in QuizSelectionComponent: a bare role-less element holding real
   * text was confirmed PRUNED from the tree entirely (`ignored: true`) in
   * an earlier, reverted candidate — a ROLE is what keeps it exposed, not
   * the text alone, and an attribute-only name (aria-label on a `group`)
   * was separately found unreliable for Scan Mode's non-focusable reading
   * cursor. So: one combined phrase, as REAL TEXT, inside a `role="group"`
   * span — never an attribute on that role. The existing visible pieces
   * stay exactly as rendered (unchanged layout) but get `aria-hidden` so
   * they don't ALSO get read separately.
   *
   * score-hero SPECIFICALLY diverged from this after FIVE further rounds
   * of confirmed highlight-geometry defects (role on the wrong node;
   * off-screen text; a full-card overlay misaligned by the parent's own
   * padding; an embedded line break that still measured zero-height via
   * `DOM.getBoxModel`, confirmed via CDP in a real session) — every one
   * of them because the accessible object Narrator highlights is always
   * the text-bearing LEAF holding the name, never the `group` ancestor,
   * and a hidden leaf's own element box doesn't reliably span two visual
   * lines. Current fix: `role="img"` (see the .html file's own comment)
   * — its name comes from `aria-label`, not a text descendant, so there
   * is no separate leaf at all; the highlighted object is the real
   * `.score-hero` div, whose own box already spans both visible lines.
   * UNVERIFIED: whether Narrator speaks this as one phrase, and whether
   * `role="img"` adds an audible "graphic"/"image" prefix — needs a
   * manual retest before this can be called confirmed.
   */
  readonly scoreAccessibleSummary = computed(() => {
    const r = this.result();
    if (!r) return '';
    return $localize`${r.percentage}%, ${r.correct} out of ${r.total} correct`;
  });

  readonly answeredAccessibleLabel = computed(() =>
    $localize`Answered, ${this.result()?.answered ?? 0}`
  );
  readonly unansweredAccessibleLabel = computed(() =>
    $localize`Unanswered, ${this.result()?.unanswered ?? 0}`
  );
  readonly correctAccessibleLabel = computed(() =>
    $localize`Correct, ${this.result()?.correct ?? 0}`
  );
  readonly incorrectAccessibleLabel = computed(() =>
    $localize`Incorrect, ${this.result()?.incorrect ?? 0}`
  );
  readonly timeUsedAccessibleLabel = computed(() => $localize`Time used, ${this.spokenTimeUsed()}`);
  readonly difficultyAccessibleLabel = computed(() => {
    const difficulty = this.difficultyLabel();
    if (!difficulty) return '';
    const titleCased = difficulty.charAt(0).toUpperCase() + difficulty.slice(1);
    return $localize`Difficulty, ${titleCased}`;
  });

  /**
   * Full-word duration for speech ("2 minutes 43 seconds"), distinct from
   * `timeUsed()`'s `M:SS` clock display — a spoken "2:43" is ambiguous
   * read aloud. Interview durations never reach an hour (the timer's own
   * max), so hours are deliberately not handled here.
   */
  private readonly spokenTimeUsed = computed(() => {
    const total = Math.max(0, Math.floor(this.result()?.timeUsedSeconds ?? 0));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    const minutesPart =
      minutes > 0 ? (minutes === 1 ? $localize`1 minute` : $localize`${minutes} minutes`) : '';
    const secondsPart = seconds === 1 ? $localize`1 second` : $localize`${seconds} seconds`;
    return minutesPart ? `${minutesPart} ${secondsPart}` : secondsPart;
  });

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
