/**
 * WIRE SHAPES for the Interview API — exactly what the backend sends and
 * accepts, and nothing more.
 *
 * These types are deliberately separate from both the topic-quiz models and the
 * Angular view models. Nothing in the active-session DTOs carries correctness:
 * there is no `correct`, no `correctOptionIds` and no `explanation`, because
 * the backend never sends them before submission. Correctness appears ONLY in
 * the submitted-result shapes below.
 */

export type InterviewQuestionTypeDto = 'single' | 'multiple' | 'trueFalse';

// ── requests ────────────────────────────────────────────────────────

/** A preset owns its topics, count, duration and quotas — send only the id. */
export interface CreatePresetInterviewSessionRequest {
  readonly mode: 'preset';
  readonly presetId: string;
}

export interface CreateCustomInterviewSessionRequest {
  readonly mode: 'custom';
  readonly difficulty: string;
  readonly topicIds: readonly string[];
  readonly questionCount: number;
}

export type CreateInterviewSessionRequest =
  | CreatePresetInterviewSessionRequest
  | CreateCustomInterviewSessionRequest;

export interface SaveInterviewAnswerRequest {
  readonly selectedOptionIds: readonly number[];
}

// ── active session ──────────────────────────────────────────────────

export interface ActiveInterviewOptionDto {
  readonly optionId: number;
  readonly text: string;
}

export interface ActiveInterviewQuestionDto {
  readonly questionId: string;
  readonly sourceQuizId: string;
  readonly questionText: string;
  readonly type: InterviewQuestionTypeDto;
  readonly options: readonly ActiveInterviewOptionDto[];
}

export interface ActiveInterviewAnswerDto {
  readonly questionId: string;
  readonly selectedOptionIds: readonly number[];
}

export interface InterviewSessionConfigDto {
  readonly mode: 'preset' | 'custom';
  readonly presetId?: string;
  readonly difficulty?: string;
  readonly topicIds: readonly string[];
  readonly questionCount: number;
}

export interface ActiveInterviewSessionDto {
  readonly sessionId: string;
  /** Returned ONCE, by session creation. Absent on resume. */
  readonly sessionToken?: string;
  readonly status: 'active';
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly durationSeconds: number;
  readonly remainingSeconds: number;
  readonly config: InterviewSessionConfigDto;
  readonly questions: readonly ActiveInterviewQuestionDto[];
  readonly answers: readonly ActiveInterviewAnswerDto[];
}

export interface SaveInterviewAnswerResponse {
  readonly saved: true;
  readonly questionId: string;
  /** Canonical (ascending) — the authority over the local selection. */
  readonly selectedOptionIds: readonly number[];
  readonly answeredCount: number;
  readonly questionCount: number;
}

// ── submitted result ────────────────────────────────────────────────

export interface InterviewReviewOptionDto {
  readonly optionId: number;
  readonly text: string;
}

export interface InterviewReviewQuestionDto {
  readonly questionId: string;
  readonly sourceQuizId: string;
  readonly questionText: string;
  readonly type: InterviewQuestionTypeDto;
  readonly options: readonly InterviewReviewOptionDto[];
  readonly selectedOptionIds: readonly number[];
  /** Authorized only after submission. */
  readonly correctOptionIds: readonly number[];
  readonly explanation: string;
}

export interface InterviewPerformanceBucketDto {
  readonly topicId: string;
  /** Frozen at finalization — never re-resolved from the local quiz bank. */
  readonly title: string;
  readonly correct: number;
  readonly incorrect: number;
  readonly unanswered: number;
  readonly total: number;
  readonly percentage: number;
}

export interface InterviewResultDto {
  readonly sessionId: string;
  readonly status: 'submitted';
  readonly submittedAt: string;
  readonly submittedByExpiry: boolean;
  readonly total: number;
  readonly answered: number;
  readonly unanswered: number;
  /** AGGREGATE count of correct answers — not a per-option flag. */
  readonly correct: number;
  readonly incorrect: number;
  readonly percentage: number;
  readonly durationSeconds: number;
  readonly timeUsedSeconds: number;
  readonly timeRemainingSeconds: number;
  readonly config: InterviewSessionConfigDto;
  readonly performance: { readonly byTopic: readonly InterviewPerformanceBucketDto[] };
  readonly review: readonly InterviewReviewQuestionDto[];
}

/** The single error envelope every backend route returns. */
export interface ApiErrorBodyDto {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

// ── public quiz metadata ────────────────────────────────────────────

/**
 * One topic as the PUBLIC metadata endpoint describes it.
 *
 * Deliberately not a `Quiz`: there are no `questions`, no `options`, no
 * correctness and no explanations here. It is everything the Interview builder
 * needs to offer a topic and size an assessment, and nothing more.
 */
export interface QuizMetadataDto {
  readonly quizId: string;
  readonly milestone: string;
  readonly summary: string;
  readonly image: string;
  readonly difficulty: string;
  /**
   * PUBLIC trivia for the Results page, 0-3 per quiz.
   *
   * Optional on the client so a backend that predates the field still
   * deserializes — an older server simply yields no facts, which is the same
   * state the twelve quizzes without any are already in.
   */
  readonly facts?: readonly string[];
  readonly questionCount: number;
}

export interface QuizMetadataListDto {
  readonly quizzes: readonly QuizMetadataDto[];
}
