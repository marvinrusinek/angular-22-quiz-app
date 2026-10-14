import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * Shows a single "Angular Fact" for a quiz on the Results screen.
 *
 * - Takes the quiz's optional facts (1-3) as a signal input.
 * - Picks ONE random fact via a `computed()`. Because computed is memoized, the
 *   random pick runs once (when the facts input first has a value) and never
 *   recalculates during change detection. A fresh component instance (a new
 *   Results visit) may pick a different fact.
 * - Renders nothing when the quiz has no facts. No side effects; reusable.
 */
@Component({
  selector: 'codelab-quiz-fact',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (fact(); as text) {
      <section
        class="quiz-fact"
        role="note"
      >
        <h3 class="quiz-fact__heading">
          <span
            class="quiz-fact__icon"
            aria-hidden="true"
          >
            💡
          </span>
          <ng-container i18n>Angular Fact</ng-container>
        </h3>
        <p class="quiz-fact__text">{{ text }}</p>
      </section>
    }
  `,
  styles: [
    `
      .quiz-fact {
        max-width: 640px;
        margin: 22px auto 8px;
        padding: 14px 18px;
        border: 1px solid var(--border-color, #e0e0e0);
        border-left: 4px solid var(--text-link, #3b98fd);
        border-radius: 10px;
        background: var(--bg-secondary, #f5f5f5);
        box-sizing: border-box;
      }

      .quiz-fact__heading {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0 0 6px;
        font-size: 15px;
        font-weight: 700;
        color: var(--text-primary, #212121);
      }

      .quiz-fact__icon {
        font-size: 18px;
        line-height: 1;
      }

      .quiz-fact__text {
        margin: 0;
        font-size: 14px;
        line-height: 1.5;
        color: var(--text-secondary, #555555);
      }

      @media (max-width: 600px) {
        .quiz-fact {
          margin: 18px 8px 8px;
          padding: 12px 14px;
        }
      }
    `
  ]
})
export class QuizFactComponent {
  /** The quiz's facts (1-3). Optional — the component renders nothing if empty. */
  readonly facts = input<readonly string[] | undefined>();

  /**
   * One random fact, chosen a single time (computed is lazy + memoized, so it is
   * not re-evaluated on every change-detection cycle). Null when there are no facts.
   */
  readonly fact = computed<string | null>(() => {
    const list = this.facts();
    if (!list || list.length === 0) {
      return null;
    }
    return list[Math.floor(Math.random() * list.length)];
  });
}
