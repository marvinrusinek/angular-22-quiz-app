import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type QuizCardProgressState = 'not-started' | 'in-progress' | 'completed';

/**
 * A single compact progress line for a quiz card: "Not Started", "In Progress",
 * or "Completed · Best 80%". Pure presentation — the state and best score are
 * derived by the host; this component renders one line in every state so the
 * card height stays consistent. State is conveyed by text (not color alone),
 * and the best score shows only when the quiz is completed.
 */
@Component({
  selector: 'codelab-quiz-card-progress',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span
      class="quiz-card-progress"
      [class]="'quiz-card-progress--' + state()"
    >
      @switch (state()) {
        @case ('completed') {
          <span
            class="quiz-card-progress__label"
            i18n
          >
            Completed
          </span>
          @if (bestScore() !== null) {
            <span class="quiz-card-progress__score">
              ·
              <ng-container i18n>Best</ng-container>
              {{ bestScore() }}%
            </span>
          }
        }
        @case ('in-progress') {
          <span
            class="quiz-card-progress__label"
            i18n
          >
            In Progress
          </span>
        }
        @default {
          <span
            class="quiz-card-progress__label"
            i18n
          >
            Not Started
          </span>
        }
      }
    </span>
  `,
  styles: [
    `
      .quiz-card-progress {
        display: inline-flex;
        align-items: baseline;
        gap: 4px;
        font-size: 12px;
        font-weight: 700;
        line-height: 1.4;
        letter-spacing: 0.3px;
      }

      .quiz-card-progress__score {
        font-weight: 600;
        color: var(--text-secondary, #555555);
      }

      .quiz-card-progress--completed .quiz-card-progress__label {
        color: #2e9e5b;
      }

      .quiz-card-progress--in-progress .quiz-card-progress__label {
        color: var(--text-link, #3b98fd);
      }

      .quiz-card-progress--not-started .quiz-card-progress__label {
        color: var(--text-secondary, #888888);
      }
    `
  ]
})
export class QuizCardProgressComponent {
  /** Which progress state to render. */
  readonly state = input<QuizCardProgressState>('not-started');
  /** Best score (0-100); shown only in the completed state. Null hides the score. */
  readonly bestScore = input<number | null>(null);
}
