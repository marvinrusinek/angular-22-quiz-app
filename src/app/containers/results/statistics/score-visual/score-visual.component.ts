import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

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
  imports: [],
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
  readonly badgeAria = computed(() => {
    const level = this.feedbackLevel();
    if (level === 'excellent') return $localize`Trophy. Excellent Performance!`;
    if (level === 'good') return $localize`Silver medal. Good Job!`;
    return $localize`Flexed biceps. Keep Practicing!`;
  });
  readonly circleAria = computed(() => $localize`${this.percentage()}% Score`);
  readonly breakdownAria = computed(
    () =>
      $localize`${this.correctCount()} Correct, ${this.incorrectCount()} Incorrect, ${this.timedOutCount()} Timed Out`
  );
}
