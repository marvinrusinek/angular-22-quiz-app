import { findInterviewPreset } from '@shared/models';
import type { InterviewCompletionReason, InterviewTopicHistoryEntry } from '@shared/models';
import type { InterviewResultViewModel } from '@shared/models/interview/interview-view-models';

/**
 * Backend result → SANITIZED history record.
 *
 * The single place the backend result is reduced to durable analytics. Mapping
 * lives here rather than in the Results component so there is exactly one
 * definition of what leaves memory and reaches localStorage, and so the
 * "no answer key on disk" rule can be tested in one place.
 *
 * Every score field is COPIED, never recomputed — the backend's numbers are
 * authoritative, and a second local calculation could disagree with the score
 * the user was shown.
 */

/** What the adapter produces. `id` and `attemptNumber` are assigned by the store. */
export interface SanitizedAttemptInput {
  readonly sessionId: string;
  readonly completedAt: string;
  readonly score: number;
  readonly totalQuestions: number;
  readonly percentage: number;
  readonly completionReason: InterviewCompletionReason;
  readonly answered: number;
  readonly unanswered: number;
  readonly incorrect: number;
  readonly durationSeconds: number;
  readonly timeUsedSeconds: number;
  readonly submittedByExpiry: boolean;
  readonly focusChanges: number;
  readonly configKind: 'custom' | 'preset';
  readonly presetId?: string;
  readonly presetName?: string;
  readonly configuredDifficulty?: string;
  readonly selectedTopicIds: string[];
  readonly topicPerformance: InterviewTopicHistoryEntry[];
}

/**
 * Difficulty / preset rule.
 *
 * A ROLE PRESET mixes difficulties by design, so there is no single difficulty
 * to record. Rather than inventing one — which would make Interview History
 * claim a "Beginner" attempt that also contained advanced questions — preset
 * attempts carry `configKind: 'preset'` plus the preset name, and
 * `configuredDifficulty` is left ABSENT. Custom attempts carry the difficulty
 * the user actually chose and no preset name. Consumers render difficulty
 * optionally; nothing substitutes a placeholder.
 */
function describeConfig(result: InterviewResultViewModel): {
  configKind: 'custom' | 'preset';
  presetId?: string;
  presetName?: string;
  configuredDifficulty?: string;
} {
  const config = result.config;

  if (config.mode === 'preset' && config.presetId) {
    return {
      configKind: 'preset',
      presetId: config.presetId,
      // Label snapshot: the preset definition may be renamed later, and a past
      // attempt should keep the name it was taken under.
      presetName: findInterviewPreset(config.presetId)?.name ?? config.presetId,
      configuredDifficulty: undefined
    };
  }

  return {
    configKind: 'custom',
    presetId: undefined,
    presetName: undefined,
    configuredDifficulty: config.difficulty
  };
}

/**
 * Per-topic tallies, using the FROZEN backend topic ids and titles.
 *
 * The title is whatever the server recorded at finalization; it is never
 * re-resolved from the local quiz bank, so a renamed or removed topic still
 * displays as it did when the interview was taken.
 */
function toTopicPerformance(
  result: InterviewResultViewModel
): InterviewTopicHistoryEntry[] {
  return result.byTopic.map((bucket) => ({
    topicId: bucket.topicId,
    topicName: bucket.title,
    correct: bucket.correct,
    total: bucket.total,
    percentage: bucket.percentage,
    incorrect: bucket.incorrect,
    unanswered: bucket.unanswered
  }));
}

/**
 * Map a submitted backend result onto a sanitized attempt.
 *
 * `focusChanges` is the ONE client-observed value here: the backend neither
 * receives nor returns it, it never affects the score, and only the aggregate
 * count is retained.
 */
export function toSanitizedAttempt(
  result: InterviewResultViewModel,
  focusChanges: number
): SanitizedAttemptInput {
  const config = describeConfig(result);

  return {
    sessionId: result.sessionId,
    completedAt: new Date(result.submittedAtMs).toISOString(),

    // Backend values, copied verbatim.
    score: result.correct,             // backend `correct`  → score
    totalQuestions: result.total,      // backend `total`    → totalQuestions
    percentage: result.percentage,     // NEVER recalculated
    answered: result.answered,
    unanswered: result.unanswered,
    incorrect: result.incorrect,
    durationSeconds: result.durationSeconds,
    timeUsedSeconds: result.timeUsedSeconds,
    submittedByExpiry: result.submittedByExpiry,
    // backend `submittedByExpiry` → completionReason
    completionReason: result.submittedByExpiry ? 'time-expired' : 'submitted',

    focusChanges: Math.max(0, Math.floor(focusChanges)),

    ...config,
    selectedTopicIds: [...result.config.topicIds],
    topicPerformance: toTopicPerformance(result)
  };
}
