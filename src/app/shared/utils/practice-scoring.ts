import { Option } from '../models/Option.model';
import { QuizQuestion } from '../models/QuizQuestion.model';
import {
  PracticeResult,
  PracticeReviewEntry,
  PracticeTopicScore
} from '../models/PracticeResult.model';
import { declaredIsMultiAnswer } from './question-type-authority';

/**
 * "Was this question answered correctly?", answered by the AUTHORIZED verdict.
 *
 * Practice passes a reader over `PracticeVerdictService`, which holds what
 * `POST /check` said. It is a parameter rather than an import so this module
 * stays pure and testable, and — more importantly — so there is no way for a
 * local answer-key recomputation to creep back in as a fallback.
 *
 * `false` means the server said not-correct OR has not answered yet. Practice
 * treats "not yet authorized" as not-resolved, never as correct.
 */
export type AuthorizedResolved = (question: QuizQuestion) => boolean;

/**
 * Weak Areas Practice gating + scoring.
 *
 * CORRECTNESS IS NOT DECIDED HERE. Every judgement below delegates to the
 * AUTHORIZED verdict passed in by the caller, which holds what
 * `POST /api/quizzes/:quizId/check` said. A partial multi-answer is not
 * resolved and an unanswered question is not resolved, exactly as before — but
 * the server, not the browser, is what decides it.
 *
 * Practice questions come from `GET /questions` and carry NO answer key, so
 * there is nothing here to recount even as a fallback. That is deliberate: a
 * fallback would work in development and fail silently in production the day
 * the local bank is deleted.
 *
 * The gating rules reproduce the VERIFIED topic-quiz behaviour:
 *
 *   single / true-false
 *     - any selection enables Next          (selection-crud.service.ts:595-597)
 *     - options stay clickable until correct (qqc-orch-click.service.ts:167 —
 *       the single-answer disable pass runs only when the click was correct)
 *     - FET appears only once correct        (quiz-setup.service.ts:316)
 *
 *   multiple-answer
 *     - Next stays locked until the COMPLETE correct set is selected
 *       (quiz-option-processing.service.ts:136)
 *     - FET appears only on that same completion
 *       (qqc-option-selection.service.ts:98 — explanationDisplayed = lastAllCorrect)
 *
 * Scoring is FINAL-STATE, matching quiz-scoring.service.ts:263-275: a question
 * is graded on the selection the user ended on, so changing a wrong answer to
 * the right one before leaving scores correct, and navigating away with a wrong
 * answer still selected scores incorrect.
 */

/**
 * Multi-answer per the DECLARED type. Never counted from the answer key.
 *
 * Counting `option.correct` made question type a derivative of the answer key,
 * which cannot survive the key leaving the browser: with API-sourced practice
 * questions the count is always zero, so every multi-answer question would
 * silently render as single-select. The type is declared by `GET /questions`
 * and travels on the question itself.
 *
 * `null` means UNDECLARED — never "single". Callers fail closed on it rather
 * than guessing; see `canAdvanceFromQuestion`.
 */
export function declaredMultiAnswer(question: QuizQuestion | null | undefined): boolean | null {
  return declaredIsMultiAnswer(question);
}

/** Multi-answer, for consumers that only render. Undeclared renders single. */
export function isMultiAnswerQuestion(question: QuizQuestion | null | undefined): boolean {
  return declaredIsMultiAnswer(question) === true;
}

/**
 * "Resolved" = the question is fully, exactly right. Drives BOTH the FET reveal
 * and the option lock, for single and multi alike, because the verified app
 * reveals/locks on exactly that condition for each type.
 */
export function isQuestionResolved(
  question: QuizQuestion | null | undefined,
  selectedIds: readonly number[] | undefined,
  authorizedResolved: AuthorizedResolved
): boolean {
  if (!question) return false;
  if ((selectedIds ?? []).length === 0) return false;
  // The ONLY source. There is deliberately no local recomputation to fall back
  // on: `option.correct` is absent from API-sourced practice questions, and a
  // fallback would quietly grade every answer wrong.
  return authorizedResolved(question) === true;
}

/**
 * Whether Next (and, identically, the right-arrow shortcut) is enabled.
 *
 * Single/true-false: ANY selection — a wrong answer does not block progress.
 * Multi-answer: only the complete correct set.
 */
export function canAdvanceFromQuestion(
  question: QuizQuestion | null | undefined,
  selectedIds: readonly number[] | undefined,
  authorizedResolved: AuthorizedResolved
): boolean {
  if (!question) return false;
  const selected = (selectedIds ?? []).filter((id) => id != null);
  if (selected.length === 0) return false;

  const declared = declaredMultiAnswer(question);

  // FAIL CLOSED on an undeclared type. Treating unknown as single-answer would
  // let a multi-answer question advance on one pick, which is the exact
  // demotion the declared-type work exists to prevent. Requiring the authorized
  // verdict is the strict reading, and it is also always satisfiable: a
  // correctly answered question resolves either way.
  if (declared === true || declared === null) {
    return isQuestionResolved(question, selected, authorizedResolved);
  }
  return true;
}

function optionTextsForIds(
  question: QuizQuestion | null | undefined,
  ids: readonly number[]
): string[] {
  const wanted = new Set(ids);
  return (question?.options ?? [])
    .filter((option) => option.optionId != null && wanted.has(option.optionId))
    .map((option) => option.text ?? '')
    .filter((text) => text.length > 0);
}

/**
 * Score a completed practice session.
 *
 * `topicNameFor` resolves a display title for a sourceQuizId so this stays pure
 * and testable — topic identity always comes from the question's preserved
 * `sourceQuizId`, never inferred from wording.
 */
export function computePracticeResult(params: {
  sessionId: string;
  questions: readonly QuizQuestion[];
  answersByIndex: Record<number, number[]>;
  completedAt: string;
  topicNameFor: (topicId: string) => string;
  /** The authorized verdict. See `AuthorizedResolved` — never a local recount. */
  authorizedResolved: AuthorizedResolved;
  /**
   * The correct option texts the SERVER revealed for a question, or [] when it
   * has not revealed them. Practice never derives these from `option.correct`:
   * an unanswered question's answers are not the client's to know.
   */
  authorizedCorrectTexts: (question: QuizQuestion) => readonly string[];
}): PracticeResult {
  const {
    sessionId, questions, answersByIndex, completedAt, topicNameFor,
    authorizedResolved, authorizedCorrectTexts
  } = params;

  const total = questions.length;
  let correct = 0;
  let answered = 0;

  const perTopicMap = new Map<string, PracticeTopicScore>();
  const review: PracticeReviewEntry[] = [];

  for (const [index, question] of questions.entries()) {
    const selectedIds = (answersByIndex[index] ?? []).filter((id) => id != null);
    const isAnswered = selectedIds.length > 0;
    const isCorrect = isQuestionResolved(question, selectedIds, authorizedResolved);

    if (isAnswered) answered++;
    if (isCorrect) correct++;

    const topicId = question.sourceQuizId ?? 'unknown';
    const topicName = topicNameFor(topicId);

    const entry =
      perTopicMap.get(topicId) ?? { topicId, topicName, correct: 0, total: 0, percentage: 0 };
    entry.total++;
    if (isCorrect) entry.correct++;
    perTopicMap.set(topicId, entry);

    review.push({
      index,
      questionText: question.questionText ?? '',
      topicId,
      topicName,
      selectedTexts: optionTextsForIds(question, selectedIds),
      correctTexts: [...authorizedCorrectTexts(question)],
      answered: isAnswered,
      isCorrect,
      explanation: question.explanation ?? ''
    });
  }

  const perTopic = [...perTopicMap.values()].map((entry) => ({
    ...entry,
    percentage: entry.total > 0 ? Math.round((entry.correct / entry.total) * 100) : 0
  }));

  return {
    sessionId,
    completedAt,
    total,
    answered,
    unanswered: total - answered,
    correct,
    incorrect: total - correct,
    percentage: total > 0 ? Math.round((correct / total) * 100) : 0,
    perTopic,
    review
  };
}
