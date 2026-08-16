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

/**
 * The DECLARED correct-option count for a question, or null when undeclared.
 *
 * `GET /questions` reports `correctCount` beside the type, so both declared
 * facts about a question come from the same authoritative load and share one
 * question identity.
 *
 * ── Cardinality, never identity ────────────────────────────────────
 *
 * This answers HOW MANY options are correct, never WHICH. It exists for the
 * "(N answers are correct)" banner, a number the UI has always shown before
 * the user answers — so serving it changes where it comes from, not what a
 * player knows. The reveal still requires `/check`.
 *
 * ── Null is not zero, and never a type signal ──────────────────────
 *
 * Zero would assert that no option is correct. Null says nobody has told us,
 * and every caller renders no banner rather than counting `option.correct` in
 * the local bank — the dependency this removes. And unlike
 * `resolveIsMultiAnswer` above there is deliberately NO counted fallback
 * parameter: reintroducing one here would be the answer key drawing the banner
 * again.
 *
 * It must also never decide single-vs-multiple. That is `declaredIsMultiAnswer`
 * above, from `type`. A declared MULTIPLE question with a count of 1 is still
 * multiple.
 */
export function declaredCorrectCount(
  typeRegistry: { correctCountOf?: (text: string | null | undefined) => number | null } | null | undefined,
  questionText: string | null | undefined
): number | null {
  if (!typeRegistry?.correctCountOf || !questionText) return null;
  return typeRegistry.correctCountOf(questionText) ?? null;
}

/**
 * The banner count to render, or null to render no banner.
 *
 * Folds the two questions every banner site asks — "is this multi-answer?" and
 * "how many are correct?" — into one call, so the fail-closed rule is written
 * once instead of at five call sites that could drift apart.
 */
export function bannerCorrectCount(
  isMultiAnswer: boolean,
  typeRegistry: { correctCountOf?: (text: string | null | undefined) => number | null } | null | undefined,
  questionText: string | null | undefined
): number | null {
  if (!isMultiAnswer) return null;
  return declaredCorrectCount(typeRegistry, questionText);
}
