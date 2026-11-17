import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input
} from '@angular/core';

import { AchievementView } from '@shared/models';

import { IntroExposedTextDirective } from '../../containers/introduction/intro-exposed-text.directive';

/**
 * The "Achievements N of M" catalog for the Results screen, an ALWAYS-VISIBLE section. A heading carries the earned count and every
 * achievement is shown as a named, non-interactive row with its earned/locked state distinguished by icon + text (not color alone). There is no disclosure button, no aria-expanded and no chevron.
 *
 * Each row is ONE Narrator group: its icon, name, description and status are
 * hidden from assistive technology and the row exposes a single text node
 * ("<name>. <description>. <Earned|Locked>.") from rowLabel(), the same source
 * as the visible parts (see IntroExposedTextDirective). Nothing is interactive.
 *
 * Pure presentation: it takes an already-resolved list of {definition, earned}; renders nothing when the list is empty.
 */
@Component({
  selector: 'codelab-achievements-catalog',
  standalone: true,
  imports: [IntroExposedTextDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './achievements-catalog.component.html',
  styleUrl: './achievements-catalog.component.scss'
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
    return $localize`${a.name}. ${description}. ${this.statusLabel(a)}.`;
  }

  /** "Earned" / "Locked": the visible badge and the row's exposed text share it. */
  statusLabel(a: AchievementView): string {
    return a.earned ? $localize`Earned` : $localize`Locked`;
  }

}
