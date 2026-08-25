import { OptionBindings } from '../../../../../../shared/models/OptionBindings.model';

import { QuizService } from '../../../../../../shared/services/data/quiz.service';
import type { QuestionVerdictService } from '../../../../../../shared/services/features/verdict/question-verdict.service';

import {
  questionTextForDisplayIndex,
  verdictStateForDisplayIndex
} from '../../../../../../shared/services/features/verdict/authorized-correctness';
import { norm } from '../../../../../../shared/utils/text-norm';

/**
 * Is THIS option correct, for rendering purposes?
 *
 * The per-option highlight decision: icon, `correct-option` /
 * `incorrect-option` classes, colours. Correctness comes from
 * QuestionVerdictService, not from the option's own `correct` flag.
 *
 * ── The security invariant this function enforces ──────────────────
 *
 * While a multiple-answer question is INCOMPLETE:
 *
 *     selected options may show their own verdict
 *     unselected options reveal nothing
 *
 * That is enforced structurally here rather than by convention. Reading the
 * bank directly would let an unselected correct option paint itself green
 * before the user has earned the reveal — and once the answer key stops
 * shipping to the browser, there would be nothing to read anyway.
 *
 * The verdict service only knows about options the user actually selected
 * until the question resolves, so it cannot answer for an unselected one.
 * `verdictForOption` returning null IS that distinction.
 */

/**
 * Has the backend AUTHORIZED this question's timeout reveal yet?
 *
 * "The timer ran out" and "the server has told us the answers" are two
 * different facts, and they arrive at different times. The timer fact is
 * instant and local; the reveal is a round trip. Painting correctness on the
 * timer fact alone is the race this exists to close — it is what forced the
 * local `.correct` fallback to stay load-bearing, because something had to fill
 * the gap between the two.
 *
 * Only `expired` counts. A question that merely RESOLVED is a different reveal
 * on a different path, and `idle`/`checking`/`error` mean the reveal has not
 * arrived — in which case the honest render is "no correctness yet".
 */
export function isTimeoutRevealAuthorized(
  quizService: QuizService,
  qIdx: number,
  verdicts?: QuestionVerdictService
): boolean {
  if (!verdicts) return false;

  const quizId = (quizService as any)?.quizId as string | undefined;
  const questionText = questionTextForDisplayIndex(quizService, qIdx);
  if (!quizId || !questionText) return false;

  return verdicts.verdictFor(quizId, questionText).phase === 'expired';
}

/**
 * Has the user selected an option the VERDICT confirms correct?
 *
 * The single-answer lock. Once a correct pick is confirmed the question is
 * over, so every other option greys out; until then the user stays free to
 * keep trying and nothing may change.
 *
 * This used to compare the user's selections against the bank's correct set,
 * with a fallback to a `correct` flag copied onto the selection record. Both
 * were answer-key reads, and both would answer nothing once the bank stops
 * shipping. The verdict answers the same question about the same picks.
 *
 * It asks only about options the user actually touched, so it cannot leak the
 * answer key: an option nobody selected carries no verdict, and `undefined` is
 * not `true` — hence the explicit comparison rather than a truthiness test.
 */
export function hasAuthorizedCorrectSelection(
  quizService: QuizService,
  qIdx: number,
  verdicts?: QuestionVerdictService | null
): boolean {
  const state = verdictStateForDisplayIndex(quizService, qIdx, verdicts);
  if (!state) return false;

  for (const [, correct] of state.selectedVerdicts) {
    if (correct === true) return true;
  }
  return false;
}

/**
 * The same question, answered in THREE states instead of two.
 *
 * `undefined` means no authority has spoken yet — not "incorrect". Callers that
 * paint red must test for an explicit `false`, because negating a two-state
 * boolean turns "nothing is known" into "known wrong". That is exactly what
 * made a correct pick flash red: the click renders while /check is still in
 * flight, and `!isCurrentOptionCorrect()` was true for the entire pending
 * window.
 *
 * `isCurrentOptionCorrect` below is kept as the two-state view for the callers
 * that genuinely want "paint green or do not", so their behaviour is unchanged.
 */
export function currentOptionCorrectness(
  binding: OptionBindings | undefined,
  quizService: QuizService,
  qIdx: number,
  verdicts?: QuestionVerdictService
): boolean | undefined {
  const optionText = (binding?.option as any)?.text as string | undefined;
  const quizId = (quizService as any)?.quizId as string | undefined;
  const questionText = questionTextForDisplayIndex(quizService, qIdx);

  // Nothing to ask, so nothing is known — same rule as the phases below.
  // Returning false here would let the caller paint red on an option no
  // authority has ruled on.
  if (!verdicts || !quizId || !questionText || !optionText) return undefined;

  // 1. The user selected this option — its own verdict is authorized.
  const own = verdicts.verdictForOption(quizId, questionText, optionText);
  if (own !== null) return own;

  const state = verdicts.verdictFor(quizId, questionText);

  // 2. Terminal — the full correct set is authorized, including options the
  //    user never selected. This is the reveal.
  if (state.phase === 'resolved' || state.phase === 'expired') {
    const target = norm(optionText);
    return state.correctOptionTexts.some((text) => norm(text) === target);
  }

  // 3. incomplete | idle | checking | error — nothing has been authorized, so
  //    nothing is painted.
  //
  //    `idle`/`checking`/`error` used to fall through to reading the option's
  //    own `correct` flag. That existed for one reason: the timeout reveal
  //    used to paint before the server had authorized it, so SOMETHING had to
  //    answer during the gap. The signed-deadline work closed that gap — the
  //    reveal now happens on the `expired` verdict, which case 2 handles — so
  //    the fallback has nothing left to cover.
  //
  //    UNDEFINED, NOT FALSE. This used to return false and describe it as "not
  //    authorized, not known incorrect" — but that distinction only survives if
  //    the value carries it. Two callers negated the boolean, so the pending
  //    window painted the user's correct pick red until the verdict landed.
  return undefined;
}

/**
 * Two-state view: is this option AUTHORIZED correct?
 *
 * Unknown collapses to false here, which is right for "paint green or do not"
 * decisions and wrong for "paint red" ones — those must use
 * `currentOptionCorrectness` and test for an explicit false.
 */
export function isCurrentOptionCorrect(
  binding: OptionBindings | undefined,
  quizService: QuizService,
  qIdx: number,
  verdicts?: QuestionVerdictService
): boolean {
  return currentOptionCorrectness(binding, quizService, qIdx, verdicts) === true;
}
