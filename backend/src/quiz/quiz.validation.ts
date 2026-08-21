import { makeOptionId, makeQuestionId } from './quiz.ids';
import type {
  PrivateOption,
  PrivateQuestion,
  PrivateQuiz,
  QuestionType,
  QuizBankSource,
  QuizSource
} from './quiz.types';

/**
 * Source validation + normalization.
 *
 * Two hard rules:
 *   1. NOTHING is silently repaired. A malformed record is a hard failure, so
 *      bad data cannot quietly become a mis-scored question.
 *   2. Diagnostics locate a problem WITHOUT quoting content. They may name a
 *      quiz id and a position; they may never include option text, explanation
 *      text, correctness, or the source file path.
 */

export interface ValidationProblem {
  /** e.g. `rxjs`, `rxjs[q3]`, `rxjs[q3].options[2]` — location only. */
  readonly at: string;
  readonly message: string;
}

export class QuizDataError extends Error {
  public override readonly name = 'QuizDataError';
  public readonly problems: readonly ValidationProblem[];

  constructor(problems: readonly ValidationProblem[]) {
    super(
      `Quiz data is invalid (${problems.length} problem(s)): ` +
        problems.slice(0, 10).map((p) => `${p.at}: ${p.message}`).join('; ') +
        (problems.length > 10 ? ` … and ${problems.length - 10} more` : '')
    );
    this.problems = problems;
  }
}

/**
 * Question type derivation — the ONE place types are decided.
 *
 * Rules, matched to what the app does today:
 *
 *   multiple   more than one correct option
 *              (quizdata.service.ts:677 — `numCorrectAnswers > 1`)
 *
 *   trueFalse  exactly one correct option AND exactly two options whose texts
 *              are precisely "true" and "false" (case-insensitive, trimmed)
 *
 *   single     everything else
 *
 * `trueFalse` is a LABEL ONLY. Angular has never assigned QuestionType.TrueFalse
 * anywhere — the sole true/false detection in the app
 * (explanation-formatter.service.ts:742) exists purely to reword an explanation
 * prefix, and its comment states "the question stays single-answer". So a
 * trueFalse question is single-select and MUST behave identically to `single`;
 * it is surfaced separately only because the DTO contract asks for it and it is
 * derivable with certainty from this dataset (all 15 two-option questions have
 * exactly True/False texts). Nothing may branch on it behaviourally.
 */
export function deriveQuestionType(
  optionTexts: readonly string[],
  correctCount: number
): QuestionType {
  if (correctCount > 1) return 'multiple';

  if (optionTexts.length === 2) {
    const normalized = optionTexts.map((t) => t.trim().toLowerCase()).sort();
    if (normalized[0] === 'false' && normalized[1] === 'true') return 'trueFalse';
  }

  return 'single';
}

/**
 * Is this option flagged correct?
 *
 * The source marks correct options with `correct: true` and OMITS the key on
 * incorrect ones — there is no `correct: false` in the file. Absence is
 * therefore valid and means "incorrect". Any OTHER present value is malformed
 * and rejected rather than coerced, so a typo can never silently create or
 * destroy a correct answer.
 */
function readCorrectFlag(
  raw: unknown,
  at: string,
  problems: ValidationProblem[]
): boolean {
  if (raw === undefined) return false;
  if (raw === true) return true;
  if (raw === false) return false;
  problems.push({
    at,
    message: 'option "correct" must be true, false, or omitted'
  });
  return false;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface NormalizedBank {
  readonly quizzes: readonly PrivateQuiz[];
}

/**
 * Validate and normalize the whole bank. Throws QuizDataError listing every
 * problem found — callers do not get a partially usable bank.
 */
export function validateAndNormalize(raw: unknown): NormalizedBank {
  const problems: ValidationProblem[] = [];
  const rawQuizzes = extractQuizzes(raw, problems);
  if (problems.length > 0) throw new QuizDataError(problems);

  const quizzes: PrivateQuiz[] = [];
  const seenQuizIds = new Set<string>();
  const seenQuestionIds = new Set<string>();

  for (const [quizIndex, entry] of rawQuizzes.entries()) {
    const quiz = normalizeQuiz(entry, quizIndex, seenQuizIds, seenQuestionIds, problems);
    if (quiz) quizzes.push(quiz);
  }

  if (problems.length > 0) throw new QuizDataError(problems);
  return { quizzes };
}

function extractQuizzes(raw: unknown, problems: ValidationProblem[]): readonly unknown[] {
  if (raw === null || typeof raw !== 'object') {
    problems.push({ at: '<root>', message: 'quiz data must be an object or array' });
    return [];
  }

  const candidate = Array.isArray(raw) ? raw : (raw as QuizBankSource).quizzes;

  if (!Array.isArray(candidate)) {
    problems.push({ at: '<root>', message: 'expected an array of quizzes (or { quizzes: [...] })' });
    return [];
  }
  if (candidate.length === 0) {
    problems.push({ at: '<root>', message: 'quiz collection is empty' });
    return [];
  }
  return candidate;
}

function normalizeQuiz(
  entry: unknown,
  quizIndex: number,
  seenQuizIds: Set<string>,
  seenQuestionIds: Set<string>,
  problems: ValidationProblem[]
): PrivateQuiz | null {
  const at = `quizzes[${quizIndex}]`;

  if (entry === null || typeof entry !== 'object') {
    problems.push({ at, message: 'quiz must be an object' });
    return null;
  }

  const source = entry as QuizSource;
  const rawId = source.quizId;
  const quizId =
    typeof rawId === 'string' ? rawId.trim() : typeof rawId === 'number' ? String(rawId) : '';

  if (quizId.length === 0) {
    problems.push({ at, message: 'missing or blank quizId' });
    return null;
  }
  if (seenQuizIds.has(quizId)) {
    problems.push({ at: quizId, message: 'duplicate quizId' });
    return null;
  }
  seenQuizIds.add(quizId);

  if (!isNonEmptyString(source.milestone)) {
    problems.push({ at: quizId, message: 'missing or blank milestone' });
  }

  const rawQuestions = source.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    problems.push({ at: quizId, message: 'missing or empty questions array' });
    return null;
  }

  const questions: PrivateQuestion[] = [];
  const seenNormalizedText = new Map<string, number>();

  for (const [questionIndex, rawQuestion] of rawQuestions.entries()) {
    const question = normalizeQuestion(
      rawQuestion,
      quizId,
      questionIndex,
      seenQuestionIds,
      seenNormalizedText,
      problems
    );
    if (question) questions.push(question);
  }

  return {
    quizId,
    milestone: isNonEmptyString(source.milestone) ? source.milestone.trim() : quizId,
    summary: typeof source.summary === 'string' ? source.summary : '',
    image: typeof source.image === 'string' ? source.image : '',
    difficulty: isNonEmptyString(source.difficulty) ? source.difficulty.trim() : null,
    // PUBLIC trivia shown on the Results page. Carried through normalization so
    // the metadata endpoint can serve it — it was silently dropped here, which
    // is why `facts` reached PostgreSQL but never reached the client.
    //
    // Not answer-key material: a fact is a sentence about the topic, never about
    // which option is right. `response-policy` still bans it from the QUESTIONS
    // contract so it cannot ride along with pre-answer content.
    facts: normalizeFacts(source.facts),
    questions
  };
}

/**
 * Facts as a list of non-empty strings, or an empty list.
 *
 * Absent and malformed both become `[]` — "this quiz has no trivia" is an
 * ordinary state that twelve-odd quizzes are already in, and the Results panel
 * renders nothing for it.
 */
function normalizeFacts(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizeQuestion(
  raw: unknown,
  quizId: string,
  questionIndex: number,
  seenQuestionIds: Set<string>,
  seenNormalizedText: Map<string, number>,
  problems: ValidationProblem[]
): PrivateQuestion | null {
  const at = `${quizId}[q${questionIndex}]`;

  if (raw === null || typeof raw !== 'object') {
    problems.push({ at, message: 'question must be an object' });
    return null;
  }

  const source = raw as { questionText?: unknown; explanation?: unknown; options?: unknown };

  if (!isNonEmptyString(source.questionText)) {
    problems.push({ at, message: 'missing or blank questionText' });
    return null;
  }
  const questionText = source.questionText;

  // The app renders an explanation for every question (FET), so a blank one is
  // a data defect rather than an optional field.
  if (!isNonEmptyString(source.explanation)) {
    problems.push({ at, message: 'missing or blank explanation' });
  }

  // Text-based identity is still used in several topic-quiz paths, so duplicate
  // normalized text inside one quiz would make those lookups ambiguous.
  const normalized = normalizeText(questionText);
  const firstSeenAt = seenNormalizedText.get(normalized);
  if (firstSeenAt !== undefined) {
    problems.push({
      at,
      message: `duplicate normalized questionText (also at q${firstSeenAt}) — ambiguous for text-based lookups`
    });
  } else {
    seenNormalizedText.set(normalized, questionIndex);
  }

  const questionId = makeQuestionId(quizId, questionIndex);
  if (seenQuestionIds.has(questionId)) {
    problems.push({ at, message: 'duplicate generated questionId' });
    return null;
  }
  seenQuestionIds.add(questionId);

  const rawOptions = source.options;
  if (!Array.isArray(rawOptions) || rawOptions.length === 0) {
    problems.push({ at, message: 'missing or empty options array' });
    return null;
  }
  if (rawOptions.length < 2) {
    problems.push({ at, message: 'question needs at least two options' });
  }

  const options: PrivateOption[] = [];
  const seenOptionIds = new Set<number>();
  const optionTexts: string[] = [];
  let correctCount = 0;

  for (const [optionIndex, rawOption] of rawOptions.entries()) {
    const optionAt = `${at}.options[${optionIndex}]`;

    if (rawOption === null || typeof rawOption !== 'object') {
      problems.push({ at: optionAt, message: 'option must be an object' });
      continue;
    }

    const optionSource = rawOption as { text?: unknown; correct?: unknown };
    if (!isNonEmptyString(optionSource.text)) {
      problems.push({ at: optionAt, message: 'missing or blank option text' });
      continue;
    }

    const isCorrect = readCorrectFlag(optionSource.correct, optionAt, problems);
    if (isCorrect) correctCount++;

    const optionId = makeOptionId(questionIndex, optionIndex);
    if (seenOptionIds.has(optionId)) {
      problems.push({ at: optionAt, message: 'duplicate generated optionId within question' });
      continue;
    }
    seenOptionIds.add(optionId);

    optionTexts.push(optionSource.text);
    options.push({
      optionId,
      sourceOptionIndex: optionIndex,
      text: optionSource.text,
      isCorrect
    });
  }

  // A question nobody can answer correctly would be unscoreable.
  if (correctCount === 0) {
    problems.push({ at, message: 'question has no correct option' });
  }
  if (correctCount === options.length && options.length > 1) {
    problems.push({ at, message: 'every option is marked correct — ambiguous question' });
  }

  const type = deriveQuestionType(optionTexts, correctCount);

  // A true/false question is single-select by definition.
  if (type === 'trueFalse' && correctCount !== 1) {
    problems.push({ at, message: 'true/false question must have exactly one correct option' });
  }

  return {
    questionId,
    sourceQuizId: quizId,
    sourceQuestionIndex: questionIndex,
    questionText,
    type,
    explanation: isNonEmptyString(source.explanation) ? source.explanation : '',
    options
  };
}
