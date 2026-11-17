import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { IntroExposedTextDirective } from '../../containers/introduction/intro-exposed-text.directive';

/**
 * Shows a single "Angular Fact" for a quiz on the Results screen.
 *
 * - Takes the quiz's optional facts (1-3) as a signal input.
 * - Picks ONE random fact via a `computed()`. Because computed is memoized, the
 *   random pick runs once (when the facts input first has a value) and never
 *   recalculates during change detection. A fresh component instance (a new
 *   Results visit) may pick a different fact.
 * - Renders nothing when the quiz has no facts. No side effects; reusable.
 * - The note is ONE Narrator group: the icon, the "Angular Fact" label and the
 *   paragraph are hidden from assistive technology and the group exposes a single
 *   text node, "Angular Fact. <the displayed fact>", from the same signals that
 *   render the visible parts (see IntroExposedTextDirective). Nothing is
 *   interactive, and the label is a div, not a heading, on purpose.
 */
@Component({
  selector: 'codelab-quiz-fact',
  standalone: true,
  imports: [IntroExposedTextDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (fact(); as text) {
      <section class="quiz-fact">
        <!-- One group: the visible label, icon and paragraph are hidden from assistive technology and the group
             exposes ONE text node, "Angular Fact. <the displayed fact>" (see IntroExposedTextDirective), so
             Narrator reads the note once, as a group, never as a graphic. The label is a div (not an h3) on
             purpose: no separate heading / H navigation for this note. -->
        <div class="quiz-fact__group" role="group">
          <div class="quiz-fact__visible" data-intro-visible aria-hidden="true">
            <div class="quiz-fact__heading">
              <span class="quiz-fact__icon">💡</span>
              {{ label }}
            </div>
            <p class="quiz-fact__text" data-intro-font-ref>{{ text }}</p>
          </div>
          <span [appIntroExposedText]="exposedText()" exposedTextMode="cover" exposedTextBox="group"></span>
        </div>
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

      /* The Narrator group: the label and the paragraph, laid out as the card laid them out
         (the card keeps its padding, so the group is the content box). */
      .quiz-fact__group {
        position: relative; /* anchors the exposed text (IntroExposedTextDirective) */
      }

      /* Holds the visible parts so they can be hidden from AT as one unit; it generates no box. */
      .quiz-fact__visible {
        display: contents;
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

  /** The visible "Angular Fact" label; the exposed text starts with the same string. */
  readonly label = $localize`Angular Fact`;

  /**
   * What Narrator reads: the label plus exactly the fact being displayed (reads the
   * same memoized `fact()`; never picks a second random fact).
   */
  readonly exposedText = computed(() => {
    const text = this.fact();
    return text ? $localize`${this.label}. ${text}` : '';
  });

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
