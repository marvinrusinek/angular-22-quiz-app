import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { IntroExposedTextDirective } from '../../../introduction/intro-exposed-text.directive';

/**
 * Presentational-only score visuals for the results screen: the circular SVG
 * score ring + percentage, the Correct/Incorrect/Timed-Out breakdown, the star
 * rating and the achievement badge. All numbers are computed by the parent
 * StatisticsComponent and passed in via signal inputs — this component holds NO
 * business logic. The host uses `display: contents` so its children participate
 * directly in the parent's `.score-col-visuals` flex column (identical layout).
 */
@Component({
  selector: 'app-score-visual',
  standalone: true,
  imports: [IntroExposedTextDirective],
  templateUrl: './score-visual.component.html',
  styleUrls: ['./score-visual.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ScoreVisualComponent {
  readonly percentage = input<number>(0);
  readonly feedbackLevel = input<'excellent' | 'good' | 'poor'>('poor');
  readonly correctCount = input<number>(0);
  readonly incorrectCount = input<number>(0);
  readonly timedOutCount = input<number>(0);
  readonly starCount = input<number>(0);
  readonly starsAria = computed(() => {
    const n = this.starCount();
    return n === 1 ? $localize`${n} Star` : $localize`${n} Stars`;
  });
  // The achievement badge: the visible icon and text, and the text Narrator reads,
  // all come from these signals. The icon is decorative and never announced.
  readonly badgeIcon = computed(() => {
    const level = this.feedbackLevel();
    if (level === 'excellent') return '🏆';
    if (level === 'good') return '🥈';
    return '💪';
  });
  readonly badgeText = computed(() => {
    const level = this.feedbackLevel();
    if (level === 'excellent') return $localize`Excellent Performance!`;
    if (level === 'good') return $localize`Good Job!`;
    return $localize`Keep Practicing!`;
  });
  readonly circleAria = computed(() => $localize`${this.percentage()}% Score`);
  // The breakdown rows. The VISIBLE rows and the text Narrator reads both come
  // from these signals (the visible rows add their ✔ ✖ ⏱ symbol).
  readonly correctText = computed(() => $localize`${this.correctCount()} Correct`);
  readonly incorrectText = computed(() => $localize`${this.incorrectCount()} Incorrect`);
  readonly timedOutText = computed(() => $localize`${this.timedOutCount()} Timed Out`);
  /** One line per visible row; the group exposes it as ONE text item. */
  readonly breakdownExposedText = computed(() =>
    [this.correctText(), this.incorrectText(), this.timedOutText()].join('\n')
  );
}
