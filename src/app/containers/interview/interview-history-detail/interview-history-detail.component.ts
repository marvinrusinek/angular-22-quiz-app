import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  ViewEncapsulation
} from '@angular/core';
import { TitleCasePipe, ViewportScroller } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';

import { formatDuration } from '@shared/utils/format-time';
import { swallow } from '@shared/utils/error-logging';
import { InterviewResult } from '@shared/models/InterviewResult.model';
import { InterviewDifficulty } from '@shared/models/AssessmentConfig.model';
import { InterviewAttemptHistoryEntry } from '@shared/models/interview-history.model';
import { InterviewHistoryService } from '@shared/services/features/interview/interview-history.service';
import { InterviewAnalyticsService } from '@shared/services/features/interview/interview-analytics.service';
import { ThemeToggleComponent } from '../../../components/theme-toggle/theme-toggle.component';
import { TopicPerformanceListComponent } from '../../../components/interview/topic-performance/topic-performance-list.component';
import { ScrollDownIndicatorComponent } from '../../../components/scroll-down-indicator/scroll-down-indicator.component';
import { InterviewReviewComponent } from '../../../components/interview/interview-review/interview-review.component';
import { InterviewSessionReferenceStorage } from '@shared/services/interview/interview-session-reference.storage';
import { InterviewApiService } from '@shared/services/api/interview-api.service';
import type { InterviewResultViewModel } from '@shared/models/interview/interview-view-models';

/**
 * Read-only historical Interview summary. Reopens the details for ONE past
 * attempt (by id) from the shared InterviewHistoryService — it reconstructs an
 * InterviewResult from the compact stored analytics purely to reuse
 * InterviewAnalyticsService + the Topic Performance presentation.
 *
 * Strictly historical + read-only: no session, no timer, no answer controls, no
 * path back into an active interview.
 *
 * It no longer renders a per-question review. Sanitized v2 history keeps
 * analytics only — the questions, answers, correctness and explanations live on
 * the backend and are shown for the current attempt while its session reference
 * is alive. The page says so rather than implying the review is retained.
 */
@Component({
  selector: 'codelab-interview-history-detail',
  standalone: true,
  imports: [
    TitleCasePipe,
    RouterLink,
    ThemeToggleComponent,
    TopicPerformanceListComponent,
    InterviewReviewComponent,
    ScrollDownIndicatorComponent
  ],
  templateUrl: './interview-history-detail.component.html',
  styleUrls: ['./interview-history-detail.component.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InterviewHistoryDetailComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly history = inject(InterviewHistoryService);
  private readonly analyticsService = inject(InterviewAnalyticsService);
  private readonly viewport = inject(ViewportScroller);
  private readonly sessionRef = inject(InterviewSessionReferenceStorage);
  private readonly api = inject(InterviewApiService);

  constructor() {
    // The review lives on the server; ask for it as soon as the attempt is
    // known, so the page fills in without the user doing anything.
    effect(() => void this.loadPastReview());

    // Deep-link support: arriving with #review (e.g. the "Review Answers"
    // shortcut on a History card) scrolls straight to the answers once rendered.
    afterNextRender(() => {
      if (this.route.snapshot.fragment === 'review' && this.hasReview()) {
        this.viewport.scrollToAnchor('review');
      }
    });
  }

  private readonly params = toSignal(this.route.paramMap, { initialValue: null });
  readonly id = computed(() => this.params()?.get('id') ?? null);

  // The requested attempt + its lifetime attempt number, or null if not found.
  readonly found = computed(() => {
    const all = this.history.history();
    const id = this.id();
    const index = all.findIndex((e) => e.id === id);
    if (index === -1) return null;
    const entry = all[index];
    // "of M" uses the highest lifetime attempt number (the newest retained entry
    // always holds it), so it stays correct even after older attempts age out.
    const total = all.reduce((m, e, i) => Math.max(m, e.attemptNumber ?? i + 1), all.length);
    return { entry, number: entry.attemptNumber ?? index + 1, total };
  });

  readonly entry = computed<InterviewAttemptHistoryEntry | null>(() => this.found()?.entry ?? null);

  // Reconstruct an InterviewResult once — reused for both the analytics pipeline
  // (topic bands, highlights) and the Review Answers summary/topic-name lookup.
  readonly result = computed<InterviewResult | null>(() => {
    const e = this.entry();
    return e ? toResult(e) : null;
  });

  readonly analytics = computed(() => {
    const r = this.result();
    return r ? this.analyticsService.analyze(r) : null;
  });

  /**
   * The FROZEN backend review for this past attempt, fetched on demand.
   *
   * History itself stores no questions, options, correctness or explanations —
   * that answer key is exactly what the backend migration took out of the
   * browser. What history keeps is a durable POINTER (session id + read-only
   * token), so the review can be asked for from the server instead.
   */
  private readonly _pastResult = signal<InterviewResultViewModel | null>(null);
  readonly reviewQuestions = computed(() => this._pastResult()?.review ?? []);
  readonly pastResult = this._pastResult.asReadonly();
  readonly hasReview = computed(() => this.reviewQuestions().length > 0);

  /** Distinguishes "still loading" from "genuinely unavailable" in the view. */
  private readonly _reviewLoading = signal(false);
  readonly reviewLoading = this._reviewLoading.asReadonly();

  /**
   * Fetch the review for the attempt currently being viewed.
   *
   * Silent on failure by design: the attempt's summary is already on screen and
   * still correct, so a missing review degrades to the explanatory note rather
   * than an error banner. It legitimately goes missing when the backend has
   * dropped the session — on the free tier that happens on every restart.
   */
  private async loadPastReview(): Promise<void> {
    const sessionId = this.entry()?.sessionId;
    if (!sessionId || this._pastResult()?.sessionId === sessionId) return;

    // Only the ACTIVE session reference can authorize this, and it lives in
    // sessionStorage. Once the tab is gone the attempt is summary-only.
    const reference = this.sessionRef.read();
    if (reference?.sessionId !== sessionId) return;

    this._reviewLoading.set(true);
    try {
      this._pastResult.set(
        await firstValueFrom(this.api.getResult(sessionId, reference.sessionToken))
      );
    } catch (err: unknown) {
      this._pastResult.set(null);
      swallow('interview-history-detail#loadPastReview', err);
    } finally {
      this._reviewLoading.set(false);
    }
  }

  // Performance context — reuse the shared trends (no independent recalculation).
  readonly trends = this.history.trends;

  // An unretained duration reads as "Not recorded" — never a misleading "0s".
  duration(seconds: number | undefined): string {
    return seconds == null ? $localize`Not recorded` : formatDuration(seconds);
  }

  completionLabel(entry: InterviewAttemptHistoryEntry): string {
    return entry.completionReason === 'time-expired'
      ? $localize`Time expired`
      : $localize`Submitted`;
  }

  /** "July 21, 2026" — locale-formatted, safe fallback. */
  formatDate(iso: string): string {
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    } catch {
      return iso;
    }
  }
}

/**
 * Reconstruct an InterviewResult from a compact history entry, for the topic
 * analytics pipeline only.
 *
 * Sanitized v2 records carry answered/unanswered/incorrect from the BACKEND, so
 * they are used verbatim when present. Migrated v1 records have neither those
 * fields nor a review snapshot to infer them from, so they fall back to
 * treating every question as answered rather than inventing a split.
 */
function toResult(e: InterviewAttemptHistoryEntry): InterviewResult {
  const unanswered = e.unanswered ?? 0;
  const answered = e.answered ?? Math.max(0, e.totalQuestions - unanswered);
  return {
    total: e.totalQuestions,
    answered,
    unanswered,
    correct: e.score,
    incorrect: e.incorrect ?? Math.max(0, answered - e.score),
    percentage: e.percentage,
    timeUsedSeconds: e.timeUsedSeconds ?? e.durationSeconds ?? 0,
    timeRemainingSeconds: 0,
    // A role preset mixes difficulties, so there is no single value to show.
    // 'mixed' is the honest label here, not a substituted difficulty.
    difficulty: (e.configuredDifficulty ?? 'mixed') as InterviewDifficulty,
    topicIds: [...(e.selectedTopicIds ?? [])],
    perTopic: e.topicPerformance.map((t) => ({
      quizId: t.topicId,
      title: t.topicName,
      correct: t.correct,
      total: t.total,
      percentage: t.percentage
    })),
    submittedByExpiry: e.completionReason === 'time-expired',
    focusChanges: e.focusChanges ?? 0
  };
}
