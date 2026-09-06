import type { InterviewSessionRecord, SessionQuestionSnapshot } from './session.types';
import type { CodeSnippet, QuestionType } from '../quiz/quiz.types';
import type { FrozenInterviewResult } from './result.types';

/**
 * A read-only code snippet shown alongside a question's text. Question
 * CONTENT, never answer-key material — safe under both ACTIVE_ASSESSMENT and
 * SUBMITTED_REVIEW, which already permit `questionText`.
 */
export interface CodeSnippetDto {
  readonly language: 'typescript' | 'html' | 'css' | 'json';
  readonly code: string;
  readonly filename?: string;
}

function toCodeSnippetDto(snippet: CodeSnippet): CodeSnippetDto {
  return {
    language: snippet.language,
    code: snippet.code,
    ...(snippet.filename ? { filename: snippet.filename } : {})
  };
}

/**
 * ACTIVE-session DTOs.
 *
 * Built as explicit literals from the frozen snapshot. `isCorrect`,
 * `explanation`, `tokenHash`, `attemptId` and `result` are simply never named
 * here, so they cannot leak even if the snapshot grows new fields.
 */

export interface ActiveInterviewOptionDto {
  readonly optionId: number;
  readonly text: string;
}

export interface ActiveInterviewQuestionDto {
  readonly questionId: string;
  readonly sourceQuizId: string;
  readonly questionText: string;
  readonly type: QuestionType;
  readonly options: readonly ActiveInterviewOptionDto[];
  /** The user's own Mark-for-Review note. Never correctness. */
  readonly flagged: boolean;
  /** Absent on every question that predates this feature. */
  readonly codeSnippet?: CodeSnippetDto;
}

export interface ActiveInterviewAnswerDto {
  readonly questionId: string;
  readonly selectedOptionIds: readonly number[];
}

export interface ActiveInterviewConfigDto {
  readonly mode: 'preset' | 'custom';
  readonly presetId?: string;
  readonly difficulty?: string;
  readonly topicIds: readonly string[];
  readonly questionCount: number;
}

export interface ActiveInterviewSessionDto {
  readonly sessionId: string;
  /** Present ONLY in the creation response. Never on resume. */
  readonly sessionToken?: string;
  readonly status: 'active';
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly durationSeconds: number;
  readonly remainingSeconds: number;
  readonly config: ActiveInterviewConfigDto;
  readonly questions: readonly ActiveInterviewQuestionDto[];
  readonly answers: readonly ActiveInterviewAnswerDto[];
}

function toIso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

// ── SUBMITTED result ────────────────────────────────────────────────

export interface InterviewReviewOptionDto {
  readonly optionId: number;
  readonly text: string;
}

export interface InterviewReviewQuestionDto {
  readonly questionId: string;
  readonly sourceQuizId: string;
  readonly questionText: string;
  readonly type: QuestionType;
  readonly options: readonly InterviewReviewOptionDto[];
  readonly selectedOptionIds: readonly number[];
  readonly correctOptionIds: readonly number[];
  readonly explanation: string;
  /** The user's own Mark-for-Review note, frozen at submission. */
  readonly flagged: boolean;
  /** Absent on every question that predates this feature. */
  readonly codeSnippet?: CodeSnippetDto;
}

export interface InterviewPerformanceBucketDto {
  readonly topicId: string;
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
  readonly correct: number;
  readonly incorrect: number;
  readonly percentage: number;
  readonly durationSeconds: number;
  readonly timeUsedSeconds: number;
  readonly timeRemainingSeconds: number;
  readonly config: ActiveInterviewConfigDto;
  readonly performance: { readonly byTopic: readonly InterviewPerformanceBucketDto[] };
  readonly review: readonly InterviewReviewQuestionDto[];
}

/**
 * Map the FROZEN result onto the wire shape.
 *
 * Field-by-field literals as everywhere else — the frozen result is already
 * safe, but nothing relies on that: `tokenHash`, `attemptId` and per-option
 * `isCorrect` are simply never named here.
 */
export function toInterviewResultDto(result: FrozenInterviewResult): InterviewResultDto {
  return {
    sessionId: result.sessionId,
    status: 'submitted',
    submittedAt: toIso(result.submittedAt),
    submittedByExpiry: result.submittedByExpiry,
    total: result.total,
    answered: result.answered,
    unanswered: result.unanswered,
    correct: result.correct,
    incorrect: result.incorrect,
    percentage: result.percentage,
    durationSeconds: result.durationSeconds,
    timeUsedSeconds: result.timeUsedSeconds,
    timeRemainingSeconds: result.timeRemainingSeconds,
    config: {
      mode: result.config.mode,
      ...(result.config.presetId ? { presetId: result.config.presetId } : {}),
      ...(result.config.difficulty ? { difficulty: result.config.difficulty } : {}),
      topicIds: [...result.config.topicIds],
      questionCount: result.config.questionCount
    },
    performance: {
      byTopic: result.performance.byTopic.map((bucket) => ({
        topicId: bucket.topicId,
        title: bucket.title,
        correct: bucket.correct,
        incorrect: bucket.incorrect,
        unanswered: bucket.unanswered,
        total: bucket.total,
        percentage: bucket.percentage
      }))
    },
    // Frozen order preserved for both questions and options.
    review: result.review.map((question) => ({
      questionId: question.questionId,
      sourceQuizId: question.sourceQuizId,
      questionText: question.questionText,
      type: question.type,
      options: question.options.map((option) => ({ optionId: option.optionId, text: option.text })),
      selectedOptionIds: [...question.selectedOptionIds],
      correctOptionIds: [...question.correctOptionIds],
      explanation: question.explanation,
      flagged: question.flagged,
      ...(question.codeSnippet ? { codeSnippet: toCodeSnippetDto(question.codeSnippet) } : {})
    }))
  };
}

export function toActiveQuestionDto(
  question: SessionQuestionSnapshot
): ActiveInterviewQuestionDto {
  return {
    questionId: question.questionId,
    sourceQuizId: question.sourceQuizId,
    questionText: question.questionText,
    type: question.type,
    // Stored display order IS the delivery order — never reshuffled on resume.
    options: [...question.options]
      .sort((a, b) => a.displayOrder - b.displayOrder)
      .map((option) => ({ optionId: option.optionId, text: option.text })),
    flagged: question.flagged,
    ...(question.codeSnippet ? { codeSnippet: toCodeSnippetDto(question.codeSnippet) } : {})
  };
}

export function toActiveSessionDto(params: {
  session: InterviewSessionRecord;
  questions: readonly SessionQuestionSnapshot[];
  answers: readonly ActiveInterviewAnswerDto[];
  now: number;
  /** Supplied only by the creation path. */
  sessionToken?: string;
}): ActiveInterviewSessionDto {
  const { session, questions, answers, now, sessionToken } = params;

  const config: ActiveInterviewConfigDto = {
    mode: session.config.presetId ? 'preset' : 'custom',
    ...(session.config.presetId ? { presetId: session.config.presetId } : {}),
    ...(session.config.presetId ? {} : { difficulty: session.config.difficulty }),
    topicIds: [...session.config.topicIds],
    questionCount: session.config.questionCount
  };

  return {
    sessionId: session.id,
    ...(sessionToken ? { sessionToken } : {}),
    status: 'active',
    createdAt: toIso(session.createdAt),
    expiresAt: toIso(session.expiresAt),
    durationSeconds: session.durationSeconds,
    // Server-calculated; the client clock is never consulted.
    remainingSeconds: Math.max(0, Math.ceil((session.expiresAt - now) / 1000)),
    config,
    questions: [...questions]
      .sort((a, b) => a.position - b.position)
      .map(toActiveQuestionDto),
    answers
  };
}
