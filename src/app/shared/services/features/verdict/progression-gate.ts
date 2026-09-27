import type { QuestionVerdictPhase } from './question-verdict.types';

/**
 * Two DISTINCT decisions, both backend-verdict-only (never `option.correct` or
 * any other client-side answer data), deliberately kept separate rather than
 * folded into one ambiguous rule:
 *
 *   - `blocksIntermediateProgression` — may the user leave THIS question via
 *     Next, keyboard advancement, or a forward dot-jump, to reach a LATER
 *     question? Correctness-gated: only a resolved-CORRECT verdict, or the
 *     established expiry path, may unblock. A partial or resolved-incorrect
 *     multi/single-answer selection blocks, and there is no "leave it partial,
 *     finish on revisit" bypass — the correctness rule wins there.
 *
 *   - `canSubmitFinalQuestion` — may the FINAL question submit to Results?
 *     A DIFFERENT, already-established policy: "Show Results only after at
 *     least one option has been selected." Correctness is NOT required —
 *     scoring stays backend-authoritative and is computed at Results,
 *     regardless of whether the last question's own answer was right.
 */

/** Intermediate question → may the user move past it? */
export function blocksIntermediateProgression(
  phase: QuestionVerdictPhase | null | undefined,
  isResolvedCorrect: boolean | null | undefined
): boolean {
  if (phase === 'expired') return false;
  if (phase === 'resolved') return isResolvedCorrect !== true;
  return true; // idle | checking | incomplete | error | no state yet
}

/**
 * Final question → may Results be submitted?
 *
 * `incomplete` is never a pending/pre-dispatch state: `IDLE_VERDICT_STATE`
 * (never checked) is phase `'idle'`, and `checking` is the ONLY in-flight
 * phase. `incomplete` is written exclusively by `applyResult()` when the
 * backend's response itself was `status: 'incomplete'` — i.e. it is always a
 * COMPLETED round trip, on par with `resolved`, just not (yet) the exact
 * correct set. So a completed `incomplete` response with a current selection
 * satisfies "answered and the backend has responded", exactly as a `resolved`
 * one does — correctness is not the question here.
 *
 * `hasSelection` should read the verdict state's OWN `selectedOptionTexts`
 * (what the last submission/response carries), not a locally-tracked flag —
 * a user who selected something and then deselected back to empty submits an
 * EMPTY set, which resolves `incomplete` with no selection, and that must
 * still count as "no selection" here.
 */
export function canSubmitFinalQuestion(
  phase: QuestionVerdictPhase | null | undefined,
  hasSelection: boolean
): boolean {
  if (phase === 'expired') return true;
  if (!hasSelection) return false;
  return phase === 'resolved' || phase === 'incomplete';
}
