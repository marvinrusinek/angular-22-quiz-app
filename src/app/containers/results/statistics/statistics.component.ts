import {
  ChangeDetectionStrategy, ChangeDetectorRef, Component, computed, DestroyRef,
  effect, inject, input, OnInit, signal
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { QuizStatus } from '../../../shared/models/quiz-status.enum'
import { QuizMetadata } from '../../../shared/models/QuizMetadata.model';
import { Resource } from '../../../shared/models/Resource.model';

import { TopicQuizResourcesService } from '../../../shared/services/api/topic-quiz-resources.service';
import { QuizDataService } from '../../../shared/services/data/quizdata.service';
import { QuizService } from '../../../shared/services/data/quiz.service';
import { TimerService } from '../../../shared/services/features/timer/timer.service';

import { ScoreVisualComponent } from './score-visual/score-visual.component';
import { QuizResourcesComponent } from './quiz-resources/quiz-resources.component';

@Component({
  selector: 'codelab-results-statistics',
  standalone: true,
  imports: [ScoreVisualComponent, QuizResourcesComponent],
  templateUrl: './statistics.component.html',
  styleUrls: ['./statistics.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class StatisticsComponent implements OnInit {
  // ── injects ─────────────────────────────────────────────────────
  private readonly quizDataService = inject(QuizDataService);
  private readonly quizService = inject(QuizService);
  private readonly timerService = inject(TimerService);
  private readonly resourcesApi = inject(TopicQuizResourcesService);
  private readonly cdRef = inject(ChangeDetectorRef);
  private readonly destroyRef = inject(DestroyRef);

  // ── inputs ──────────────────────────────────────────────────────
  // Signal input aliased to "quizId" so parent template binding stays the same.
  // Internal code may reassign the backing field, so we mirror via effect().
  readonly quizIdInput = input<string>('', { alias: 'quizId' });
  readonly viewMode =
    input<'score' | 'resources' | 'all'>('all');

  // ── remaining variables ─────────────────────────────────────────
  readonly quizzes = this.quizDataService.quizzesSig;
  readonly quizId = signal('');

  // The single quiz this results view is for. Replaces the template's
  // @for(quizzes)+@if(quizId match) guard with a direct lookup.
  readonly selectedQuiz = computed(() =>
    this.quizzes().find(q => q.quizId === this.quizId())
  );

  readonly milestoneName = computed(() => {
    const qId = this.quizId();
    if (!qId) return '';
    const cached = this.quizDataService.getCachedQuizById(qId);
    if (cached?.milestone) return cached.milestone;
    const found = this.quizzes().find(q => q.quizId === qId);
    return found?.milestone ?? qId;
  });

  readonly quizMetadata = signal<Partial<QuizMetadata>>({});
  readonly resources = signal<Resource[]>([]);

  readonly completionTimeSig = signal(0);
  readonly elapsedMinutes = computed(() => Math.floor(this.completionTimeSig() / 60));
  readonly elapsedSeconds = computed(() => this.completionTimeSig() % 60);
  readonly percentage = computed(() => this.quizMetadata().percentage ?? 0);

  // ── score breakdown (Correct / Incorrect / Timed Out) ───────────
  readonly totalCount = computed(() => this.quizMetadata().totalQuestions ?? 0);
  readonly correctCount = computed(() => this.quizMetadata().correctAnswersCount?.() ?? 0);
  readonly incorrectCount = computed(() =>
    Math.max(0, this.totalCount() - this.correctCount())
  );
  readonly timedOutCount = computed(() => this.countTimedOutQuestions());

  readonly feedbackLevel = computed<'excellent' | 'good' | 'poor'>(() => {
    const pct = this.percentage();
    if (pct >= 80) return 'excellent';
    if (pct >= 60) return 'good';
    return 'poor';
  });

  readonly starCount = computed(() => {
    const pct = this.percentage();
    if (pct >= 90) return 5;
    if (pct >= 75) return 4;
    if (pct >= 60) return 3;
    if (pct >= 40) return 2;
    return 1;
  });

  readonly questionLabel = computed(() =>
    this.quizMetadata().totalQuestions === 1 ? 'question' : 'questions'
  );

  readonly minuteLabel = computed(() =>
    this.elapsedMinutes() === 1 ? 'minute' : 'minutes'
  );

  CONGRATULATIONS =
    'https://raw.githubusercontent.com/marvinrusinek/angular-9-quiz-app/master/src/assets/images/congratulations.jpg';
  NOT_BAD =
    'https://raw.githubusercontent.com/marvinrusinek/angular-9-quiz-app/master/src/assets/images/not-bad.jpg';
  TRY_AGAIN =
    'https://raw.githubusercontent.com/marvinrusinek/angular-9-quiz-app/master/src/assets/images/try-again.jpeg';

  constructor() {
    let firstRun = true;
    effect(() => {
      const incoming = this.quizIdInput();
      if (incoming) this.quizId.set(incoming);
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

  calculatePercentageOfCorrectlyAnsweredQuestions(): number {
    const total = this.quizService.totalQuestions();
    if (total === 0) return 0; // Prevent NaN

    return Math.round(
      (100 * this.quizService.correctAnswersCountSig()) / total
    );
  }

  private initComponent(): void {
    // Priority: Input quizId > Service quizId > Stored quizId
    if (!this.quizId()) {
      this.quizId.set(this.quizService.quizId || localStorage.getItem('quizId') || '');
    }

    // Elapsed time from the LIVE timer (valid on fresh completion).
    let totalElapsedTime = this.timerService.calculateTotalElapsedTime(
      this.timerService.elapsedTimes
    );

    // Fallback: if elapsedTimes is empty, use the direct completionTime property
    if (totalElapsedTime === 0 && this.timerService.completionTime > 0) {
      totalElapsedTime = this.timerService.completionTime;
    }

    const qid = this.quizId() || this.quizService.quizId;
    if (totalElapsedTime > 0) {
      // Fresh path: persist the EXACT value we display, durably (localStorage,
      // keyed by qid) and into the snapshot, so a later revisit can read it back
      // with the same qid.
      this.timerService.setDurableCompletionTime(qid, totalElapsedTime);
      this.quizService.patchFinalResultCompletionTime(totalElapsedTime);
    } else {
      // Revisit path: the live timer was cleared on leaving Results. Read the
      // elapsed time from the durable per-quiz store (survives leaving Results),
      // falling back to the snapshot.
      totalElapsedTime =
        this.timerService.getDurableCompletionTime(qid) ||
        this.quizService.getFinalResultSnapshot()?.completionTime ||
        0;
    }

    // Initialize quizMetadata in initComponent when service data is available
    this.quizMetadata.set({
      totalQuestions: this.quizService.totalQuestions(),
      totalQuestionsAttempted: this.quizService.totalQuestions(),
      correctAnswersCount: this.quizService.correctAnswersCountSig,
      percentage: this.calculatePercentageOfCorrectlyAnsweredQuestions(),
      completionTime: totalElapsedTime
    });

    // RESOURCES COME FROM THE API, NOT THE LOCAL BANK.
    //
    // This used to be `quizService.loadResourcesForQuiz()` reading the
    // `resources` block of `assets/data/quiz.json` — the last consumer of that
    // block, and therefore one of the things keeping the public asset alive.
    //
    // Deliberately NOT awaited or gated on: the rest of the statistics panel
    // renders from data it already has, and a slow or failed resources call
    // must not delay or break it. The service resolves to an empty list on any
    // failure, so the panel behaves exactly as it does for the twelve quizzes
    // that have no links.
    if (this.quizId()) {
      this.resourcesApi.loadResources(this.quizId())
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe((resources) => {
          this.resources.set(resources);
          this.cdRef.markForCheck();
        });
    }
    this.calculateElapsedTime();
    this.sendQuizStatusToQuizService();

    this.cdRef.markForCheck();
  }

  private countTimedOutQuestions(): number {
    if (!this.timerService.isCountdown()) return 0;
    const duration = this.timerService.timePerQuestion;
    if (duration <= 0) return 0;
    const elapsed = this.timerService.elapsedTimes ?? [];
    let count = 0;
    for (let i = 0; i < this.totalCount(); i++) {
      if ((elapsed[i] ?? 0) >= duration) count++;
    }
    return count;
  }

  private sendQuizStatusToQuizService(): void {
    this.quizService.setQuizStatus(QuizStatus.COMPLETED);
  }
}
