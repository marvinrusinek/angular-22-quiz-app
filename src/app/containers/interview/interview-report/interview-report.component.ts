import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  viewChild
} from '@angular/core';
import { Title } from '@angular/platform-browser';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { BackendInterviewResultService } from '@shared/services/interview/backend-interview-result.service';
import { formatDuration } from '@shared/utils/format-time';
import { swallow } from '@shared/utils/error-logging';
import { InterviewReviewComponent } from '../../../components/interview/interview-review/interview-review.component';
import {
  formatReportDate,
  interviewReportTitle,
  reportAssessmentLabel,
  reportDifficulty
} from './interview-report.helpers';

/**
 * Interview Report — a print-friendly record of THIS finalized attempt.
 *
 * It renders only what the existing finalized Results/Review flow already holds
 * (`BackendInterviewResultService.result()`); it adds no endpoint, persists nothing
 * and never sees an unfinished session (the route is behind
 * BackendInterviewResultGuard, which redirects an unfinished or unauthorized
 * session before this component exists).
 *
 * Nothing internal is rendered: no session id, token, question id, source-quiz
 * id or integrity counters. The question review REUSES `app-interview-review`
 * (its sanitized HTML / code-snippet path); the report only hides that
 * component's interactive filter toolbar and its duplicate summary (see SCSS).
 *
 * "Print / Save as PDF" is the browser's native print flow. While printing, the
 * document title is swapped for a privacy-safe file-name suggestion and always
 * restored (afterprint, print-media exit, or leaving the page).
 */
@Component({
  selector: 'codelab-interview-report',
  standalone: true,
  imports: [RouterLink, InterviewReviewComponent],
  templateUrl: './interview-report.component.html',
  styleUrls: ['./interview-report.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InterviewReportComponent {
  private readonly results = inject(BackendInterviewResultService);
  private readonly route = inject(ActivatedRoute);
  private readonly documentTitle = inject(Title);
  private readonly destroyRef = inject(DestroyRef);

  private readonly heading = viewChild<ElementRef<HTMLElement>>('reportHeading');

  private readonly routeSessionId = this.route.snapshot.paramMap.get('sessionId') ?? '';

  /**
   * The finalized result for THIS route only. The guard has already loaded it; matching
   * the id here means a stale result for a different session can never render under
   * this URL (the guard lets an 'unavailable'/'malformed' load through to the page).
   */
  readonly result = computed(() => {
    const r = this.results.result();
    return r && r.sessionId === this.routeSessionId ? r : null;
  });

  readonly assessmentLabel = computed(() => {
    const r = this.result();
    return r ? reportAssessmentLabel(r.config) : '';
  });
  readonly difficulty = computed(() => {
    const r = this.result();
    return r ? reportDifficulty(r.config) : '';
  });
  readonly completedOn = computed(() => {
    const r = this.result();
    return r ? formatReportDate(r.submittedAtMs) : '';
  });
  readonly completedIso = computed(() => {
    const r = this.result();
    return r ? new Date(r.submittedAtMs).toISOString().slice(0, 10) : '';
  });
  readonly totalDuration = computed(() => formatDuration(this.result()?.durationSeconds ?? 0));
  readonly timeUsed = computed(() => formatDuration(this.result()?.timeUsedSeconds ?? 0));

  /** Title in effect before printing; null when no print title is applied. */
  private originalTitle: string | null = null;

  private readonly onBeforePrint = (): void => this.applyPrintTitle();
  private readonly onAfterPrint = (): void => this.restoreTitle();

  constructor() {
    // Ctrl/Cmd+P and the browser menu print too, not just our button.
    window.addEventListener('beforeprint', this.onBeforePrint);
    window.addEventListener('afterprint', this.onAfterPrint);

    // Fallback for browsers that lack afterprint: leaving print media restores it.
    let mql: MediaQueryList | undefined;
    const onMediaChange = (e: MediaQueryListEvent): void => {
      if (!e.matches) this.restoreTitle();
    };
    try {
      mql = typeof window.matchMedia === 'function' ? window.matchMedia('print') : undefined;
      mql?.addEventListener('change', onMediaChange);
    } catch (err: unknown) {
      swallow('interview-report#matchMedia', err);
    }

    this.destroyRef.onDestroy(() => {
      window.removeEventListener('beforeprint', this.onBeforePrint);
      window.removeEventListener('afterprint', this.onAfterPrint);
      mql?.removeEventListener('change', onMediaChange);
      this.restoreTitle();                       // never leave the app titled as the report
    });

    // Route entry: start at the top and put focus on the page heading.
    try {
      window.scrollTo({ top: 0, left: 0 });
    } catch (err: unknown) {
      swallow('interview-report#scrollTop', err);
    }
    afterNextRender(() => this.heading()?.nativeElement.focus({ preventScroll: true }));
  }

  /** Opens the browser's native print dialog (Save as PDF is chosen there). */
  print(): void {
    this.applyPrintTitle();
    window.print();
  }

  private applyPrintTitle(): void {
    const r = this.result();
    if (!r || this.originalTitle !== null) return;   // nothing to print, or already applied
    this.originalTitle = this.documentTitle.getTitle();
    this.documentTitle.setTitle(interviewReportTitle(r.config, r.submittedAtMs));
  }

  private restoreTitle(): void {
    if (this.originalTitle === null) return;
    this.documentTitle.setTitle(this.originalTitle);
    this.originalTitle = null;
  }
}
