import {
  ChangeDetectionStrategy, ChangeDetectorRef, Component, computed, DestroyRef, effect,
  inject, input, OnInit, signal
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { MatTooltipModule } from '@angular/material/tooltip';

import { QuizMetadata } from '../../../shared/models/QuizMetadata.model';
import { QuizScore } from '../../../shared/models/QuizScore.model';

import { TopicQuizMetadataService } from '../../../shared/services/api/topic-quiz-metadata.service';
import { QuizService } from '../../../shared/services/data/quiz.service';
import { TimerService } from '../../../shared/services/features/timer/timer.service';

import { SummaryIconsComponent } from './summary-icons/summary-icons.component';
import { SummaryStatsComponent } from './summary-stats/summary-stats.component';

@Component({
  selector: 'codelab-results-summary',
  standalone: true,
  imports: [
    DatePipe,
    NgTemplateOutlet,
    SummaryIconsComponent,
    SummaryStatsComponent,
    MatTooltipModule
  ],
  templateUrl: './summary-report.component.html',
  styleUrls: ['./summary-report.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SummaryReportComponent implements OnInit {
  // ── injects ─────────────────────────────────────────────────────
  private readonly metadataApi = inject(TopicQuizMetadataService);
  private readonly quizService = inject(QuizService);
  private readonly timerService = inject(TimerService);
  private readonly cdRef = inject(ChangeDetectorRef);
  private readonly destroyRef = inject(DestroyRef);

  // ── inputs ──────────────────────────────────────────────────────
  // Signal input aliased to "quizId" so parent template binding stays the same.
  // Internal code may reassign the backing field, so we mirror via effect().
  readonly quizIdInput = input<string>('', { alias: 'quizId' });
  readonly viewMode = input<'summary' | 'highscores' | 'all'>('all');

  // ── remaining variables ─────────────────────────────────────────
  quizId = '';

  readonly quizMetadata = signal<Partial<QuizMetadata>>({});
  readonly quizPercentage = computed(() => this.quizMetadata().percentage ?? 0);
  readonly completionTimeSig = signal(0);
  readonly elapsedMinutes = computed(() => Math.floor(this.completionTimeSig() / 60));
  readonly elapsedSeconds = computed(() => this.completionTimeSig() % 60);
  readonly checkedShuffle = signal(false);
  readonly highScores = signal<QuizScore[]>([]);
  readonly currentScore = signal<QuizScore | null>(null);  // current quiz attempt score
  readonly codelabUrl = 'https://www.codelab.fun';

  constructor() {
    let firstRun = true;
    effect(() => {
      const incoming = this.quizIdInput();
      if (incoming) this.quizId = incoming;
      if (firstRun) {
        firstRun = false;
        return;
      }
      this.initComponent();
    });
  }

  ngOnInit(): void {
    this.initComponent();
  }

  calculateElapsedTime(): void {
    const completionTime = this.quizMetadata().completionTime ?? 0;
    this.completionTimeSig.set(completionTime);
  }

  getMilestoneLabel(quizId: string): string {
    return this.metadataApi.milestoneFor(quizId);
  }

  private initComponent(): void {
    if (!this.quizId) {
      this.quizId = this.quizService.quizId || localStorage.getItem('quizId') || '';
    }

    try {
      // Elapsed time from the LIVE timer (valid on fresh completion).
      const qid = this.quizId || this.quizService.quizId;
      let completionTime = this.timerService.calculateTotalElapsedTime(
        this.timerService.elapsedTimes
      );
      if (completionTime === 0 && this.timerService.completionTime > 0) {
        completionTime = this.timerService.completionTime;
      }

      if (completionTime > 0) {
        // Fresh path: persist the displayed value durably (per-quiz) and into
        // the snapshot, so a later revisit can read it back with the same qid.
        this.timerService.setDurableCompletionTime(qid, completionTime);
        this.quizService.patchFinalResultCompletionTime(completionTime);
      } else {
        // Revisit path: the live timer was cleared on leaving Results — read the
        // durable per-quiz value, falling back to the persisted snapshot.
        completionTime =
          this.timerService.getDurableCompletionTime(qid) ||
          this.quizService.getFinalResultSnapshot()?.completionTime ||
          0;
      }

      // Initialize quizMetadata in initComponent when service data is available
      this.quizMetadata.set({
        totalQuestions: this.quizService.totalQuestions(),
        totalQuestionsAttempted: this.quizService.totalQuestions(),
        correctAnswersCount: this.quizService.correctAnswersCountSig,
        percentage:
          this.quizService.calculatePercentageOfCorrectlyAnsweredQuestions(),
        completionTime
      });

      // Populates milestoneFor()'s backing signal — shared, at-most-once-per-
      // page request. getMilestoneLabel() reads it directly per High-Scores row.
      this.metadataApi.load().pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
        this.cdRef.markForCheck();
      });

      this.checkedShuffle.set(this.quizService.isShuffleEnabled());
      this.calculateElapsedTime();
      // READ-ONLY: this view only displays the High Scores. The record itself is
      // written once at completion in ResultsComponent.ngOnInit
      // (quizService.recordCompletedQuizScore). Writing here re-fired on every
      // section switch and produced duplicate rows.
      this.highScores.set(this.quizService.highScores);

      // "Date/Time Completed" must reflect the ORIGINAL completion, not this
      // render. The snapshot's completedAt is stamped when the results are first
      // built (fresh completion) and preserved across revisits, so prefer it and
      // only fall back to now when there is no snapshot.
      const completedAt = this.quizService.getFinalResultSnapshot()?.completedAt;
      const attemptDateTime = completedAt ? new Date(completedAt) : new Date();

      // Create current score object for display
      this.currentScore.set({
        quizId: this.quizId,
        attemptDateTime,
        score: this.quizMetadata().percentage ?? 0,
        totalQuestions: this.quizService.totalQuestions()
      });
    } catch {
      // Fallback to ensure UI doesn't look broken
      this.currentScore.set({
        quizId: this.quizId || 'Unknown',
        attemptDateTime: new Date(),
        score: 0,
        totalQuestions: 0
      });
    }

    this.cdRef.markForCheck();
  }
}
