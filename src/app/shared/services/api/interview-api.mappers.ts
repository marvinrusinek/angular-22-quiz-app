import type {
  ActiveInterviewQuestionDto,
  ActiveInterviewSessionDto,
  InterviewResultDto,
  InterviewReviewQuestionDto,
  InterviewSessionConfigDto
} from '../../models/api/interview-api.dto';
import type {
  InterviewQuestionViewModel,
  InterviewResultViewModel,
  InterviewReviewQuestionViewModel,
  InterviewSessionConfigViewModel,
  InterviewSessionViewModel,
  InterviewTopicPerformanceViewModel
} from '../../models/interview/interview-view-models';

/**
 * DTO → view model.
 *
 * Field-by-field literals, never a spread: a field the backend adds later must
 * not reach the UI by accident. Nothing here reads the local quiz bank —
 * question text, option text, order and (post-submission) topic titles all come
 * from the response, which is what makes a completed result immune to quiz.json
 * changes.
 *
 * Order is PRESERVED exactly as delivered. Angular never reshuffles.
 */

function toConfig(config: InterviewSessionConfigDto): InterviewSessionConfigViewModel {
  return {
    mode: config.mode,
    ...(config.presetId ? { presetId: config.presetId } : {}),
    ...(config.difficulty ? { difficulty: config.difficulty } : {}),
    topicIds: [...config.topicIds],
    questionCount: config.questionCount
  };
}

export function toQuestionViewModel(
  question: ActiveInterviewQuestionDto
): InterviewQuestionViewModel {
  return {
    questionId: question.questionId,
    sourceQuizId: question.sourceQuizId,
    questionText: question.questionText,
    type: question.type,
    options: question.options.map((option) => ({
      optionId: option.optionId,
      text: option.text
    })),
    ...(question.codeSnippet ? { codeSnippet: { ...question.codeSnippet } } : {})
  };
}

export function toSessionViewModel(dto: ActiveInterviewSessionDto): InterviewSessionViewModel {
  return {
    sessionId: dto.sessionId,
    status: 'active',
    createdAtMs: Date.parse(dto.createdAt),
    expiresAtMs: Date.parse(dto.expiresAt),
    durationSeconds: dto.durationSeconds,
    remainingSeconds: dto.remainingSeconds,
    config: toConfig(dto.config),
    questions: dto.questions.map(toQuestionViewModel),
    answers: new Map(dto.answers.map((answer) => [answer.questionId, [...answer.selectedOptionIds]])),
    // Only TRUE entries — an absent key reads as "not flagged", matching how
    // `answers` omits unanswered questions rather than storing an empty array.
    flags: new Map(
      dto.questions.filter((question) => question.flagged).map((question) => [question.questionId, true])
    )
  };
}

function sameSet(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(b);
  return a.every((value) => set.has(value));
}

export function toReviewQuestionViewModel(
  question: InterviewReviewQuestionDto
): InterviewReviewQuestionViewModel {
  const selectedOptionIds = [...question.selectedOptionIds];
  const correctOptionIds = [...question.correctOptionIds];

  return {
    questionId: question.questionId,
    sourceQuizId: question.sourceQuizId,
    questionText: question.questionText,
    type: question.type,
    options: question.options.map((option) => ({ optionId: option.optionId, text: option.text })),
    selectedOptionIds,
    correctOptionIds,
    explanation: question.explanation,
    // Derived from the two ID lists using the SAME exact-set rule the backend
    // scored with — never a separate interpretation of correctness.
    isCorrect: selectedOptionIds.length > 0 && sameSet(selectedOptionIds, correctOptionIds),
    isAnswered: selectedOptionIds.length > 0,
    flagged: question.flagged,
    ...(question.codeSnippet ? { codeSnippet: { ...question.codeSnippet } } : {})
  };
}

export function toResultViewModel(dto: InterviewResultDto): InterviewResultViewModel {
  const byTopic: InterviewTopicPerformanceViewModel[] = dto.performance.byTopic.map((bucket) => ({
    topicId: bucket.topicId,
    // Frozen backend title — deliberately NOT re-resolved via getQuizData().
    title: bucket.title,
    correct: bucket.correct,
    incorrect: bucket.incorrect,
    unanswered: bucket.unanswered,
    total: bucket.total,
    percentage: bucket.percentage
  }));

  return {
    sessionId: dto.sessionId,
    submittedAtMs: Date.parse(dto.submittedAt),
    submittedByExpiry: dto.submittedByExpiry,
    total: dto.total,
    answered: dto.answered,
    unanswered: dto.unanswered,
    correct: dto.correct,
    incorrect: dto.incorrect,
    // Copied, never recalculated — the server's number is authoritative.
    percentage: dto.percentage,
    durationSeconds: dto.durationSeconds,
    timeUsedSeconds: dto.timeUsedSeconds,
    config: toConfig(dto.config),
    byTopic,
    review: dto.review.map(toReviewQuestionViewModel)
  };
}
