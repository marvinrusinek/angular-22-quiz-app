import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LOCALE_ID } from '@angular/core';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { BehaviorSubject } from 'rxjs';

import { TimerService } from '@shared/services/features/timer/timer.service';
import { TimerComponent } from './timer.component';

function mount(elapsed = 1, mode: 'countdown' | 'stopwatch' = 'countdown') {
  const elapsedTime$ = new BehaviorSubject(elapsed);
  const timerType$ = new BehaviorSubject(mode);
  const setTimerType = jest.fn((next: 'countdown' | 'stopwatch') => {
    timerType$.next(next);
  });
  TestBed.configureTestingModule({
    imports: [TimerComponent],
    providers: [
      provideNoopAnimations(),
      { provide: LOCALE_ID, useValue: 'en-US' },
      {
        provide: TimerService,
        useValue: {
          elapsedTime$,
          timerType$,
          isCountdown: () => mode === 'countdown',
          setTimerType
        }
      }
    ]
  });
  const fixture = TestBed.createComponent(TimerComponent);
  fixture.detectChanges();
  return { fixture, elapsedTime$, setTimerType };
}

function control(fixture: ComponentFixture<TimerComponent>) {
  return fixture.nativeElement.querySelector(
    'button.scoreboard-control'
  ) as HTMLButtonElement;
}

describe('TimerComponent — combined timer menu control', () => {
  it('includes label and clock in one menu button, named in seconds', () => {
    const { fixture } = mount();
    const button = control(fixture);
    expect(button.type).toBe('button');
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.getAttribute('aria-label')).toBe('Timer 29 seconds');
    expect(button.querySelector('.leader')?.textContent).toBe('Timer▼');
    expect(button.querySelector('.scoreboard')?.textContent).toBe('0:29');
    expect(button.querySelector('.scoreboard-timer')?.getAttribute(
      'aria-hidden'
    )).toBe('true');
    expect(button.closest('[aria-hidden="true"]')).toBeNull();
  });

  it.each([
    [0, '0:00', 'Timer 0 seconds'],
    [1, '0:01', 'Timer 1 second'],
    [29, '0:29', 'Timer 29 seconds'],
    [60, '1:00', 'Timer 1 minute'],
    [61, '1:01', 'Timer 1 minute and 1 second'],
    [122, '2:02', 'Timer 2 minutes and 2 seconds']
  ])('formats elapsed %s seconds consistently', (seconds, clock, name) => {
    const { fixture } = mount(seconds, 'stopwatch');
    expect(control(fixture).getAttribute('aria-label')).toBe(name);
    expect(control(fixture).querySelector('.scoreboard')?.textContent).toBe(clock);
  });

  it('updates the name and display, preserves the warning, and clamps expiry', async () => {
    const { fixture, elapsedTime$ } = mount();
    elapsedTime$.next(29);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(control(fixture).getAttribute('aria-label')).toBe('Timer 1 second');
    expect(control(fixture).querySelector('.scoreboard.low-time')).not.toBeNull();

    elapsedTime$.next(35);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.componentInstance.displayTime()).toBe(0);
    expect(control(fixture).getAttribute('aria-label')).toBe('Timer 0 seconds');
    expect(control(fixture).querySelector('.scoreboard')?.textContent).toBe('0:00');
    expect(fixture.nativeElement.querySelector('[aria-live]')).toBeNull();
  });

  it('opens the existing menu from the clock and changes mode once', async () => {
    const { fixture, setTimerType } = mount(6);
    (control(fixture).querySelector('.scoreboard') as HTMLElement).click();
    await fixture.whenStable();
    fixture.detectChanges();
    const stopwatch = document.querySelector(
      'button[aria-label="Set to Stopwatch"]'
    ) as HTMLButtonElement;
    expect(stopwatch).not.toBeNull();
    stopwatch.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(setTimerType).toHaveBeenCalledTimes(1);
    expect(setTimerType).toHaveBeenCalledWith('stopwatch');
    expect(control(fixture).getAttribute('aria-label')).toBe('Timer 6 seconds');
    expect(control(fixture).querySelector('.scoreboard.low-time')).toBeNull();
  });
});
