import { QuizDifficulty } from '@shared/models/Quiz.model';

/**
 * Pure difficulty-quota maths for Role-Based Interview Presets.
 *
 * Kept free of Angular and of the question bank so the allocation is trivially
 * testable and so the UI and the builder service can never disagree — both read
 * the SAME function rather than each doing their own rounding.
 */

/** Percentage split across the three real per-quiz difficulties. Must total 100. */
export interface DifficultyDistribution {
  beginner: number;
  intermediate: number;
  advanced: number;
}

/** Resolved question counts per difficulty. Always sums to the requested total. */
export type DifficultyQuota = Record<QuizDifficulty, number>;

/**
 * Ordered least → most difficult. Drives two documented rules:
 *  - tie-breaking in the largest-remainder step (higher difficulty wins), and
 *  - "closest allowed difficulty first" when redistributing a shortfall.
 */
export const DIFFICULTY_ORDER: readonly QuizDifficulty[] = [
  'beginner',
  'intermediate',
  'advanced'
] as const;

/** True when every share is a nonnegative number and the three total exactly 100. */
export function isValidDistribution(distribution: DifficultyDistribution): boolean {
  const values = [distribution.beginner, distribution.intermediate, distribution.advanced];
  if (values.some((v) => !Number.isFinite(v) || v < 0)) return false;
  // Percentages are authored as whole numbers, so an exact comparison is safe
  // and avoids masking a genuinely malformed preset behind an epsilon.
  return values.reduce((sum, v) => sum + v, 0) === 100;
}

/**
 * Split `questionCount` across the difficulties using the LARGEST-REMAINDER
 * method:
 *   1. exact share  = total × percentage / 100
 *   2. base         = floor(exact share)
 *   3. the leftover (total − Σ base) is handed out one at a time to the largest
 *      fractional remainders.
 *
 * TIE RULE (deterministic, applies to every preset): when two remainders are
 * equal the HIGHER difficulty wins — advanced, then intermediate, then beginner.
 * This satisfies the "favour the higher difficulty" requirement for Mid-Level and
 * Senior, and because it is applied uniformly there is no per-preset special
 * casing to drift out of sync.
 *
 * A difficulty weighted 0% can never receive a question: its exact share is 0,
 * so both its base and its remainder are 0, and remainders of 0 are never
 * awarded (the leftover loop only ever distributes what the floors gave up).
 *
 * Worked results for the shipped presets:
 *   Junior    15 @ 60/40/0  → 9 / 6 / 0     (exact, no remainder step)
 *   Mid-Level 20 @ 20/60/20 → 4 / 12 / 4    (exact, no remainder step)
 *   Senior    25 @ 10/40/50 → 2 / 10 / 13   (floors 2/10/12 = 24; the single
 *                                            leftover is a .5 tie between
 *                                            beginner and advanced → advanced)
 */
export function calculateDifficultyQuota(
  questionCount: number,
  distribution: DifficultyDistribution
): DifficultyQuota {
  if (!Number.isInteger(questionCount) || questionCount < 0) {
    throw new Error(`calculateDifficultyQuota: questionCount must be a non-negative integer, got ${questionCount}`);
  }
  if (!isValidDistribution(distribution)) {
    throw new Error('calculateDifficultyQuota: distribution values must be nonnegative and total 100');
  }

  const exact = DIFFICULTY_ORDER.map((difficulty) => ({
    difficulty,
    share: (questionCount * distribution[difficulty]) / 100
  }));

  const quota = { beginner: 0, intermediate: 0, advanced: 0 } as DifficultyQuota;
  for (const { difficulty, share } of exact) quota[difficulty] = Math.floor(share);

  let leftover = questionCount - DIFFICULTY_ORDER.reduce((sum, d) => sum + quota[d], 0);
  if (leftover <= 0) return quota;

  // Highest remainder first; ties broken by the HIGHER difficulty (descending
  // DIFFICULTY_ORDER index), which makes the ordering total and deterministic.
  const byRemainder = exact
    .map(({ difficulty, share }) => ({
      difficulty,
      remainder: share - Math.floor(share),
      rank: DIFFICULTY_ORDER.indexOf(difficulty)
    }))
    .filter((entry) => entry.remainder > 0)
    .sort((a, b) => (b.remainder - a.remainder) || (b.rank - a.rank));

  for (const entry of byRemainder) {
    if (leftover === 0) break;
    quota[entry.difficulty] += 1;
    leftover -= 1;
  }

  return quota;
}
