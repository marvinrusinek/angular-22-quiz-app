import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { TitleCasePipe } from '@angular/common';

import { LearningPathState } from '@shared/models';

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
  template: `
    @if (state(); as s) {
      @if (s.allComplete) {
        <section class="rec" aria-labelledby="rec-heading">
          <p id="rec-heading" class="rec__eyebrow" i18n>Learning Path Complete</p>
          <p class="rec__done" i18n>
            You have completed all {{ s.totalCount }} topic quizzes.
          </p>
          <button
            type="button"
            class="rec__btn"
            (click)="buildInterview.emit()"
            aria-label="Build an interview"
            i18n-aria-label
            i18n
          >
            Build an Interview
          </button>
        </section>
      } @else if (s.recommendation; as r) {
        <section class="rec" aria-labelledby="rec-heading">
          <p id="rec-heading" class="rec__eyebrow" i18n>Recommended Next Quiz</p>

          <div class="rec__head">
            <h3 class="rec__title">{{ r.title }}</h3>
            @if (r.difficulty) {
              <span class="rec__difficulty">{{ r.difficulty | titlecase }}</span>
            }
          </div>

          <p class="rec__reason">{{ r.reason }}</p>

          <button
            type="button"
            class="rec__btn"
            (click)="startQuiz.emit(r.quizId)"
            [attr.aria-label]="r.actionLabel + ': ' + r.title"
          >
            {{ r.actionLabel }}
          </button>
        </section>
      }
    }
  `,
  styles: [`
    .rec {
      max-width: 560px;
      margin: 10px auto 18px;
      padding: 14px 18px;
      border: 1px solid var(--border-color, #e0e0e0);
      border-radius: 12px;
      background: var(--bg-secondary, #f5f5f5);
      box-sizing: border-box;
    }

    .rec__eyebrow {
      margin: 0 0 8px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.6px;
      text-transform: uppercase;
      color: var(--text-secondary, #555);
    }

    .rec__head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }

    .rec__title {
      margin: 0;
      font-size: 17px;
      font-weight: 700;
      color: var(--text-primary, #212121);
    }

    .rec__difficulty {
      flex: none;
      padding: 2px 9px;
      border-radius: 999px;
      background: var(--bg-card, #fff);
      border: 1px solid var(--border-color, #e0e0e0);
      font-size: 11px;
      font-weight: 600;
      color: var(--text-secondary, #555);
      white-space: nowrap;
    }

    .rec__reason,
    .rec__done {
      margin: 6px 0 12px;
      font-size: 13.5px;
      line-height: 1.45;
      color: var(--text-secondary, #555);
    }

    .rec__btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 8px 18px;
      border: none;
      border-radius: 8px;
      background: #3b98fd;                 /* vivid-blue, matches the app accent */
      color: #fff;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      transition: filter 0.15s ease;
    }

    .rec__btn:hover {
      filter: brightness(0.95);
    }

    .rec__btn:focus-visible {
      outline: 2px solid #3b98fd;
      outline-offset: 2px;
    }

    @media (max-width: 600px) {
      .rec__btn {
        width: 100%;
      }
    }
  `]
})
export class RecommendedNextQuizComponent {
  readonly state = input.required<LearningPathState | null>();

  /** Emits the quizId to start / continue (parent runs its existing nav). */
  readonly startQuiz = output<string>();
  /** Emits when the path is complete and the user chooses to build an interview. */
  readonly buildInterview = output<void>();
}
