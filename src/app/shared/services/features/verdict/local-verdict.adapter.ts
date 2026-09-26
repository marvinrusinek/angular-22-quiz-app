import { getQuizData } from '@shared/quiz-data-cache';
import { isOptionCorrect } from '@shared/utils/is-option-correct';
import type { Option, QuizQuestion } from '@shared/models';
import {
  QuestionVerdictError,
  type QuestionCheckResult,
  type QuestionExpiredResult
} from './question-verdict.types';

/**
 * Local evaluation of Topic Quiz answers, against the in-memory quiz bank.
 *
 * This is a COMPATIBILITY ADAPTER, not the long-term implementation. It exists
 * so `QuestionVerdictService` can become the single correctness authority
 * without changing the data source in the same step — the risky refactor and
 * the risky source swap stay separate.
 *
 * Every rule here is reproduced from the shipped app, not invented:
 *
 *   - single / trueFalse resolve on ANY non-empty selection, right or wrong
 *     (the app reveals the answer on first click)
 *   - multiple resolves when `correctSet ⊆ selectedSet` — a SUPERSET check,
 *     mirroring `answer-evaluation.service.ts#areAllCorrectAnswersSelected` and
 *     the scoring gate in `quiz-scoring.service.ts`. Extra incorrect picks do
 *     NOT block completion and do NOT cost the point; the UI force-deselects
 *     them on resolution.
 *
 * When this is replaced by `POST /api/quizzes/:quizId/check`, the backend
 * applies the identical rules — they were written from this same audit.
 */

/**
 * Canonical text normalization.
 *
 * MUST match the backend exactly (`answer-check.ts#canonicalize`, and the
 * generated `question_key` / `option_key` columns): NFC, trim, collapse
 * internal whitespace, lowercase. Any divergence would mean a question that
 * matches locally fails to match remotely after the flip.
 */
export function canonicalize(text: string): string {
  return text.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** One shared failure. The caller must not learn WHICH part was wrong. */
function reject(): never {
  throw new QuestionVerdictError('Invalid submission');
}

function findQuiz(quizId: unknown) {
  if (typeof quizId !== 'string' || quizId.trim().length === 0) reject();
  const quiz = getQuizData().find((candidate) => candidate.quizId === quizId);
  if (!quiz || !Array.isArray(quiz.questions)) reject();
  return quiz;
}

function findQuestion(quizId: unknown, questionText: unknown): QuizQuestion {
  if (typeof questionText !== 'string' || questionText.trim().length === 0) reject();

  const quiz = findQuiz(quizId);
  const key = canonicalize(questionText);
  const found = (quiz.questions ?? []).find(
    (question) => canonicalize(question.questionText ?? '') === key
  );
  if (!found || !Array.isArray(found.options)) reject();
  return found;
}

/**
 * Is this a single-select question?
 *
 * Derived the same way the backend derives `type`: more than one correct option
 * means multiple; otherwise single (true/false is single-select too). The local
 * models carry no explicit `type`, so deriving it here keeps the two sides
 * agreeing rather than depending on a field that may be absent.
 */
function isSingleSelect(question: QuizQuestion): boolean {
  return question.options.filter((option) => isOptionCorrect(option)).length <= 1;
}

const correctOptionsOf = (question: QuizQuestion): readonly Option[] =>
  question.options.filter((option) => isOptionCorrect(option));

/** The authorized reveal for one question, as EXACT stored strings. */
function revealOf(question: QuizQuestion): {
  correctOptionTexts: readonly string[];
  explanation: string;
} {
  return {
    correctOptionTexts: correctOptionsOf(question).map((option) => option.text),
    explanation: question.explanation ?? ''
  };
}

/**
 * Resolve selected texts within ONE question.
 *
 * Rejects duplicates, unknown text, and more selections than the question has
 * options — the same validation the backend performs, so a submission accepted
 * locally will be accepted remotely.
 */
function resolveSelected(
  question: QuizQuestion,
  selectedOptionTexts: unknown
): readonly Option[] {
  if (!Array.isArray(selectedOptionTexts)) reject();
  const texts = selectedOptionTexts as readonly unknown[];
  if (texts.length > question.options.length) reject();

  const byKey = new Map(question.options.map((option) => [canonicalize(option.text), option]));
  const seen = new Set<string>();
  const resolved: Option[] = [];

  for (const text of texts) {
    if (typeof text !== 'string' || text.trim().length === 0) reject();

    const key = canonicalize(text);
    if (seen.has(key)) reject();
    seen.add(key);

    const option = byKey.get(key);
    if (!option) reject();
    resolved.push(option);
  }

  return resolved;
}

export function evaluateLocally(
  quizId: string,
  questionText: string,
  selectedOptionTexts: readonly string[]
): QuestionCheckResult {
  const question = findQuestion(quizId, questionText);
  const selected = resolveSelected(question, selectedOptionTexts);

  // A single-select question cannot carry two selections. Validated against the
  // question TYPE, never against the number of correct options — the latter
  // would leak how many correct answers there are.
  if (isSingleSelect(question) && selected.length > 1) reject();

  const correctOptions = correctOptionsOf(question);

  if (isSingleSelect(question)) {
    if (selected.length === 0) {
      return { status: 'incomplete', selectedVerdicts: [], remainingCorrectCount: correctOptions.length };
    }
    return {
      status: 'resolved',
      correct: selected.every((option) => isOptionCorrect(option)),
      ...revealOf(question)
    };
  }

  // ── multiple: the audited SUPERSET rule ──────────────────────────
  const selectedKeys = new Set(selected.map((option) => canonicalize(option.text)));
  const missing = correctOptions.filter(
    (option) => !selectedKeys.has(canonicalize(option.text))
  );

  if (missing.length === 0 && selected.length > 0) {
    // correctSet ⊆ selectedSet. Extra incorrect picks are tolerated and the
    // question scores correct — preserved from the shipped behaviour.
    return { status: 'resolved', correct: true, ...revealOf(question) };
  }

  return {
    status: 'incomplete',
    selectedVerdicts: selected.map((option) => ({
      text: option.text,
      correct: isOptionCorrect(option)
    })),
    remainingCorrectCount: missing.length
  };
}

/**
 * Timer-expiry reveal.
 *
 * Local only. Expiry is decided by the caller's own timer in this stage; the
 * server-authoritative version arrives with the API flip, where the signed
 * receipt's deadline decides instead of anything the client asserts.
 */
export function revealExpiredLocally(
  quizId: string,
  questionText: string
): QuestionExpiredResult {
  return { status: 'expired', ...revealOf(findQuestion(quizId, questionText)) };
}
