import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input
} from '@angular/core';

import { AchievementView } from '@shared/models';

/**
 * The "Achievements N of M" catalog for the Results screen, an ALWAYS-VISIBLE section. A heading carries the earned count and every
 * achievement is shown as a named, non-interactive row with its earned/locked state distinguished by icon + text (not color alone). There is no disclosure button, no aria-expanded and no chevron.
 *
 * Pure presentation: it takes an already-resolved list of {definition, earned}; renders nothing when the list is empty.
 */
@Component({
  selector: 'codelab-achievements-catalog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (total() > 0) {
      <section class="achievements-catalog">
        <!-- Always-visible section. The heading's text is the earned count ("Achievements, N of M"); there is no disclosure
             button, no aria-expanded and no chevron, so nothing here is interactive. -->
        <h3 class="achievements-catalog__heading">
          <span
            class="achievements-catalog__icon"
            aria-hidden="true"
          >
            🏆
          </span>
          <span class="achievements-catalog__title">{{ toggleLabel() }}</span>
        </h3>

          <!-- role="none" on the <ul>: no list semantics, so no item positions ("2 of 6") are announced. Each row is
               ONE named graphic (role="img") whose name is "<name>. <description>. <Earned|Locked>."; its visible
               icon, name, description and status are hidden from assistive technology so nothing is read twice.
               Nothing interactive lives inside a row (no tabindex, focus handling or key handlers). -->
          <ul
            id="achievements-catalog-list"
            class="achievements-catalog__list"
            role="none"
          >
            @for (achievement of achievements(); track achievement.id) {
              <li
                role="img"
                [attr.aria-label]="rowLabel(achievement)"
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
                  aria-hidden="true"
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
                  aria-hidden="true"
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

      .achievements-catalog__heading {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0;
        padding: 12px 16px;
        font: inherit;
        color: var(--text-primary, #212121);
      }

      .achievements-catalog__icon {
        font-size: 17px;
        line-height: 1;
      }

      .achievements-catalog__title {
        font-size: 15px;
        font-weight: 700;
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

  readonly total = computed(() => this.achievements().length);
  readonly earnedCount = computed(() => this.achievements().filter((a) => a.earned).length);

  /** One complete accessible name for the toggle: "Achievements, <earned> of <total>". */
  readonly toggleLabel = computed(
    () => $localize`Achievements, ${this.earnedCount()} of ${this.total()}`
  );

  /**
   * One complete accessible name per achievement row: "<name>. <description>. <Earned|Locked>." The
   * description's own terminal period is dropped so the sentence does not end "..".
   */
  rowLabel(a: AchievementView): string {
    const description = a.description.replace(/\.$/, '');
    const status = a.earned ? $localize`Earned` : $localize`Locked`;
    return $localize`${a.name}. ${description}. ${status}.`;
  }

}
