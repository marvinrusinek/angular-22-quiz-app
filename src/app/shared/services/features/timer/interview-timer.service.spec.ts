import { InterviewTimerService } from './interview-timer.service';

describe('InterviewTimerService', () => {
  let service: InterviewTimerService;
  let now = 1_000_000;

  const advance = (ms: number) => {
    now += ms;
    jest.advanceTimersByTime(ms);
  };

  beforeEach(() => {
    jest.useFakeTimers();
    now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    service = new InterviewTimerService();
  });

  afterEach(() => {
    service.reset();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('starts at the full duration', () => {
    service.start(1800);
    expect(service.remainingSeconds()).toBe(1800);
    expect(service.formatted()).toBe('30:00');
  });

  it('counts down over time', () => {
    service.start(30);
    advance(5000);
    expect(service.remainingSeconds()).toBe(25);
    advance(20000);
    expect(service.remainingSeconds()).toBe(5);
  });

  it('emits expired exactly once at 0 and stops ticking', () => {
    service.start(3);
    let count = 0;
    service.expired$.subscribe(() => count++);
    advance(3000);
    expect(service.remainingSeconds()).toBe(0);
    expect(count).toBe(1);
    advance(10000);
    expect(count).toBe(1); // no further emissions
  });

  it('flags low time at or below 5 minutes remaining', () => {
    service.start(6 * 60);
    expect(service.isLowTime()).toBe(false);
    advance(61 * 1000); // 299s remaining
    expect(service.isLowTime()).toBe(true);
  });

  it('reports elapsed time', () => {
    service.start(100);
    advance(30000);
    expect(service.elapsedSeconds()).toBe(30);
  });

  it('pause() freezes the remaining time; resume() continues from there', () => {
    service.start(30);
    advance(5000);
    expect(service.remainingSeconds()).toBe(25);

    service.pause();
    advance(10000); // time passes while paused
    expect(service.remainingSeconds()).toBe(25); // frozen — no drain

    service.resume();
    advance(5000);
    expect(service.remainingSeconds()).toBe(20); // continues from 25
  });

  it('restores remaining time from a persisted expiry timestamp', () => {
    service.restore(now + 20000, 30);
    expect(service.remainingSeconds()).toBe(20);
    advance(20000);
    expect(service.remainingSeconds()).toBe(0);
  });

  it('restore with an already-past expiry lands at 0', () => {
    service.restore(now - 5000, 30);
    expect(service.remainingSeconds()).toBe(0);
  });
});
