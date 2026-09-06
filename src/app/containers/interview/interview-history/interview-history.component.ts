import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  ViewEncapsulation,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild
} from '@angular/core';
import { TitleCasePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Toolbar, ToolbarWidget, ToolbarWidgetGroup } from '@angular/aria/toolbar';

import { formatDuration } from '../../../shared/utils/format-time';
import { swallow } from '../../../shared/utils/error-logging';
import { InterviewAttemptHistoryEntry } from '../../../shared/models/interview-history.model';
import { interviewConfigLabel } from '../../../shared/models/interview-preset.model';
import {
  filterAttempts,
  InterviewHistoryFilter,
  InterviewHistoryService
} from '../../../shared/services/features/interview/interview-history.service';
import { InterviewSessionReferenceStorage } from '../../../shared/services/interview/interview-session-reference.storage';
import { ThemeToggleComponent } from '../../../components/theme-toggle/theme-toggle.component';
import { InterviewReadinessComponent } from '../../../components/interview/interview-readiness/interview-readiness.component';
import { InterviewReadinessService } from '../../../shared/services/features/interview/interview-readiness.service';
import { InterviewTopicTrendsComponent } from '../../../components/interview/interview-topic-trends/interview-topic-trends.component';
import { InterviewTopicTrendsService } from '../../../shared/services/features/interview/interview-topic-trends.service';
import { ScrollDownIndicatorComponent } from '../../../components/scroll-down-indicator/scroll-down-indicator.component';

interface HistoryCard {
  entry: InterviewAttemptHistoryEntry;
  number: number;          // chronological attempt number (1 = oldest retained)
  topics: string[];
}

/**
 * Interview History — a read-only record of completed Interview Mode attempts.
 * It NEVER touches localStorage directly: all persistence/validation/retention
 * lives in InterviewHistoryService, and the summary metrics reuse that service's
 * `trends` (no independent recalculation). Filtering is client-side and pure.
 *
 * This is purely historical — it never restores or resumes a session.
 */
@Component({
  selector: 'codelab-interview-history',
  standalone: true,
  imports: [
    TitleCasePipe,
    RouterLink,
    ThemeToggleComponent,
    InterviewReadinessComponent,
    InterviewTopicTrendsComponent,
    ScrollDownIndicatorComponent,
    Toolbar,
    ToolbarWidget,
    ToolbarWidgetGroup
  ],
  templateUrl: './interview-history.component.html',
  styleUrls: ['./interview-history.component.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InterviewHistoryComponent implements OnInit {
  ngOnInit(): void {
    // Open at the TOP. Arriving from a long Interview Results page (or from a
    // history detail) otherwise inherits the previous scroll offset and lands
    // mid-list, hiding the heading and the summary counts.
    try {
      window.scrollTo({ top: 0, left: 0 });
    } catch (err: unknown) {
      // Non-fatal in non-browser test environments.
      swallow('interview-history#scrollTop', err);
    }
  }

  private readonly history = inject(InterviewHistoryService);
  private readonly sessionRef = inject(InterviewSessionReferenceStorage);
  private readonly readinessService = inject(InterviewReadinessService);
  private readonly destroyRef = inject(DestroyRef);

  // The interviews list section — the scroll target for the quick-jump link and
  // what the visibility observer watches.
  private readonly interviewsSection = viewChild<ElementRef<HTMLElement>>('interviewsSection');

  // Whether the interviews list is at least partly in the viewport. Starts true
  // so the jump link never flashes before the observer measures; the observer
  // flips it to false while the list is below the fold.
  private readonly interviewsVisible = signal(true);

  // The quick-jump link shows only when there IS history and the list isn't
  // currently visible (i.e. the user would otherwise have to scroll to reach it).
  readonly showJumpLink = computed(() => this.hasHistory() && !this.interviewsVisible());

  constructor() {
    afterNextRender(() => this.observeInterviews());
  }

  /** Smooth-scroll to the interviews list. */
  jumpToInterviews(): void {
    this.interviewsSection()?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Track whether the interviews list is on-screen so the jump link hides once
  // the user reaches it (and never shows when the list already fits above the
  // fold). No-op where IntersectionObserver is unavailable.
  private observeInterviews(): void {
    const el = this.interviewsSection()?.nativeElement;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => this.interviewsVisible.set(entries.some((e) => e.isIntersecting)),
      { threshold: 0 }
    );
    observer.observe(el);
    this.destroyRef.onDestroy(() => observer.disconnect());
  }

  // Summary metrics — reuse the shared trends (same source as Performance Trends).
  readonly trends = this.history.trends;

  // Compact readiness banner — the same shared readiness estimate, no factor
  // breakdown here (that lives on the Results page).
  readonly readiness = this.readinessService.readiness;

  // Topic Trends — per-topic direction/strength derived from the same history.
  private readonly topicTrendsService = inject(InterviewTopicTrendsService);
  readonly topicTrends = this.topicTrendsService.trends;
  readonly hasHistory = computed(() => this.history.history().length > 0);

  /**
   * Lifetime attempts vs. attempts still on file.
   *
   * History keeps only the newest INTERVIEW_HISTORY_MAX (20) attempts, but
   * `attemptNumber` is a LIFETIME counter that keeps climbing. Showing the
   * retained count under a "Completed Interviews" label therefore read as a
   * miscount once a user passed 20 (e.g. attempts 6–25 on file → "20" beside an
   * "Interview #25" card).
   *
   * The lifetime total is inferred from the highest retained attemptNumber
   * rather than persisted separately: retention always keeps the NEWEST
   * attempts, so the newest entry carries the highest number. Falls back to the
   * retained count for legacy entries that predate attemptNumber.
   */
  readonly lifetimeCount = computed(() => {
    const all = this.history.history();
    return all.reduce((max, e) => Math.max(max, e.attemptNumber ?? 0), 0) || all.length;
  });

  /** True once older attempts have aged out, i.e. the two numbers differ. */
  readonly hasAgedOut = computed(() => this.lifetimeCount() > this.history.history().length);

  readonly retainedCount = computed(() => this.history.history().length);

  readonly filter = signal<InterviewHistoryFilter>('all');

  readonly filters: { id: InterviewHistoryFilter; label: string }[] = [
    { id: 'all', label: $localize`All` },
    { id: 'submitted', label: $localize`Submitted` },
    { id: 'time-expired', label: $localize`Time Expired` }
  ];

  // Per-filter counts for the filter chips.
  readonly counts = computed<Record<InterviewHistoryFilter, number>>(() => {
    const all = this.history.history();
    return {
      all: all.length,
      submitted: all.filter((a) => a.completionReason === 'submitted').length,
      'time-expired': all.filter((a) => a.completionReason === 'time-expired').length
    };
  });

  // Cards, newest first. The number is the persisted lifetime attempt number
  // (stable as older attempts age out); falls back to chronological position for
  // any legacy record still missing one.
  readonly cards = computed<HistoryCard[]>(() => {
    const all = this.history.history();
    const positionById = new Map(all.map((e, i) => [e.id, i + 1]));
    return filterAttempts(all, this.filter())
      .slice()
      .reverse()
      .map((entry) => ({
        entry,
        number: entry.attemptNumber ?? positionById.get(entry.id) ?? 0,
        topics: this.topicsFor(entry)
      }));
  });

  setFilter(id: InterviewHistoryFilter): void {
    this.filter.set(id);
  }

  /**
   * Angular Aria's ngToolbar reports the user's selection here on click/
   * Enter/Space; `filter` (fed back in via `[value]="[filter()]"`) remains
   * the ONE authoritative signal — this only relays the toolbar's report
   * into the existing setter, exactly as a click handler always did.
   */
  onFilterToolbarChange(values: readonly InterviewHistoryFilter[]): void {
    const next = values[0];
    if (next !== undefined) this.setFilter(next);
  }

  /** Role preset name, or "Custom Interview" for custom and legacy entries. */
  interviewKindLabel(entry: InterviewAttemptHistoryEntry): string {
    return interviewConfigLabel(entry.configKind, entry.presetId, entry.presetName);
  }

  completionLabel(entry: InterviewAttemptHistoryEntry): string {
    return entry.completionReason === 'time-expired'
      ? $localize`Time expired`
      : $localize`Submitted`;
  }

  // An unretained duration reads as "Not recorded" — never a misleading "0s".
  duration(seconds: number | undefined): string {
    return seconds == null ? $localize`Not recorded` : formatDuration(seconds);
  }

  /** "July 23, 2026" — locale-formatted, safe fallback for odd input. */
  formatDate(iso: string): string {
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    } catch {
      return iso;
    }
  }

  private topicsFor(entry: InterviewAttemptHistoryEntry): string[] {
    const fromPerf = entry.topicPerformance.map((t) => t.topicName).filter(Boolean);
    if (fromPerf.length > 0) return fromPerf;
    return [...(entry.selectedTopicIds ?? [])];
  }

  /**
   * Whether this attempt can still be reviewed.
   *
   * Review lives on the server, and the ONLY credential for it is the active
   * session reference in sessionStorage — which dies with the tab. So this is
   * true just for the attempt taken in THIS browser session; every older entry
   * is summary-only. The button is hidden rather than shown-and-broken, so it
   * never promises data that cannot be fetched.
   */
  canReview(entry: InterviewAttemptHistoryEntry): boolean {
    return !!entry.sessionId && this.sessionRef.read()?.sessionId === entry.sessionId;
  }
}
