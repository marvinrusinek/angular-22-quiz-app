import {
  ChangeDetectionStrategy, Component, computed, inject, LOCALE_ID
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatMenuModule } from '@angular/material/menu';

import { TimerService } from '@shared/services/features/timer/timer.service';
import { formatMMSS } from '@shared/utils/format-time';

enum TimerType {
  Countdown = 'countdown',
  Stopwatch = 'stopwatch'
}

@Component({
  selector: 'codelab-scoreboard-timer',
  standalone: true,
  imports: [MatMenuModule],
  templateUrl: './timer.component.html',
  styleUrls: ['./timer.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class TimerComponent {
  // ── injects ─────────────────────────────────────────────────────
  private readonly timerService = inject(TimerService);
  private readonly locale = inject(LOCALE_ID);
  private readonly minuteFormatter = new Intl.NumberFormat(this.locale, {
    style: 'unit', unit: 'minute', unitDisplay: 'long'
  });
  private readonly secondFormatter = new Intl.NumberFormat(this.locale, {
    style: 'unit', unit: 'second', unitDisplay: 'long'
  });
  private readonly durationFormatter = new Intl.ListFormat(this.locale, {
    style: 'long', type: 'conjunction'
  });

  // ── remaining variables ─────────────────────────────────────────
  readonly timerType = TimerType;
  readonly timePerQuestion = 30;

  private readonly elapsedSig = toSignal(this.timerService.elapsedTime$, { initialValue: 0 });

  private readonly timerTypeSig = toSignal(this.timerService.timerType$, {
    initialValue: this.timerService.isCountdown() ? 'countdown' : 'stopwatch'
  });

  readonly currentTimerType = computed<TimerType>(() =>
    this.timerTypeSig() === 'countdown' ? TimerType.Countdown : TimerType.Stopwatch
  );

  readonly displayTime = computed<number>(() => {
    const elapsed = this.elapsedSig() ?? 0;
    return this.currentTimerType() === TimerType.Countdown
      ? Math.max(this.timePerQuestion - elapsed, 0)
      : elapsed;
  });

  private readonly displaySeconds = computed(() => {
    const time = this.displayTime();
    return Number.isFinite(time) ? Math.max(0, Math.round(time)) : 0;
  });

  readonly displayClock = computed(() => formatMMSS(this.displaySeconds()));

  readonly timerAccessibleLabel = computed(() => {
    const total = this.displaySeconds();
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    const parts: string[] = [];
    if (minutes > 0) parts.push(this.minuteFormatter.format(minutes));
    if (seconds > 0 || minutes === 0) {
      parts.push(this.secondFormatter.format(seconds));
    }
    return $localize`Timer ${this.durationFormatter.format(parts)}`;
  });

  /** True when the countdown has 5 or fewer seconds remaining. Used to flag
   *  the display red. Only applies in countdown mode — stopwatch never
   *  decrements so the "low time" concept doesn't apply. */
  readonly isLowTime = computed<boolean>(
    () => this.currentTimerType() === TimerType.Countdown && this.displayTime() <= 5
  );

  setTimerType(type: TimerType): void {
    if (this.currentTimerType() === type) return;
    this.timerService.setTimerType(type === TimerType.Countdown ? 'countdown' : 'stopwatch');
  }
}
