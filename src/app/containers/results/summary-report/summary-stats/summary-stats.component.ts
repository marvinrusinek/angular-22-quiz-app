import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';

import { QuizMetadata, QuizScore } from '@shared/models';

@Component({
  selector: 'codelab-summary-stats',
  standalone: true,
  imports: [DatePipe],
  templateUrl: './summary-stats.component.html',
  styleUrls: ['./summary-stats.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SummaryStatsComponent {
  // ── inputs ──────────────────────────────────────────────────────
  readonly quizMetadata = input<Partial<QuizMetadata> | null>({
    correctAnswersCount: signal(0),
    totalQuestions: 0,
    totalQuestionsAttempted: 0,
    percentage: 0,
    completionTime: 0
  });
  readonly score = input<QuizScore | null>(null);
  readonly elapsedMinutes = input(0);
  readonly elapsedSeconds = input(0);
  readonly isShuffled = input(false);
}
