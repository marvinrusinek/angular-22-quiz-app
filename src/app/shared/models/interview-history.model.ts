/**
 * Interview Mode performance history — the durable, versioned analytics data
 * behind the Performance Trends chart. Compact by design: each attempt stores
 * per-attempt SCORES and per-topic tallies, plus an OPTIONAL per-question review
 * snapshot (added so the History detail page can reopen the read-only Review
 * Answers list). Kept fully separate from topic-quiz progress / best-score /
 * achievement stores (its own SK_INTERVIEW_HISTORY key).
 */
import { QuestionType } from './question-type.enum';

/** Retention window: only the latest N completed attempts are kept. */
export const INTERVIEW_HISTORY_MAX = 20;

/**
 * Storage schema version.
 *
 * v2 is the SANITIZED format. The interview answer key now lives on the
 * backend, so a durable local copy of every question, option, correctness flag
 * and explanation is exactly what this migration removes from the browser.
 * v2 keeps the analytics fields every consumer already reads — the names are
 * unchanged so Trends, Readiness, Topic Trends, Achievements, Weak Areas and
 * the certificate keep working — and drops `review` entirely.
 */
export const INTERVIEW_HISTORY_VERSION = 2 as const;

/** The v1 value, retained only so the migration can recognise old stores. */
export const INTERVIEW_HISTORY_VERSION_V1 = 1 as const;

/** How a completed interview reached its final state. */
export type InterviewCompletionReason = 'submitted' | 'time-expired';

/** Per-topic tally within a retained attempt (mirrors the Topic Performance
 *  analytics output, minus the derived colour band). */
export interface InterviewTopicHistoryEntry {
  topicId: string;
  /** FROZEN backend title — never re-resolved from the local quiz bank. */
  topicName: string;
  correct: number;
  total: number;
  percentage: number; // 0–100
  // v2 additions. Optional so migrated v1 topics stay valid.
  incorrect?: number;
  unanswered?: number;
}

/**
 * V1 ONLY — the answer-bearing review snapshot that v2 removes.
 *
 * Retained purely as the migration's INPUT type so v1 stores can be parsed and
 * discarded safely. Nothing writes these shapes any more; the current-session
 * review comes from the backend result instead.
 */
export interface InterviewReviewOptionSnapshot {
  optionId: number;
  text: string;
  correct: boolean;
}

/** V1 ONLY. See {@link InterviewReviewOptionSnapshot}. Migration input only. */
export interface InterviewReviewQuestionSnapshot {
  questionText: string;
  explanation: string;
  type?: QuestionType; // preserved when known; else inferred at render
  sourceQuizId?: string; // topic attribution (maps to topicPerformance id)
  options: InterviewReviewOptionSnapshot[];
  selectedOptionIds: number[]; // the user's picks (may be empty)
}

/**
 * One completed Interview Mode attempt — SANITIZED (v2).
 *
 * Summary + analytics only. There is deliberately no `review`, no question or
 * option text, no correctness and no explanation: that material is served by
 * the backend from the frozen result and is never written to localStorage.
 */
export interface InterviewAttemptHistoryEntry {
  id: string; // stable, unique per attempt
  /**
   * Backend session id — the DEDUPLICATION key.
   *
   * Result loading is idempotent (navigate, refresh, remount, re-fetch all
   * produce the same result), so history must key off something server-stable.
   * Score + date would collide for a repeated load of one attempt AND for two
   * genuinely different attempts with the same score in the same second.
   * Absent on migrated v1 records, which fall back to `id`.
   */
  sessionId?: string;
  // Monotonic lifetime attempt number (1-based), persisted so it stays stable as
  // older attempts age out of the retention window — i.e. NOT the position in the
  // retained list. Optional for backward compatibility; legacy records without it
  // are assigned numbers by chronological position on first load.
  attemptNumber?: number;
  completedAt: string; // ISO 8601 timestamp
  score: number; // correct count
  totalQuestions: number;
  percentage: number; // 0–100 (normalised so counts stay comparable)
  completionReason: InterviewCompletionReason;
  durationSeconds?: number;
  configuredDifficulty?: string;
  // 'preset' when the attempt came from a role preset; absent/'custom' otherwise.
  // LEGACY entries have neither field and are treated as Custom Interview.
  configKind?: 'custom' | 'preset';
  presetId?: string;
  presetName?: string; // snapshot of the label at completion time
  selectedTopicIds: string[];
  topicPerformance: InterviewTopicHistoryEntry[];

  // ── backend-derived summary (v2) ──────────────────────────────────
  // Optional so migrated v1 records stay valid; consumers treat absence as
  // "not recorded" rather than substituting a made-up number.
  answered?: number;
  unanswered?: number;
  incorrect?: number;
  timeUsedSeconds?: number;
  submittedByExpiry?: boolean;

  /**
   * Client-observed focus changes. Never sent to or returned by the backend,
   * never part of the score — retained only as an aggregate count.
   */
  focusChanges?: number;
}

/** The persisted store shape. */
export interface InterviewAttemptHistoryStore {
  version: typeof INTERVIEW_HISTORY_VERSION;
  attempts: InterviewAttemptHistoryEntry[];
}

// ── Derived (UI) trend shapes ─────────────────────────────────────────

/** One plotted point on the score trend, chronological. */
export interface InterviewTrendPoint {
  id: string;
  index: number; // 1-based position within the retained window
  completedAt: string;
  score: number;
  totalQuestions: number;
  percentage: number;
  completionReason: InterviewCompletionReason;
  isLatest: boolean;
}

/** Direction of the latest change; drives the (theme-aware, non-colour-only)
 *  interpretation message. 'none' = not enough attempts to make any claim. */
export type InterviewTrendDirection = 'improving' | 'steady' | 'declining' | 'none';

/** Everything the Performance Trends UI needs — derived purely from the retained
 *  attempts, so the Results component stays presentation-only. */
export interface InterviewTrends {
  points: InterviewTrendPoint[]; // chronological (oldest → latest)
  count: number;
  latest: number | null; // latest attempt %
  best: number | null; // highest retained %
  average: number | null; // arithmetic mean of retained %, rounded
  change: number | null; // latest − previous, in percentage points (null if <2)
  direction: InterviewTrendDirection;
  interpretation: string; // canonical (English) message; '' when direction === 'none'
  isPersonalBest: boolean; // latest STRICTLY exceeds every previous attempt (needs ≥2, no ties)
}
