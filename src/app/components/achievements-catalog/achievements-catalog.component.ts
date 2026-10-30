import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';

import { AchievementView } from '@shared/models';

/**
 * Expandable "Achievements X / N" catalog for the Results screen.
 *
 * Collapsed it shows just the earned count. Clicking the header (a real button —
 * no hover-only behavior) reveals ALL achievements with each one's earned/locked
 * state clearly distinguished by icon + text label (not color alone).
 *
 * Pure presentation: it takes an already-resolved list of {definition, earned}
 * — no storage or rule logic. Renders nothing when the list is empty.
 *
 * Accessibility: a native disclosure button carrying `aria-expanded` +
 * `aria-controls`, a labelled region, and per-item "Earned"/"Locked" text so the
 * state is conveyed without relying on color.
 */
@Component({
  selector: 'codelab-achievements-catalog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (total() > 0) {
      <section class="achievements-catalog">
        <button
          type="button"
          class="achievements-catalog__toggle"
          [attr.aria-expanded]="expanded()"
          aria-controls="achievements-catalog-list"
          (click)="toggle()"
        >
          <span
            class="achievements-catalog__icon"
            aria-hidden="true"
          >
            🏆
          </span>
          <span
            class="achievements-catalog__title"
            i18n
          >
            Achievements
          </span>
          <span class="achievements-catalog__count">{{ earnedCount() }} / {{ total() }}</span>
          <span
            class="achievements-catalog__chevron"
            aria-hidden="true"
          >
            {{ expanded() ? '▲' : '▼' }}
          </span>
        </button>

        @if (expanded()) {
          <!-- role="none" on the ul and li: no list semantics, so Narrator does not announce "enter list" or an
               item position ("1 of 6"). Text, order, styling and the toggle are unchanged; nothing here is interactive. -->
          <ul
            id="achievements-catalog-list"
            class="achievements-catalog__list"
            role="none"
          >
            @for (achievement of achievements(); track achievement.id) {
              <!-- EXPERIMENT (local, NOT a confirmed fix): the Perfect Score row ONLY is one focusable group
                   (role="group", tabindex="0") named with one complete translated label; its visible icon, text and
                   badge stay on screen but are hidden from assistive technology so nothing is read twice. Nothing
                   inside is interactive. Every other row keeps role="none" and its visible text exposed. -->
              <li
                [attr.role]="isExperimentalRow(achievement) ? 'group' : 'none'"
                [attr.tabindex]="isExperimentalRow(achievement) ? 0 : null"
                [attr.aria-label]="isExperimentalRow(achievement) ? rowLabel(achievement) : null"
                class="achievements-catalog__item"
                [class.is-earned]="achievement.earned"
                [class.is-locked]="!achievement.earned"
              >
                <span
                  class="achievements-catalog__state-icon"
                  aria-hidden="true"
                >
                  {{ achievement.earned ? '✓' : '🔒' }}
                </span>
                <span
                  class="achievements-catalog__body"
                  [attr.aria-hidden]="isExperimentalRow(achievement) ? 'true' : null"
                >
                  <span class="achievements-catalog__name">
                    @if (achievement.icon) {
                      <span
                        class="achievements-catalog__emoji"
                        aria-hidden="true"
                      >
                        {{ achievement.icon }}
                      </span>
                    }
                    {{ achievement.name }}
                  </span>
                  <!-- Trailing U+00A0 (&nbsp;): a plain/collapsible space between this description and the
                       Earned/Locked status is dropped from the page's accessible text, so UIA exposed
                       "...quiz.LOCKED" (Narrator spoke a "dot" there). A non-breaking space survives. -->
                  <span class="achievements-catalog__desc">{{ achievement.description }}&nbsp;</span>
                </span>
                <span
                  class="achievements-catalog__badge"
                  [attr.aria-hidden]="isExperimentalRow(achievement) ? 'true' : null"
                >
                  @if (achievement.earned) {
                    <ng-container i18n>Earned</ng-container>
                  } @else {
                    <ng-container i18n>Locked</ng-container>
                  }
                </span>
              </li>
            }
          </ul>
        }
      </section>
    }
  `,
  styles: [
    `
      .achievements-catalog {
        max-width: 640px;
        margin: 12px auto 8px;
        border: 1px solid var(--border-color, #e0e0e0);
        border-radius: 10px;
        background: var(--bg-secondary, #f5f5f5);
        box-sizing: border-box;
        overflow: hidden;
      }

      .achievements-catalog__toggle {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 12px 16px;
        border: none;
        background: transparent;
        cursor: pointer;
        font: inherit;
        color: var(--text-primary, #212121);
        text-align: left;
      }

      .achievements-catalog__toggle:hover {
        background: var(--bg-hover, rgba(0, 0, 0, 0.04));
      }

      .achievements-catalog__toggle:focus-visible {
        outline: 2px solid var(--text-link, #3b98fd);
        outline-offset: -2px;
      }

      .achievements-catalog__icon {
        font-size: 17px;
        line-height: 1;
      }

      .achievements-catalog__title {
        font-size: 15px;
        font-weight: 700;
      }

      .achievements-catalog__count {
        font-size: 14px;
        font-variant-numeric: tabular-nums;
        color: var(--text-secondary, #555555);
      }

      .achievements-catalog__chevron {
        margin-left: auto;
        font-size: 11px;
        color: var(--text-secondary, #555555);
      }

      .achievements-catalog__list {
        list-style: none;
        margin: 0;
        padding: 4px 0 8px;
        border-top: 1px solid var(--border-color, #e0e0e0);
      }

      .achievements-catalog__item {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 8px 16px;
      }

      .achievements-catalog__state-icon {
        flex: 0 0 auto;
        width: 18px;
        text-align: center;
        font-size: 14px;
        line-height: 1.4;
      }

      .achievements-catalog__item.is-earned .achievements-catalog__state-icon {
        color: #2e9e5b;
      }

      .achievements-catalog__body {
        display: flex;
        flex-direction: column;
        gap: 2px;
        flex: 1 1 auto;
      }

      .achievements-catalog__name {
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary, #212121);
      }

      .achievements-catalog__emoji {
        margin-right: 4px;
      }

      .achievements-catalog__desc {
        font-size: 13px;
        line-height: 1.4;
        color: var(--text-secondary, #555555);
      }

      /* Locked rows are visibly de-emphasised, but state is ALSO carried by the
       lock icon + "Locked" text — never by color alone. */
      .achievements-catalog__item.is-locked .achievements-catalog__name,
      .achievements-catalog__item.is-locked .achievements-catalog__desc {
        opacity: 0.6;
      }

      .achievements-catalog__badge {
        flex: 0 0 auto;
        align-self: center;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.4px;
      }

      .achievements-catalog__item.is-earned .achievements-catalog__badge {
        color: #2e9e5b;
      }

      .achievements-catalog__item.is-locked .achievements-catalog__badge {
        color: var(--text-secondary, #888888);
      }

      @media (max-width: 600px) {
        .achievements-catalog {
          margin: 12px 8px 8px;
        }
      }
    `
  ]
})
export class AchievementsCatalogComponent {
  /** Every achievement paired with its earned/locked state. Empty → renders nothing. */
  readonly achievements = input<readonly AchievementView[]>([]);

  readonly expanded = signal(false);

  readonly total = computed(() => this.achievements().length);
  readonly earnedCount = computed(() => this.achievements().filter((a) => a.earned).length);

  /** Experimental single-row grouping: only Perfect Score. */
  isExperimentalRow(a: AchievementView): boolean {
    return a.id === 'perfect-score';
  }

  /** One complete accessible name: "<name>. <description>. <Earned|Locked>." (description's own final period dropped). */
  rowLabel(a: AchievementView): string {
    const description = a.description.replace(/.$/, '');
    const status = a.earned ? $localize`Earned` : $localize`Locked`;
    return $localize`${a.name}. ${description}. ${status}.`;
  }

  toggle(): void {
    this.expanded.update((v) => !v);
  }
}
