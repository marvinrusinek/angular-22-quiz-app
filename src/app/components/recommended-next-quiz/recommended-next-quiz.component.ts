import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { TitleCasePipe } from '@angular/common';

import { LearningPathState, ReviewRecommendation } from '@shared/models';

/**
 * Compact "Recommended Next Quiz" card for Quiz Selection, shown beneath Your
 * Progress. Pure presentation: it renders an already-derived LearningPathState
 * and emits the user's intent — the parent owns navigation (its existing
 * quiz-start flow / Interview Builder). No recommendation logic lives here.
 */
@Component({
  selector: 'codelab-recommended-next-quiz',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TitleCasePipe],
  templateUrl: './recommended-next-quiz.component.html',
  styleUrl: './recommended-next-quiz.component.scss'
})
export class RecommendedNextQuizComponent {
  readonly state = input.required<LearningPathState | null>();

  /** When set, the card shows this review suggestion instead of `state`. */
  readonly review = input<ReviewRecommendation | null>(null);

  /** Accessible-name prefix; the visible button text is "Review Quiz". */
  protected readonly reviewLabel = $localize`Review quiz`;

  /** Emits the quizId the user wants to review (opens its Introduction). */
  readonly reviewQuiz = output<string>();

  /** Emits the quizId to start / continue (parent runs its existing nav). */
  readonly startQuiz = output<string>();
  /** Emits when the path is complete and the user chooses to build an interview. */
  readonly buildInterview = output<void>();
}
