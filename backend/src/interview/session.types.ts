import type { QuestionType } from '../quiz/quiz.types';

/**
 * Persistence types for Interview sessions — BACKEND PRIVATE.
 *
 * `tokenHash` and `isCorrect` live here. Neither may ever reach a DTO mapper;
 * the response policy bans both names as a second line of defence.
 *
 * TIMESTAMPS ARE UNIX EPOCH MILLISECONDS everywhere in persistence. ISO strings
 * are an API-layer concern and are never stored, so no column mixes the two.
 */

export type SessionStatus = 'active' | 'submitted' | 'expired';

/** Mirrors the Angular AssessmentConfig; validated on every read. */
export interface InterviewSessionConfig {
  readonly difficulty: string;
  readonly topicIds: readonly string[];
  readonly questionCount: number;
  readonly presetId?: string;
  readonly presetName?: string;
}

export interface InterviewSessionRecord {
  readonly id: string;
  /** SHA-256 of the bearer token. Never returned to a client. */
  readonly tokenHash: string;
  readonly status: SessionStatus;
  readonly config: InterviewSessionConfig;
  readonly durationSeconds: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly submittedAt: number | null;
  readonly submittedByExpiry: boolean;
  /** Frozen result, set at submission (Stage 8). Null while active. */
  readonly result: unknown | null;
  readonly attemptId: string;
}

/** A frozen option snapshot. Independent of the quiz bank after creation. */
export interface SessionOptionSnapshot {
  readonly optionId: number;
  readonly text: string;
  readonly displayOrder: number;
  /** ANSWER KEY. Never mapped into an active-session DTO. */
  readonly isCorrect: boolean;
}

/** A frozen question snapshot, in its session-specific position. */
export interface SessionQuestionSnapshot {
  readonly position: number;
  readonly questionId: string;
  readonly sourceQuizId: string;
  readonly questionText: string;
  readonly type: QuestionType;
  /** ANSWER KEY material — withheld until the policy allows it. */
  readonly explanation: string;
  readonly options: readonly SessionOptionSnapshot[];
  /** Mark for Review — the user's own note, never correctness. */
  readonly flagged: boolean;
}

export interface InterviewSessionSnapshot {
  readonly session: InterviewSessionRecord;
  readonly questions: readonly SessionQuestionSnapshot[];
}

/** A saved answer. Validated on read, never trusted from storage. */
export interface SessionAnswerRecord {
  readonly position: number;
  readonly selectedOptionIds: readonly number[];
  readonly updatedAt: number;
}

// ── creation input ──────────────────────────────────────────────────

export interface CreateSessionOptionInput {
  readonly optionId: number;
  readonly text: string;
  readonly displayOrder: number;
  readonly isCorrect: boolean;
}

export interface CreateSessionQuestionInput {
  readonly position: number;
  readonly questionId: string;
  readonly sourceQuizId: string;
  readonly questionText: string;
  readonly type: QuestionType;
  readonly explanation: string;
  readonly options: readonly CreateSessionOptionInput[];
}

export interface CreateSessionInput {
  readonly id: string;
  readonly tokenHash: string;
  readonly attemptId: string;
  readonly config: InterviewSessionConfig;
  readonly durationSeconds: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly questions: readonly CreateSessionQuestionInput[];
}
