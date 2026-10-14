/**
 * Interview Readiness — a coaching indicator (NOT a guarantee of interview
 * success) estimating how prepared the user appears based on recent Interview
 * Mode performance. Derived entirely from the retained Interview History; never
 * persisted as its own source of truth, so it always reflects new attempts,
 * retention, and cleared history automatically.
 */

/** Readiness band (0–100 → label). */
export type InterviewReadinessBand =
  | 'early-preparation' // 0–39
  | 'developing' // 40–59
  | 'progressing' // 60–74
  | 'strong' // 75–89
  | 'interview-ready'; // 90–100

/** The four weighted contributors. */
export type InterviewReadinessFactor =
  | 'recent-performance'
  | 'consistency'
  | 'topic-coverage'
  | 'topic-strength';

export interface InterviewReadiness {
  // 'insufficient' = exactly one completed interview (limited-data message, no
  // authoritative score). 'ready' = two or more (a calculated score).
  status: 'insufficient' | 'ready';

  score: number; // 0–100 (0 while insufficient)
  band: InterviewReadinessBand;

  // Factor scores, each on a 0–100 scale.
  recentPerformance: number;
  consistency: number; // performance-safeguarded (feeds the weighted score)
  // Raw score stability (range only, NOT performance-adjusted). Used purely for
  // wording — a consistently-low user is stable, not "varying" — while the
  // safeguarded `consistency` above is what the score uses.
  rawConsistency: number;
  topicCoverage: number;
  topicStrength: number;

  // Topic coverage can only be computed when the eligible topic list is known.
  // When it is not, coverage is excluded from the weighted score (weights
  // renormalised) and the practiced count is surfaced instead.
  coverageAvailable: boolean;
  practicedTopicCount: number;
  eligibleTopicCount: number;

  strongestFactor: InterviewReadinessFactor;
  limitingFactor: InterviewReadinessFactor;

  explanation: string; // strongest + limiting, factual
  recommendations: string[]; // at most two, priority-ordered

  attemptsUsed: number; // attempts feeding recent/consistency (≤ 5)
  totalAttempts: number; // total retained attempts
}
