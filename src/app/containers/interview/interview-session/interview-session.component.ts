import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  HostListener,
  inject,
  OnDestroy,
  OnInit,
  signal,
  viewChild,
  ViewEncapsulation
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router } from '@angular/router';

import { swallow } from '../../../shared/utils/error-logging';

import { AssessmentIntegrityService } from '../../../shared/services/features/interview/assessment-integrity.service';
import { BackendInterviewSessionService } from '../../../shared/services/interview/backend-interview-session.service';
import { BackendInterviewTimerService } from '../../../shared/services/interview/backend-interview-timer.service';
import { toggleOption } from '../../../shared/services/interview/interview-answer-transitions';
import { AssessmentIntegrityWarningDialogComponent } from '../../../components/dialogs/assessment-integrity-warning-dialog/assessment-integrity-warning-dialog.component';
import {
  KeyboardShortcutsDialogComponent,
  KeyboardShortcutsDialogData
} from '../../../components/dialogs/keyboard-shortcuts-dialog/keyboard-shortcuts-dialog.component';

import { InterviewPaginatorComponent } from '../../../components/interview/interview-paginator/interview-paginator.component';
import { InterviewOptionsComponent } from '../../../components/interview/interview-options/interview-options.component';
import { ThemeToggleComponent } from '../../../components/theme-toggle/theme-toggle.component';
import { CodeSnippetComponent } from '../../../components/code-snippet/code-snippet.component';
import {
  InterviewSubmitDialogComponent,
  InterviewSubmitDialogData
} from '../../../components/dialogs/interview-submit-dialog/interview-submit-dialog.component';
import type { InterviewOptionViewModel } from '../../../shared/models/interview/interview-view-models';

/**
 * Interview session shell — BACKEND-BACKED.
 *
 * The assessment lives on the server. This component renders the hydrated
 * safe view models and owns no generation, no scoring and no answer key: the
 * active question model has `optionId` + `text` only, so correctness cannot
 * leak through the UI even by accident.
 *
 * Hydration happens ONCE, in BackendInterviewSessionGuard, so there is exactly
 * one resume request per navigation. This component never resumes on init —
 * only when the user explicitly retries a backend outage.
 *
 * The countdown is DISPLAY ONLY. The server deadline is authoritative and keeps
 * running while the submit-confirmation dialog is open; pausing the display
 * would let the UI show more time than actually remains.
 */
@Component({
  selector: 'codelab-interview-session',
  standalone: true,
  imports: [
    MatIconModule,
    MatTooltipModule,
    InterviewPaginatorComponent,
    InterviewOptionsComponent,
    ThemeToggleComponent,
    CodeSnippetComponent
  ],
  templateUrl: './interview-session.component.html',
  styleUrls: ['./interview-session.component.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InterviewSessionComponent implements OnInit, OnDestroy {
  private readonly session = inject(BackendInterviewSessionService);
  private readonly timer = inject(BackendInterviewTimerService);
  private readonly integrity = inject(AssessmentIntegrityService);
  private readonly dialog = inject(MatDialog);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject(ElementRef<HTMLElement>);

  private readonly shortcutsBtn = viewChild<ElementRef<HTMLButtonElement>>('shortcutsBtn');

  // ── session state ─────────────────────────────────────────────────
  readonly questions = this.session.questions;
  readonly currentIndex = this.session.currentIndex;
  readonly total = this.session.questionCount;
  readonly currentQuestion = this.session.currentQuestion;
  readonly status = this.session.status;
  readonly retrying = signal(false);

  readonly questionText = computed(() => this.currentQuestion()?.questionText ?? '');
  readonly currentOptions = computed<readonly InterviewOptionViewModel[]>(
    () => this.currentQuestion()?.options ?? []
  );
  /** Explicit server type — the ONLY multi-select signal. */
  readonly questionType = computed(() => this.currentQuestion()?.type ?? 'single');

  /** Option highlighting follows the OPTIMISTIC selection so clicks feel instant. */
  readonly selectedIds = computed<readonly number[]>(() => {
    const questionId = this.currentQuestion()?.questionId;
    return questionId ? this.session.selectionFor(questionId) : [];
  });

  /**
   * Paginator markers follow CONFIRMED server answers, so a failed save never
   * leaves a question looking answered.
   */
  readonly answeredIndices = computed<ReadonlySet<number>>(() => {
    const confirmed = this.session.confirmedAnswers();
    const marked = new Set<number>();
    this.questions().forEach((question, index) => {
      if ((confirmed.get(question.questionId)?.length ?? 0) > 0) marked.add(index);
    });
    return marked;
  });

  readonly answeredCount = computed(() => this.answeredIndices().size);

  /**
   * Paginator markers follow CONFIRMED server marks — same durability contract
   * as `answeredIndices` — DISTINCT from it: a question can be marked,
   * answered, both, or neither, and marking never touches the answer map.
   */
  readonly markedIndices = computed<ReadonlySet<number>>(() => {
    const confirmed = this.session.confirmedFlagged();
    const marked = new Set<number>();
    this.questions().forEach((question, index) => {
      if (confirmed.has(question.questionId)) marked.add(index);
    });
    return marked;
  });

  readonly markedCount = computed(() => this.markedIndices().size);

  /** Displayed (optimistic-aware) state for the current question's toggle. */
  readonly isCurrentMarked = computed(() => {
    const questionId = this.currentQuestion()?.questionId;
    return !!questionId && this.session.isFlagged(questionId);
  });

  // ── save / navigation gating ──────────────────────────────────────
  readonly isSavingCurrent = computed(() => {
    const questionId = this.currentQuestion()?.questionId;
    return !!questionId && this.session.isQuestionSaving(questionId);
  });

  readonly hasFailedCurrent = computed(() => {
    const questionId = this.currentQuestion()?.questionId;
    return !!questionId && this.session.hasFailedSave(questionId);
  });

  /**
   * ONE gate for every navigation path — Prev, Next, paginator pages, keyboard
   * and submit. Leaving a question with an unaccepted answer would strand it.
   */
  readonly navigationBlocked = computed(
    () => this.isSavingCurrent() || this.hasFailedCurrent() || this.isFinalizing()
  );

  /** Forward gate: at least one selection. Never a correctness or completeness test. */
  readonly canNavigateNext = computed(() => this.selectedIds().length > 0);

  readonly inputsLocked = computed(
    () => this.isFinalizing() || this.status() === 'submitted' || this.status() === 'expired'
  );

  // ── integrity + timer ─────────────────────────────────────────────
  readonly focusChanges = this.integrity.focusLossCount;
  readonly fullscreenSupported = this.integrity.fullscreenSupported();
  readonly isFullscreen = this.integrity.isFullscreen;
  private warningOpen = false;

  readonly timeRemaining = this.timer.formatted;
  readonly isLowTime = this.timer.isLowTime;

  readonly isLastQuestion = computed(
    () => this.total() > 0 && this.currentIndex() === this.total() - 1
  );

  // ── submission ────────────────────────────────────────────────────
  private readonly _finalizing = signal(false);
  readonly isFinalizing = this._finalizing.asReadonly();
  private submitDialogRef: MatDialogRef<InterviewSubmitDialogComponent, boolean> | null = null;
  private submitStarted = false;
  readonly submitError = signal<string | null>(null);

  constructor() {
    // Expiry → submit ONCE. Wired before the timer starts so it can never be missed.
    this.timer.expired$
      .pipe(takeUntilDestroyed())
      .subscribe(() => void this.handleExpiry());

    this.integrity.warningOnReturn$
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.openIntegrityWarning());
  }

  ngOnInit(): void {
    // The guard already hydrated (or failed). Never resume again here.
    if (this.status() === 'submitted') {
      void this.router.navigate(['/interview/results', this.session.sessionId()]);
      return;
    }

    this.startDisplayTimer();

    // Integrity was reset once at session creation; a refresh restores the
    // count from its own key, so it is deliberately NOT reset here.
    this.integrity.activate(this.destroyRef);
    if (this.integrity.warningPending()) this.openIntegrityWarning();
  }

  ngOnDestroy(): void {
    this.timer.stop();
    // The session is NOT cleared on leave: the backend owns it and the minimal
    // reference must survive so the user can resume or load their result.
    this.integrity.reset();
  }

  private startDisplayTimer(): void {
    if (this.status() !== 'active') return;
    // Anchored to the server's own remaining time — never a full restart.
    this.timer.syncFromServer(this.session.serverRemainingSeconds(), this.session.durationSeconds());
  }

  /** Retry after a backend outage. The reference was deliberately preserved. */
  async retryResume(): Promise<void> {
    if (this.retrying()) return;
    this.retrying.set(true);
    try {
      const outcome = await this.session.resumeFromStoredReference();
      if (outcome.kind === 'active') {
        this.startDisplayTimer();
      } else if (outcome.kind === 'submitted') {
        await this.router.navigate(['/interview/results', this.session.sessionId()]);
      } else if (outcome.kind === 'unauthorized' || outcome.kind === 'none') {
        await this.router.navigate(['/interview']);
      }
    } finally {
      this.retrying.set(false);
    }
  }

  // ── answers ───────────────────────────────────────────────────────

  /** Receives the COMPLETE next selection from the options component. */
  async onSelectionChange(optionIds: number[]): Promise<void> {
    const question = this.currentQuestion();
    if (!question || this.inputsLocked()) return;
    await this.session.updateAnswer(question.questionId, optionIds);
  }

  /**
   * Resend the selection whose save failed.
   *
   * The intent comes from the service, NOT from `selectedIds()` — after a
   * failure the display shows the confirmed server answer again, so reading the
   * screen would resend the wrong value.
   */
  async retrySave(): Promise<void> {
    const question = this.currentQuestion();
    if (!question) return;
    await this.session.retryFailedSave(question.questionId);
  }

  // ── Mark for Review ───────────────────────────────────────────────

  /**
   * Toggle the current question's Mark-for-Review flag. Gated ONLY on
   * `inputsLocked()` — deliberately NOT on `navigationBlocked()`, since a
   * pending or failed ANSWER save must never block marking: the two are
   * independent state machines, and marking never touches the answer.
   */
  async toggleMarkForReview(): Promise<void> {
    const question = this.currentQuestion();
    if (!question || this.inputsLocked()) return;
    await this.session.setFlagged(question.questionId, !this.isCurrentMarked());
  }

  // ── navigation ────────────────────────────────────────────────────

  onNavigate(index: number): void {
    if (this.navigationBlocked()) return;
    this.session.setCurrentIndex(index);   // also persists v2 currentIndex
    try {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      swallow('interview-session#onNavigate', err);
    }
  }

  /**
   * ← / → mirror the paginator, routed through onNavigate() so there is one
   * navigation path. Guards, in order: an open dialog owns the keyboard; form
   * controls keep native arrow behaviour (that is how a keyboard user picks a
   * radio); modifier combos belong to the browser.
   */
  @HostListener('window:keydown', ['$event'])
  onGlobalKey(event: KeyboardEvent): void {
    if (event.defaultPrevented) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (this.dialog.openDialogs.length > 0) return;

    const target = event.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;

    // Same gate as every other navigation path.
    if (this.navigationBlocked()) return;

    const index = this.currentIndex();

    if (event.key === 'ArrowLeft') {
      if (index <= 0) return;
      event.preventDefault();
      this.onNavigate(index - 1);
      return;
    }

    if (index >= this.total() - 1) return;
    if (!this.canNavigateNext()) return;   // left alone rather than swallowed
    event.preventDefault();
    this.onNavigate(index + 1);
  }

  // ── submission ────────────────────────────────────────────────────

  /**
   * Manual submit. The countdown deliberately CONTINUES while the dialog is
   * open — the server deadline does not pause, so neither may the display.
   */
  onShowResults(): void {
    if (this.status() !== 'active' || this.navigationBlocked()) return;

    const answered = this.answeredCount();
    this.submitDialogRef = this.dialog.open<
      InterviewSubmitDialogComponent, InterviewSubmitDialogData, boolean
    >(InterviewSubmitDialogComponent, {
      width: '360px',
      panelClass: 'themed-confirm-dialog',
      autoFocus: 'dialog',
      data: {
        answered,
        unanswered: Math.max(0, this.total() - answered),
        timeRemaining: this.timeRemaining(),
        markedCount: this.markedCount()
      }
    });

    this.submitDialogRef.afterClosed().subscribe((confirmed) => {
      this.submitDialogRef = null;
      // An expiry that closed the dialog has already started its own submit.
      if (confirmed && !this.submitStarted) void this.submit();
    });
  }

  /** Timer hit zero: close any dialog, lock, and submit exactly once. */
  private async handleExpiry(): Promise<void> {
    this.submitDialogRef?.close(false);
    this.submitDialogRef = null;
    await this.submit();
  }

  /**
   * Finalize on the backend. Pending saves settle first so the server scores
   * what the user actually chose; `submittedByExpiry` is never sent — the
   * backend decides that from its own clock.
   */
  private async submit(): Promise<void> {
    if (this.submitStarted) return;   // suppress duplicates in the UI
    this.submitStarted = true;
    this._finalizing.set(true);
    this.submitError.set(null);
    this.timer.stop();

    try {
      await this.session.submit();
      await this.router.navigate(['/interview/results', this.session.sessionId()]);
    } catch {
      // Backend unavailable → stay locked, keep the reference, offer a retry.
      this.submitStarted = false;
      this._finalizing.set(false);
      this.submitError.set($localize`Could not submit your assessment. Please try again.`);
    }
  }

  async retrySubmit(): Promise<void> {
    await this.submit();
  }

  // ── integrity / dialogs ───────────────────────────────────────────

  private openIntegrityWarning(): void {
    if (this.warningOpen) return;
    this.warningOpen = true;
    const ref = this.dialog.open(AssessmentIntegrityWarningDialogComponent, {
      width: '360px',
      panelClass: 'themed-confirm-dialog',
      autoFocus: 'dialog',
      restoreFocus: true
    });
    ref.afterClosed().subscribe(() => {
      this.warningOpen = false;
      this.integrity.acknowledgeWarning();
    });
  }

  openKeyboardShortcuts(): void {
    const ref = this.dialog.open(KeyboardShortcutsDialogComponent, {
      panelClass: 'keyboard-shortcuts-dialog',
      width: '90vw',
      maxWidth: '460px',
      autoFocus: 'dialog',
      restoreFocus: true,
      ariaLabelledBy: 'ksd-title',
      ariaDescribedBy: 'ksd-desc',
      ariaModal: true,
      data: { mode: 'interview' } as KeyboardShortcutsDialogData
    });

    ref
      .afterClosed()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.shortcutsBtn()?.nativeElement?.focus());
  }

  enterFullscreen(): void {
    const el = document.documentElement ?? this.host.nativeElement;
    this.integrity.enterFullscreen(el).catch((err) =>
      swallow('interview-session#enterFullscreen', err)
    );
  }

  /** Scoped copy deterrents — bound only to the assessment content box. */
  blockCopy(event: Event): void {
    event.preventDefault();
  }

  async backToBuilder(): Promise<void> {
    await this.router.navigate(['/interview']);
  }
}
