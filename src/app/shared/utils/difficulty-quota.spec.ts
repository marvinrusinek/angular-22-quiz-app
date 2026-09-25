import {
  calculateDifficultyQuota,
  DifficultyDistribution,
  isValidDistribution
} from './difficulty-quota';
import { INTERVIEW_PRESETS } from '@shared/models/interview-preset.model';

const dist = (b: number, i: number, a: number): DifficultyDistribution => ({
  beginner: b,
  intermediate: i,
  advanced: a
});
const total = (q: { beginner: number; intermediate: number; advanced: number }): number =>
  q.beginner + q.intermediate + q.advanced;

describe('isValidDistribution', () => {
  it('accepts shares that total exactly 100', () => {
    expect(isValidDistribution(dist(60, 40, 0))).toBe(true);
    expect(isValidDistribution(dist(10, 40, 50))).toBe(true);
  });

  it('rejects negative shares and totals that are not 100', () => {
    expect(isValidDistribution(dist(-10, 60, 50))).toBe(false);
    expect(isValidDistribution(dist(50, 40, 0))).toBe(false);   // 90
    expect(isValidDistribution(dist(50, 40, 20))).toBe(false);  // 110
    expect(isValidDistribution(dist(Number.NaN, 0, 100))).toBe(false);
  });
});

describe('calculateDifficultyQuota — shipped preset defaults', () => {
  it('Junior: 15 questions @ 60/40/0 → 9 beginner, 6 intermediate, 0 advanced', () => {
    expect(calculateDifficultyQuota(15, dist(60, 40, 0)))
      .toEqual({ beginner: 9, intermediate: 6, advanced: 0 });
  });

  it('Mid-Level: 20 questions @ 20/60/20 → 4 / 12 / 4', () => {
    expect(calculateDifficultyQuota(20, dist(20, 60, 20)))
      .toEqual({ beginner: 4, intermediate: 12, advanced: 4 });
  });

  // Documented largest-remainder result: floors are 2/10/12 = 24, leaving one
  // question. Beginner and advanced tie on a .5 remainder, and the tie rule
  // awards the HIGHER difficulty.
  it('Senior: 25 questions @ 10/40/50 → 2 / 10 / 13 via the documented tie rule', () => {
    expect(calculateDifficultyQuota(25, dist(10, 40, 50)))
      .toEqual({ beginner: 2, intermediate: 10, advanced: 13 });
  });
});

describe('calculateDifficultyQuota — algorithm properties', () => {
  it('a 0% difficulty never receives a question', () => {
    for (const count of [1, 7, 15, 33, 100]) {
      expect(calculateDifficultyQuota(count, dist(60, 40, 0)).advanced).toBe(0);
      expect(calculateDifficultyQuota(count, dist(0, 100, 0))).toEqual({
        beginner: 0, intermediate: count, advanced: 0
      });
    }
  });

  it('quotas always total the requested count, across many shapes', () => {
    const shapes = [dist(60, 40, 0), dist(20, 60, 20), dist(10, 40, 50), dist(33, 33, 34), dist(1, 1, 98)];
    for (const shape of shapes) {
      for (let count = 0; count <= 60; count++) {
        expect(total(calculateDifficultyQuota(count, shape))).toBe(count);
      }
    }
  });

  it('resolves a three-way remainder tie by favouring higher difficulties', () => {
    // 1 question, 33.3/33.3/33.4 is not valid (must total 100), so use an exact
    // three-way split: 1 @ 1/3 each is impossible in whole percents, so use 2.
    // 2 @ 50/0/50 → floors 1/0/1, no leftover.
    expect(calculateDifficultyQuota(2, dist(50, 0, 50)))
      .toEqual({ beginner: 1, intermediate: 0, advanced: 1 });
    // 1 @ 50/0/50 → floors 0/0/0, one leftover, tie → advanced wins.
    expect(calculateDifficultyQuota(1, dist(50, 0, 50)))
      .toEqual({ beginner: 0, intermediate: 0, advanced: 1 });
    // 1 @ 50/50/0 → tie between beginner and intermediate → intermediate wins.
    expect(calculateDifficultyQuota(1, dist(50, 50, 0)))
      .toEqual({ beginner: 0, intermediate: 1, advanced: 0 });
  });

  it('is deterministic — repeated calls agree', () => {
    const a = calculateDifficultyQuota(25, dist(10, 40, 50));
    const b = calculateDifficultyQuota(25, dist(10, 40, 50));
    expect(a).toEqual(b);
  });

  it('rejects invalid input rather than silently guessing', () => {
    expect(() => calculateDifficultyQuota(-1, dist(60, 40, 0))).toThrow();
    expect(() => calculateDifficultyQuota(1.5, dist(60, 40, 0))).toThrow();
    expect(() => calculateDifficultyQuota(10, dist(50, 40, 0))).toThrow();
  });

  it('every shipped preset resolves to its own questionCount', () => {
    for (const preset of INTERVIEW_PRESETS) {
      const quota = calculateDifficultyQuota(preset.questionCount, preset.difficultyDistribution);
      expect(total(quota)).toBe(preset.questionCount);
    }
  });
});
