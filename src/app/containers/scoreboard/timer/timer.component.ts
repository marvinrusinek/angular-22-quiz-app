import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { DecimalPipe } from '@angular/common';
import { MatMenuModule } from '@angular/material/menu';

import { TimerService } from '@shared/services/features/timer/timer.service';

enum TimerType {
  Countdown = 'countdown',
  Stopwatch = 'stopwatch'
}

@Component({
  selector: 'codelab-scoreboard-timer',
  standalone: true,
  imports: [MatMenuModule, DecimalPipe],
  templateUrl: './timer.component.html',
  styleUrls: ['./timer.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class TimerComponent {
  // ── injects ─────────────────────────────────────────────────────
  private readonly timerService = inject(TimerService);

  // ── remaining variables ─────────────────────────────────────────
  readonly timerType = TimerType;
  readonly timePerQuestion = 30;

  private readonly elapsedSig = toSignal(
    this.timerService.elapsedTime$,
    { initialValue: 0 }
  );

  private readonly timerTypeSig = toSignal(
    this.timerService.timerType$,
    {
      initialValue: this.timerService.isCountdown() ? 'countdown' : 'stopwatch'
    }
  );

  readonly currentTimerType = computed<TimerType>(() =>
    this.timerTypeSig() === 'countdown' ? TimerType.Countdown : TimerType.Stopwatch
  );

  readonly displayTime = computed<number>(() => {
    const elapsed = this.elapsedSig() ?? 0;
    return this.currentTimerType() === TimerType.Countdown
      ? Math.max(this.timePerQuestion - elapsed, 0)
      : elapsed;
  });

  /** True when the countdown has 5 or fewer seconds remaining. Used to flag
   *  the display red. Only applies in countdown mode — stopwatch never
   *  decrements so the "low time" concept doesn't apply. */
  readonly isLowTime = computed<boolean>(() =>
    this.currentTimerType() === TimerType.Countdown && this.displayTime() <= 5
  );

  setTimerType(type: TimerType): void {
    if (this.currentTimerType() === type) return;
    this.timerService.setTimerType(
      type === TimerType.Countdown ? 'countdown' : 'stopwatch'
    );
  }
}
