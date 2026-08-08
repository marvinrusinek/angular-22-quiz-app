import { QuestionType } from '../models/question-type.enum';
import type { QuizQuestion } from '../models/QuizQuestion.model';

/**
 * Whether a question is multi-answer, asked WITHOUT counting correct options.
 *
 * ── Why counting had to stop ───────────────────────────────────────
 *
 * The runtime decided single-vs-multiple with `correctCount > 1` in roughly
 * fifty places. That makes question TYPE a derivative of the answer key, so
 * the type would stop working the moment the key left the browser — and the
 * options' `correct` flags are exactly what the API migration is removing.
 *
 * Type is not a secret. `GET /questions` declares it, TopicQuizTypeRegistry
 * stamps it onto each question at load, and these helpers read the stamp.
 *
 * ── Explicit beats counted, even when they disagree ────────────────
 *
 * The important property is that a declared type WINS rather than merely
 * joining the OR. Several call sites used to read
 * `type === MultipleAnswer || correctCount > 1`, which quietly means the local
 * flags can still promote a declared single-answer question to multiple. If
 * the bank drifts — or is tampered with — the declared type must decide.
 *
 * ── Unknown is not single ──────────────────────────────────────────
 *
 * `null` means "not declared", never "single". Treating a miss as single would
 * turn multi-answer questions into single-answer ones for as long as the
 * request is in flight, which is worse than the count-based fallback it would
 * be replacing.
 */
export function declaredIsMultiAnswer(
  question: QuizQuestion | null | undefined
): boolean | null {
  switch (question?.type) {
    case QuestionType.MultipleAnswer:
      return true;
    // A true/false question is single-SELECTION. Callers that need to keep the
    // two apart read `question.type` directly; this helper answers only the
    // narrower cardinality question.
    case QuestionType.SingleAnswer:
    case QuestionType.TrueFalse:
      return false;
    default:
      return null;
  }
}

/**
 * The declared answer, or the caller's count-based guess when undeclared.
 *
 * REMOVE THE FALLBACK IN /questions CONTENT CUTOVER — once questions come from
 * the API they always carry a type, and `countedIsMulti` has nothing left to
 * compute from. Until then the fallback keeps quizzes playable when the type
 * request is slow or fails, which is acceptable precisely because type is not
 * correctness.
 */
export function resolveIsMultiAnswer(
  question: QuizQuestion | null | undefined,
  countedIsMulti: boolean
): boolean {
  const declared = declaredIsMultiAnswer(question);
  return declared === null ? countedIsMulti : declared;
}

/** True only for an explicitly declared true/false question. */
export function isDeclaredTrueFalse(
  question: QuizQuestion | null | undefined
): boolean {
  return question?.type === QuestionType.TrueFalse;
}
