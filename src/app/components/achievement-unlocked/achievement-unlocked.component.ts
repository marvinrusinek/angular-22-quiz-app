import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { AchievementDefinition } from '@shared/models';

/**
 * Announces the achievement(s) earned by the just-completed quiz on the Results
 * screen. Pure presentation: it takes an already-computed list and renders it —
 * no localStorage, no rule logic. Renders NOTHING when the list is empty (so it
 * never re-shows after a refresh, when the parent passes []).
 *
 * Accessibility: a semantic <section> + heading, readable without the icon,
 * and a conservative `role="status"` (polite) live region that announces once
 * on mount without stealing focus. Not color-only — text carries the meaning.
 */
@Component({
  selector: 'codelab-achievement-unlocked',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (achievements().length > 0) {
      <section class="achievement-unlocked" role="status" aria-live="polite">
        <h3 class="achievement-unlocked__heading">
          <span class="achievement-unlocked__icon" aria-hidden="true">🏆</span>
          <ng-container i18n>Achievement Unlocked</ng-container>
        </h3>
        <ul class="achievement-unlocked__list">
          @for (achievement of achievements(); track achievement.id) {
            <li class="achievement-unlocked__item">
              <span class="achievement-unlocked__name">
                @if (achievement.icon) {
                  <span class="achievement-unlocked__emoji" aria-hidden="true">{{ achievement.icon }}</span>
                }
                {{ achievement.name }}
              </span>
              <span class="achievement-unlocked__desc">{{ achievement.description }}</span>
            </li>
          }
        </ul>
      </section>
    }
  `,
  styles: [`
    .achievement-unlocked {
      max-width: 640px;
      margin: 22px auto 8px;
      padding: 14px 18px;
      border: 1px solid var(--border-color, #e0e0e0);
      border-left: 4px solid #f5a623;
      border-radius: 10px;
      background: var(--bg-secondary, #f5f5f5);
      box-sizing: border-box;
    }

    .achievement-unlocked__heading {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0 0 8px;
      font-size: 15px;
      font-weight: 700;
      color: var(--text-primary, #212121);
    }

    .achievement-unlocked__icon {
      font-size: 18px;
      line-height: 1;
    }

    .achievement-unlocked__list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .achievement-unlocked__item {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .achievement-unlocked__name {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary, #212121);
    }

    .achievement-unlocked__emoji {
      margin-right: 4px;
    }

    .achievement-unlocked__desc {
      font-size: 13px;
      line-height: 1.5;
      color: var(--text-secondary, #555555);
    }

    @media (max-width: 600px) {
      .achievement-unlocked {
        margin: 18px 8px 8px;
        padding: 12px 14px;
      }
    }
  `]
})
export class AchievementUnlockedComponent {
  /** Achievements newly earned by the just-completed quiz. Empty → renders nothing. */
  readonly achievements = input<readonly AchievementDefinition[]>([]);
}
