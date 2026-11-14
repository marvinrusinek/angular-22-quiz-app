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
  templateUrl: './achievement-unlocked.component.html',
  styleUrl: './achievement-unlocked.component.scss'
})
export class AchievementUnlockedComponent {
  /** Achievements newly earned by the just-completed quiz. Empty → renders nothing. */
  readonly achievements = input<readonly AchievementDefinition[]>([]);
}
