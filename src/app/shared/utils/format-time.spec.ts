import { formatDuration, formatMMSS } from './format-time';

describe('formatMMSS', () => {
  it('formats minutes:seconds with two-digit seconds', () => {
    expect(formatMMSS(1800)).toBe('30:00');
    expect(formatMMSS(65)).toBe('1:05');
    expect(formatMMSS(9)).toBe('0:09');
    expect(formatMMSS(0)).toBe('0:00');
    expect(formatMMSS(600)).toBe('10:00');
  });

  it('clamps negatives and floors fractions', () => {
    expect(formatMMSS(-5)).toBe('0:00');
    expect(formatMMSS(90.9)).toBe('1:30');
  });
});

describe('formatDuration', () => {
  it('reads as prose: minutes + seconds', () => {
    expect(formatDuration(1471)).toBe('24m 31s'); // 24m 31s
    expect(formatDuration(65)).toBe('1m 5s');
  });

  it('drops the minutes when under a minute', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(0)).toBe('0s');
  });

  it('adds hours when needed', () => {
    expect(formatDuration(3600)).toBe('1h 0m 0s');
    expect(formatDuration(3871)).toBe('1h 4m 31s');
  });

  it('clamps negatives / invalid to 0s', () => {
    expect(formatDuration(-10)).toBe('0s');
    expect(formatDuration(NaN)).toBe('0s');
  });
});
