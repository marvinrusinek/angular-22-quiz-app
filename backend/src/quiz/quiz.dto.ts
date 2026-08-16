import type { PrivateOption, PrivateQuestion, QuestionType, QuizMetadata } from './quiz.types';

/**
 * Public DTOs and their mappers.
 *
 * Every mapper builds a NEW object literal naming each field explicitly. There
 * is deliberately no spread of a private model and no `delete` of a field:
 * spreading means a field added to the private model later would silently
 * appear on the wire, which is precisely the failure mode this layer exists to
 * make impossible.
 *
 * There is also NO generic `mapQuestion(question, includeAnswers)`. Active and
 * review mapping are separate functions with separate return types, so a
 * boolean can never be passed wrongly and a call site's intent is visible.
 */

// ── quiz metadata ───────────────────────────────────────────────────

export interface QuizMetadataDto {
  readonly quizId: string;
  readonly milestone: string;
  readonly summary: string;
  readonly image: string;
  readonly difficulty: string | null;
  readonly questionCount: number;
}

export function toQuizMetadataDto(metadata: QuizMetadata): QuizMetadataDto {
  return {
    quizId: metadata.quizId,
    milestone: metadata.milestone,
    summary: metadata.summary,
    image: metadata.image,
    difficulty: metadata.difficulty,
    questionCount: metadata.questionCount
  };
}

export function toQuizMetadataListDto(
  metadata: readonly QuizMetadata[]
): readonly QuizMetadataDto[] {
  return metadata.map(toQuizMetadataDto);
}

// ── QUIZ RESOURCES (Results page links) ─────────────────────────────

/**
 * One outbound documentation link.
 *
 * The whole of the source shape, and the whole of what the panel renders. No
 * identifier is emitted: the client addresses nothing by it, and `url` is
 * already the key the template tracks the list by.
 */
export interface QuizResourceDto {
  readonly title: string;
  readonly url: string;
  readonly host: string;
}

export interface QuizResourcesBody {
  readonly quizId: string;
  readonly resources: readonly QuizResourceDto[];
}

/**
 * Built field by field, like every mapper here — a spread would carry through
 * any column later added to `quiz_resources`. There is nothing private on this
 * table today, and this keeps that true by construction rather than by review.
 */
export function toQuizResourcesDto(
  quizId: string,
  resources: readonly { title: string; url: string; host: string }[]
): QuizResourcesBody {
  return {
    quizId,
    resources: resources.map((resource) => ({
      title: resource.title,
      url: resource.url,
      host: resource.host
    }))
  };
}

// ── TOPIC QUIZ questions (pre-answer) ───────────────────────────────

/**
 * Topic Quiz delivery DTOs.
 *
 * The public contract carries NO identifiers. A question is addressed by its
 * exact text within a quiz, and an option by its exact text within that
 * question — a property proven unique at every normalization level across the
 * whole bank, and now enforced by UNIQUE constraints in PostgreSQL.
 *
 * Consequently these mappers name only the fields a client may see. In
 * particular they do NOT emit `questionId` or `optionId`, which the Interview
 * mappers above deliberately do keep: Interview Mode's contract is unchanged by
 * this work, and the two must not be conflated.
 *
 * TEXT IS THE CONTRACT. Every string here is the exact value stored in
 * PostgreSQL, byte for byte — no trimming, escaping or normalization. A client
 * echoes back the string it received, so any transformation here would break
 * the lookup on the way in.
 */

export interface TopicQuizOptionDto {
  readonly text: string;
}

export interface TopicQuizQuestionDto {
  readonly questionText: string;
  readonly type: QuestionType;
  /**
   * Difficulty is a QUIZ-level property, repeated on each question for the
   * client's convenience. Nullable to match `QuizMetadataDto.difficulty` and
   * the database, which permits a quiz without one; every quiz in the current
   * bank sets it.
   */
  readonly difficulty: string | null;
  /**
   * HOW MANY options are correct. Never WHICH.
   *
   * A deliberate, narrow disclosure. The UI has always shown a
   * "(N answers are correct)" banner before the user answers, so this count is
   * already public knowledge to anyone reading the screen — serving it is not
   * new information, it is the same information from an authoritative source
   * instead of from a bundled answer key.
   *
   * CARDINALITY IS NOT IDENTITY. Knowing three options are correct narrows
   * nothing about which three; the reveal still requires `/check`. This is the
   * same line `remainingCorrectCount` already draws on the check response.
   *
   * NOT a type signal. `type` is declared separately and authoritatively, and a
   * client must never infer single-vs-multiple from this number — that
   * inference is exactly what the type-authority work removed.
   */
  readonly correctCount: number;
  readonly options: readonly TopicQuizOptionDto[];
}

export interface TopicQuizQuestionsDto {
  readonly quizId: string;
  readonly questions: readonly TopicQuizQuestionDto[];
}

export function toTopicQuizOptionDto(option: PrivateOption): TopicQuizOptionDto {
  // ONLY the text. `optionId` and `isCorrect` are not referenced, so neither
  // can leak through a future change to PrivateOption.
  return { text: option.text };
}

export function toTopicQuizQuestionDto(
  question: PrivateQuestion,
  difficulty: string | null
): TopicQuizQuestionDto {
  return {
    questionText: question.questionText,
    type: question.type,
    difficulty,
    // Derived from the SAME authoritative options this mapper is about to
    // strip. Counting here rather than storing a column keeps the number
    // impossible to disagree with the relationship it summarizes — there is no
    // second place for it to drift.
    correctCount: question.options.filter((option) => option.isCorrect).length,
    // Source order preserved. Ordering is expressed ONLY by array position —
    // there is no displayOrder field on the wire.
    options: question.options.map(toTopicQuizOptionDto)
  };
}

export function toTopicQuizQuestionsDto(quiz: {
  readonly quizId: string;
  readonly difficulty: string | null;
  readonly questions: readonly PrivateQuestion[];
}): TopicQuizQuestionsDto {
  return {
    quizId: quiz.quizId,
    questions: quiz.questions.map((question) =>
      toTopicQuizQuestionDto(question, quiz.difficulty))
  };
}

// ── ACTIVE assessment ───────────────────────────────────────────────

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
}

/**
 * The ONLY mapper an active session may use.
 *
 * It cannot leak correctness because its literals never reference `isCorrect`
 * or `explanation` — not because a flag happened to be false.
 */
export function toActiveInterviewOptionDto(option: PrivateOption): ActiveInterviewOptionDto {
  return {
    optionId: option.optionId,
    text: option.text
  };
}

export function toActiveInterviewQuestionDto(
  question: PrivateQuestion
): ActiveInterviewQuestionDto {
  return {
    questionId: question.questionId,
    sourceQuizId: question.sourceQuizId,
    questionText: question.questionText,
    type: question.type,
    // Source order is preserved; a session's own shuffled order is applied by
    // the session layer, not here.
    options: question.options.map(toActiveInterviewOptionDto)
  };
}

// ── SUBMITTED review ────────────────────────────────────────────────

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
  /** Correctness as an explicit ID LIST — never a per-option boolean. */
  readonly correctOptionIds: readonly number[];
  readonly explanation: string;
}

/**
 * Post-submission review. Reachable ONLY from a submitted-session route.
 *
 * Correctness is expressed as `correctOptionIds` rather than per-option flags,
 * so the SUBMITTED_REVIEW policy can keep banning `correct`/`isCorrect` and a
 * raw private option can never be passed through by mistake.
 *
 * There is deliberately NO question-level `isCorrect` field: it would collide
 * with that ban, and the client can derive the outcome by comparing
 * `selectedOptionIds` with `correctOptionIds`. Aggregate scores live on the
 * result DTO (Stage 8), not here.
 */
export function toInterviewReviewQuestionDto(
  question: PrivateQuestion,
  selectedOptionIds: readonly number[]
): InterviewReviewQuestionDto {
  const correctOptionIds = question.options
    .filter((option) => option.isCorrect)
    .map((option) => option.optionId);

  return {
    questionId: question.questionId,
    sourceQuizId: question.sourceQuizId,
    questionText: question.questionText,
    type: question.type,
    options: question.options.map((option) => ({
      optionId: option.optionId,
      text: option.text
    })),
    selectedOptionIds: [...selectedOptionIds],
    correctOptionIds,
    explanation: question.explanation
  };
}
