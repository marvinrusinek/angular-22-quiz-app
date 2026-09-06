import type { InterviewQuestionTypeDto } from '../api/interview-api.dto';

/**
 * SAFE view models for an ACTIVE Interview.
 *
 * These are what the Interview UI binds to. They are deliberately NOT the
 * topic-quiz `QuizQuestion`/`Option` models: those carry `correct`, and forcing
 * API data into them would either require an answer-key field the backend never
 * sends, or a fake `correct: false` that misrepresents every option.
 *
 * There is NO correctness here, in any form. Multi-select is decided by `type`,
 * never by counting correct options.
 */

export type InterviewQuestionType = InterviewQuestionTypeDto;

export interface InterviewOptionViewModel {
  readonly optionId: number;
  readonly text: string;
}

export interface InterviewQuestionViewModel {
  readonly questionId: string;
  readonly sourceQuizId: string;
  readonly questionText: string;
  readonly type: InterviewQuestionType;
  readonly options: readonly InterviewOptionViewModel[];
}

/** True when a question accepts more than one selection. */
export function isMultiSelectQuestion(question: {
  readonly type: InterviewQuestionType;
}): boolean {
  // `trueFalse` is single-selection, exactly like `single`.
  return question.type === 'multiple';
}

export interface InterviewSessionConfigViewModel {
  readonly mode: 'preset' | 'custom';
  readonly presetId?: string;
  readonly difficulty?: string;
  readonly topicIds: readonly string[];
  readonly questionCount: number;
}

/**
 * The active session as the UI sees it.
 *
 * `expiresAtMs` is absolute and server-derived; `remainingSeconds` is the
 * server's own count at the moment the response was produced. The session
 * service reconciles the two against local receipt time so a slow request
 * cannot grant extra time.
 */
export interface InterviewSessionViewModel {
  readonly sessionId: string;
  readonly status: 'active';
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly durationSeconds: number;
  readonly remainingSeconds: number;
  readonly config: InterviewSessionConfigViewModel;
  readonly questions: readonly InterviewQuestionViewModel[];
  /** questionId → the selections the SERVER currently holds. */
  readonly answers: ReadonlyMap<string, readonly number[]>;
  /** questionId → true for every question the SERVER currently holds flagged. */
  readonly flags: ReadonlyMap<string, boolean>;
}

// ── submitted result ────────────────────────────────────────────────

export interface InterviewReviewQuestionViewModel {
  readonly questionId: string;
  readonly sourceQuizId: string;
  readonly questionText: string;
  readonly type: InterviewQuestionType;
  readonly options: readonly InterviewOptionViewModel[];
  readonly selectedOptionIds: readonly number[];
  readonly correctOptionIds: readonly number[];
  readonly explanation: string;
  /** Derived here so each review row does not recompute it while rendering. */
  readonly isCorrect: boolean;
  readonly isAnswered: boolean;
  /** The user's own Mark-for-Review note, frozen at submission. */
  readonly flagged: boolean;
}

export interface InterviewTopicPerformanceViewModel {
  readonly topicId: string;
  readonly title: string;
  readonly correct: number;
  readonly incorrect: number;
  readonly unanswered: number;
  readonly total: number;
  readonly percentage: number;
}

export interface InterviewResultViewModel {
  readonly sessionId: string;
  readonly submittedAtMs: number;
  readonly submittedByExpiry: boolean;
  readonly total: number;
  readonly answered: number;
  readonly unanswered: number;
  readonly correct: number;
  readonly incorrect: number;
  readonly percentage: number;
  readonly durationSeconds: number;
  readonly timeUsedSeconds: number;
  readonly config: InterviewSessionConfigViewModel;
  readonly byTopic: readonly InterviewTopicPerformanceViewModel[];
  readonly review: readonly InterviewReviewQuestionViewModel[];
}
