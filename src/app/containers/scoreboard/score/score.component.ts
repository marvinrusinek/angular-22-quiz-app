import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnInit,
  signal
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';

import { MatMenuModule } from '@angular/material/menu';

import { QuizQuestion } from '@shared/models';

import { QuizService } from '@shared/services/data/quiz.service';
import { swallow } from '@shared/utils/error-logging';

@Component({
  selector: 'codelab-scoreboard-score',
  standalone: true,
  imports: [MatMenuModule],
  templateUrl: './score.component.html',
  styleUrls: ['./score.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ScoreComponent implements OnInit {
  // ── injects ─────────────────────────────────────────────────────
  private readonly quizService = inject(QuizService);

  // ── remaining variables ─────────────────────────────────────────
  private readonly scoreDisplayStorageKey = 'scoreDisplayType';

  // Source signals derived directly from QuizService streams.
  private readonly correctAnswersCountSig = this.quizService.correctAnswersCountSig;
  private readonly questionsSig = toSignal(this.quizService.questions$, {
    initialValue: [] as QuizQuestion[]
  });
  private readonly totalQuestionsSig = computed<number>(() => {
    const fromStream = this.questionsSig()?.length ?? 0;
    if (fromStream === 0 && this.quizService.totalQuestions() > 0) {
      return this.quizService.totalQuestions();
    }
    return fromStream;
  });

  // User preference: numerical vs percentage display.
  readonly isPercentage = signal<boolean>(false);

  private readonly scoreCounts = computed(() => {
    const total = this.totalQuestionsSig();
    const safeTotal = Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0;
    const rawCorrect = this.correctAnswersCountSig();
    const safeCorrect =
      safeTotal > 0
        ? Math.min(Math.max(0, Math.trunc(rawCorrect)), safeTotal)
        : Math.max(0, Math.trunc(rawCorrect));

    return { correct: safeCorrect, total: safeTotal };
  });

  private readonly percentageScore = computed(() => {
    const { correct, total } = this.scoreCounts();
    return total > 0 ? ((correct / total) * 100).toFixed(0) : '0';
  });

  readonly displayedScore = computed(() => {
    const { correct, total } = this.scoreCounts();
    return this.isPercentage()
      ? `${this.percentageScore()}%`
      : `${correct}/${total}`;
  });

  readonly scoreAccessibleLabel = computed(() => {
    if (this.isPercentage()) {
      return $localize`Score ${this.percentageScore()} percent`;
    }
    const { correct, total } = this.scoreCounts();
    return $localize`Score ${correct} out of ${total}`;
  });

  ngOnInit(): void {
    this.restoreScoreDisplayPreference();
  }

  toggleScoreDisplay(scoreType?: 'numerical' | 'percentage'): void {
    const next = scoreType ? scoreType === 'percentage' : !this.isPercentage();
    if (next === this.isPercentage()) return;
    this.isPercentage.set(next);
    this.persistScoreDisplayPreference();
  }

  private restoreScoreDisplayPreference(): void {
    try {
      this.isPercentage.set(localStorage.getItem(this.scoreDisplayStorageKey) === 'percentage');
    } catch {
      this.isPercentage.set(false);
    }
  }

  private persistScoreDisplayPreference(): void {
    try {
      localStorage.setItem(
        this.scoreDisplayStorageKey,
        this.isPercentage() ? 'percentage' : 'numerical'
      );
    } catch (err) {
      swallow('score.component#1', err);
    }
  }
}
