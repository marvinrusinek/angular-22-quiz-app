import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  OnInit,
  Signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { ActivatedRoute } from '@angular/router';

import { QuizMetadata } from '../../../shared/models/QuizMetadata.model';

import { TopicQuizMetadataService } from '../../../shared/services/api/topic-quiz-metadata.service';
import { QuizService } from '../../../shared/services/data/quiz.service';
import { TimerService } from '../../../shared/services/features/timer/timer.service';

@Component({
  selector: 'codelab-results-challenge',
  standalone: true,
  imports: [],
  templateUrl: './challenge.component.html',
  styleUrls: ['./challenge.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChallengeComponent implements OnInit {
  // ── injects ─────────────────────────────────────────────────────
  private readonly metadataApi = inject(TopicQuizMetadataService);
  private readonly quizService = inject(QuizService);
  private readonly timerService = inject(TimerService);
  private readonly activatedRoute = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  // ── remaining variables ─────────────────────────────────────────
  quizName = '';
  currentQuizId = '';

  // S6a: metadata comes from TopicQuizMetadataService (API-backed), not
  // QuizDataService's bundled bank; milestoneFor() degrades to the id
  // itself if the metadata call is still in flight or fails.
  readonly milestoneName = computed(() => this.metadataApi.milestoneFor(this.currentQuizId));

  private readonly correctAnswersCount: Signal<number> = this.quizService.correctAnswersCountSig;
  readonly percentageCorrect = computed(() => {
    const total = this.quizService.totalQuestions();
    if (!total) return 0;
    return Math.round((100 * this.correctAnswersCount()) / total);
  });

  quizMetadata: Partial<QuizMetadata> = {
    totalQuestions: this.quizService.totalQuestions(),
    totalQuestionsAttempted: this.quizService.totalQuestions(),
    correctAnswersCount: this.quizService.correctAnswersCountSig,
    percentage: this.percentageCorrect(),
    completionTime: this.timerService.calculateTotalElapsedTime(this.timerService.elapsedTimes),
  };
  codelabUrl = 'https://www.codelab.fun';

  ngOnInit(): void {
    // Get quizId from service (most reliable) or from route params
    this.currentQuizId =
      this.quizService.quizId ||
      this.activatedRoute.snapshot.paramMap.get('quizId') ||
      this.activatedRoute.parent?.snapshot.paramMap.get('quizId') ||
      '';
    this.quizName = this.currentQuizId;

    // Populates milestoneFor()'s backing signal. Shared, at-most-once-per-
    // page request — safe to call from every consumer.
    this.metadataApi.load().pipe(takeUntilDestroyed(this.destroyRef)).subscribe();
  }
}
