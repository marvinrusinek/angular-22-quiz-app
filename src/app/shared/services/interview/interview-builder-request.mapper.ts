import type {
  CreateInterviewSessionRequest
} from '@shared/models/api/interview-api.dto';

/**
 * Builder state → backend create-session request.
 *
 * A dedicated mapper rather than an object literal inside the component, so
 * exactly what leaves the browser is visible in one place and testable without
 * rendering anything.
 *
 * The backend is authoritative for everything it can derive: duration, quotas,
 * topic selection for presets, question selection and ordering. Sending any of
 * those would either be ignored or rejected, so they are never constructed.
 */

export interface InterviewBuilderState {
  /** Non-null when a role preset is selected; the Custom controls are ignored. */
  readonly presetId: string | null;
  readonly difficulty: string | null;
  readonly topicIds: readonly string[];
  readonly questionCount: number | null;
}

export class InterviewBuilderRequestError extends Error {
  public override readonly name = 'InterviewBuilderRequestError';
}

const PRESET_ID_PATTERN = /^[a-z0-9-]{1,32}$/;

/**
 * Build the request. Throws for states the UI should already have blocked —
 * the throw is a guard against a future UI change silently sending a malformed
 * body, not a substitute for form validation.
 */
export function buildInterviewSessionRequest(
  state: InterviewBuilderState
): CreateInterviewSessionRequest {
  if (state.presetId !== null) {
    const presetId = state.presetId.trim();
    if (!PRESET_ID_PATTERN.test(presetId)) {
      throw new InterviewBuilderRequestError('invalid preset id');
    }
    // EXACTLY two fields. The preset owns topics, count, duration and quotas.
    return { mode: 'preset', presetId };
  }

  const difficulty = state.difficulty?.trim() ?? '';
  if (difficulty.length === 0) {
    throw new InterviewBuilderRequestError('difficulty is required');
  }

  const topicIds = state.topicIds.map((id) => id.trim()).filter((id) => id.length > 0);
  if (topicIds.length === 0) {
    throw new InterviewBuilderRequestError('at least one topic is required');
  }
  if (new Set(topicIds).size !== topicIds.length) {
    // The backend rejects duplicates outright; fail here with a clearer reason.
    throw new InterviewBuilderRequestError('duplicate topics');
  }

  const questionCount = state.questionCount;
  if (typeof questionCount !== 'number' || !Number.isInteger(questionCount)) {
    throw new InterviewBuilderRequestError('question count is required');
  }

  // EXACTLY four fields — no duration, no question or option ids, no ordering.
  return { mode: 'custom', difficulty, topicIds, questionCount };
}
