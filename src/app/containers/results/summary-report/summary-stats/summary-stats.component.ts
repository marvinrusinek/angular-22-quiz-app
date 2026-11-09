import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
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

  // "N minute(s) and N second(s)". Exactly 1 is singular; 0 and 2+ are plural. Built as ONE string and rendered through a single
  // interpolation so the row stays one text node (an ICU plural expression would split it into several; see the template note).
  readonly elapsedText = computed(() => {
    const minutes = this.elapsedMinutes();
    const seconds = this.elapsedSeconds();
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} and ${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
  });
}
