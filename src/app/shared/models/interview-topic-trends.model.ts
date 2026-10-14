/**
 * Topic Trends — how the user's performance in INDIVIDUAL Angular topics changes
 * across completed Interview Mode attempts. Complements overall Performance
 * Trends ("am I improving?") by answering "where am I improving?". Derived purely
 * from retained Interview History topic-performance; never persisted separately.
 */

/** Directional trend from a topic's latest two appearances. */
export type TopicTrendDirection = 'improving' | 'declining' | 'steady' | 'insufficient';

/** Current strength band (internal 'weak' → user-facing "Needs Review"). */
export type TopicStrengthBand = 'strong' | 'moderate' | 'weak';

/** One chronological appearance of a topic within retained history. */
export interface TopicTrendPoint {
  attemptId: string; // maps to /interview/history/:id
  attemptNumber: number; // lifetime attempt number (for "View Interview #N")
  completedAt: string;
  correct: number;
  total: number;
  percentage: number; // 0–100 (as retained)
}

export interface TopicTrend {
  topicId: string;
  topicName: string;
  points: TopicTrendPoint[]; // chronological (oldest → latest)
  appearances: number;
  totalQuestions: number; // summed across appearances (sample size)
  latestPercentage: number;
  previousPercentage: number | null; // second-latest appearance (null if only one)
  aggregatePercentage: number; // raw aggregate: totalCorrect/totalQuestions across appearances
  change: number | null; // latest − previous (percentage points), null if <2
  direction: TopicTrendDirection;
  strengthBand: TopicStrengthBand; // from the aggregate percentage
  isPriority: boolean;
  explanation: string; // short, factual
}

export interface InterviewTopicTrendsResult {
  topics: TopicTrend[]; // already sorted by usefulness
  trackedCount: number;
  improvingCount: number;
  steadyCount: number;
  needsAttentionCount: number; // declining OR aggregate < 60
  insufficientCount: number;
}

/** Client-side filter ids for the Topic Trends section. */
export type TopicTrendFilter = 'all' | 'improving' | 'steady' | 'needs-attention' | 'insufficient';
