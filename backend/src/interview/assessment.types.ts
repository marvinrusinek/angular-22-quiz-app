import type { CodeSnippet, QuestionType } from '../quiz/quiz.types';

/**
 * Assessment-generation contracts — BACKEND PRIVATE.
 *
 * Generated snapshots carry `isCorrect` and `explanation`. They are input for
 * the session repository, never for an HTTP mapper.
 */

/** Angular's InterviewDifficulty: the three catalog values plus 'mixed'. */
export const INTERVIEW_DIFFICULTIES = ['beginner', 'intermediate', 'advanced', 'mixed'] as const;
export type InterviewDifficulty = (typeof INTERVIEW_DIFFICULTIES)[number];

/**
 * Question counts the Custom builder accepts, mirroring Angular's
 * `AssessmentQuestionCount` (10 | 20 | 30). Preset-only sizes (15, 25) are NOT
 * included — see the duration note in assessment.builder.ts.
 */
export const CUSTOM_QUESTION_COUNTS = [10, 20, 30] as const;
export type CustomQuestionCount = (typeof CUSTOM_QUESTION_COUNTS)[number];

/** question count → seconds. Mirrors Angular's DURATION_SECONDS_BY_COUNT. */
export const DURATION_SECONDS_BY_COUNT: Record<CustomQuestionCount, number> = {
  10: 15 * 60,
  20: 30 * 60,
  30: 45 * 60
};

/** Raw, untrusted input — whatever a caller hands over. */
export interface InterviewBuildRequest {
  readonly difficulty?: unknown;
  readonly topicIds?: unknown;
  readonly questionCount?: unknown;
}

/**
 * Validated + normalized. Only this shape reaches the builder.
 *
 * `questionCount` is a plain number rather than CustomQuestionCount because
 * presets legitimately use 15 and 25. The CUSTOM path still restricts itself to
 * 10/20/30 during validation; presets carry their own authoritative count.
 */
export interface InterviewBuildConfig {
  readonly difficulty: InterviewDifficulty;
  readonly topicIds: readonly string[];
  readonly questionCount: number;
  readonly durationSeconds: number;
  readonly presetId?: string;
  readonly presetName?: string;
}

// ── generated snapshot ──────────────────────────────────────────────

export interface GeneratedOptionSnapshot {
  /** Stable id from the private bank. Unchanged by display shuffling. */
  readonly optionId: number;
  readonly optionText: string;
  readonly displayOrder: number;
  /** ANSWER KEY — backend only. */
  readonly isCorrect: boolean;
}

export interface GeneratedQuestionSnapshot {
  readonly position: number;
  readonly questionId: string;
  readonly sourceQuizId: string;
  readonly questionText: string;
  readonly questionType: QuestionType;
  readonly explanation: string;
  readonly options: readonly GeneratedOptionSnapshot[];
  readonly codeSnippet?: CodeSnippet;
}

export interface GeneratedInterviewSnapshot {
  readonly config: InterviewBuildConfig;
  readonly durationSeconds: number;
  readonly questions: readonly GeneratedQuestionSnapshot[];
}

// ── errors ──────────────────────────────────────────────────────────

export type AssessmentErrorCode =
  | 'INVALID_CONFIG'
  | 'UNKNOWN_TOPIC'
  | 'TOPIC_DIFFICULTY_MISMATCH'
  | 'INSUFFICIENT_QUESTIONS'
  | 'INVALID_GENERATED_SNAPSHOT';

/**
 * Diagnostics may name a topic id, a difficulty, counts and a position. They
 * must never carry question text, option text, explanations or correctness.
 */
export class AssessmentBuildError extends Error {
  public override readonly name = 'AssessmentBuildError';
  public readonly code: AssessmentErrorCode;

  constructor(code: AssessmentErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
