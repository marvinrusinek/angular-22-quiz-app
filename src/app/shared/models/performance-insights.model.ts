import type { WeakTopic } from '../utils/weak-areas';

/**
 * Performance Insights view models — DERIVED, read-only, never persisted.
 *
 * Every number here is computed from raw correct/total counts held by the
 * existing history stores. Nothing in this file is stored, and nothing in it
 * carries question text, options or answer data.
 *
 * THREE SOURCES, NEVER MERGED into one headline figure. They measure different
 * things:
 *   - Topic Quiz            immediate feedback, retries allowed, final/eventual
 *                           correctness, a timeout earns no credit.
 *   - Interview             no feedback until submit, answers changeable before
 *                           submit, exact-set scoring once, unanswered counts wrong.
 *   - Weak Areas Practice   like a Topic Quiz, but deliberately SAMPLED from the
 *                           user's weakest topics, so it is selection-biased.
 */
export type InsightSource = 'topic-quiz' | 'interview' | 'weak-areas-practice';

/** One LOGICAL attempt: everything the user did in a single sitting. */
export interface AttemptTally {
  readonly id: string;
  /** ISO 8601. */
  readonly completedAt: string;
  readonly correct: number;
  readonly total: number;
}

/** Question-weighted accuracy over a run of attempts. */
export interface PerformanceWindow {
  readonly attempts: number;
  readonly correct: number;
  readonly total: number;
  /** round(correct / total * 100). Whole percent, matching the rest of the app. */
  readonly accuracyPct: number;
}

/**
 * Recent vs previous, as plain arithmetic. `deltaPts` is the difference of the
 * two DISPLAYED whole percentages, so the numbers on screen always add up.
 */
export interface PerformanceComparison {
  readonly recent: PerformanceWindow;
  readonly previous: PerformanceWindow;
  /** recent.accuracyPct - previous.accuracyPct. May be 0, which is a real result. */
  readonly deltaPts: number;
}

export interface SourceSummary {
  readonly source: InsightSource;
  /** Logical attempts retained — a five-topic attempt counts once. */
  readonly attempts: number;
  readonly correct: number;
  readonly total: number;
  readonly accuracyPct: number;
  /** ISO timestamp of the newest attempt. */
  readonly latestAt: string;
  /** Null until there is enough history for a fair comparison. */
  readonly comparison: PerformanceComparison | null;
  /** How much history this source keeps, e.g. "200 most recent topic results". */
  readonly retentionLabel: string;
}

export interface TopicPerformanceInsight {
  readonly topicId: string;
  readonly topicName: string;
  readonly correct: number;
  readonly total: number;
  readonly percentage: number;
  /** ISO timestamp of the newest attempt that included this topic. */
  readonly lastActivityAt: string;
  /** False below the Weak Areas minimum sample: shown with counts, not rated. */
  readonly hasEnoughData: boolean;
}

export interface PerformanceInsights {
  readonly hasData: boolean;
  readonly topicQuiz: SourceSummary | null;
  readonly interview: SourceSummary | null;
  readonly practice: SourceSummary | null;
  /** Every topic with any recorded answers, most-evidence first. */
  readonly topics: readonly TopicPerformanceInsight[];
  /** Judgeable topics that are NOT weak, best first. Disjoint from `needsReview`. */
  readonly strongest: readonly TopicPerformanceInsight[];
  /** Passed through UNCHANGED from WeakAreasService. */
  readonly needsReview: readonly WeakTopic[];
}
