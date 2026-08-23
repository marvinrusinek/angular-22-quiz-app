import type { QuizService } from '../../data/quiz.service';
import type { QuestionVerdictService } from './question-verdict.service';
import type { QuestionVerdictState } from './question-verdict.types';
import { norm } from '../../../utils/text-norm';

/**
 * Reading AUTHORIZED correctness for the question on screen.
 *
 * Consumers that used to derive correctness by walking `quizInitialState` (or
 * the live options' `correct` flags) go through here instead. The distinction
 * that matters is not "where does the data come from" but WHEN it exists:
 *
 *   incomplete → only the user's OWN selections have verdicts
 *   resolved   → the full correct set is authorized (they earned the reveal)
 *   expired    → the full correct set is authorized (the deadline revealed it)
 *   idle/checking/error → nothing is authorized
 *
 * That is why an unselected option's correctness is simply unavailable mid-
 * question. It is not withheld by convention here; the state genuinely does not
 * carry it, which is what stops partial play on a multi-answer question from
 * becoming a way to enumerate the answer key one click at a time.
 */

/**
 * The question text at a DISPLAY index.
 *
 * Shuffle-aware: under shuffle `questions[i]` is the wrong question, because
 * `i` is a display position. Getting this wrong keys every verdict lookup to
 * someone else's question, so it is resolved in exactly one place.
 */
export function questionTextForDisplayIndex(
  quizService: QuizService,
  qIdx: number
): string | null {
  const service = quizService as any;
  const inDisplayOrder = service?.getQuestionsInDisplayOrder?.()?.[qIdx]?.questionText;
  if (typeof inDisplayOrder === 'string' && inDisplayOrder.length > 0) return inDisplayOrder;

  const isShuffled = service?.isShuffleEnabled?.()
    && Array.isArray(service?.shuffledQuestions)
    && service.shuffledQuestions.length > 0;
  const fallback = isShuffled
    ? service?.shuffledQuestions?.[qIdx]?.questionText
    : service?.questions?.[qIdx]?.questionText;

  return typeof fallback === 'string' && fallback.length > 0 ? fallback : null;
}

/**
 * The recorded verdict for the question at a display index, or null when it
 * cannot be identified (no quiz id, no question text, no verdict service).
 *
 * Null means "ask something else" — it is NOT a verdict of any kind, and in
 * particular is not "incorrect".
 */
export function verdictStateForDisplayIndex(
  quizService: QuizService,
  qIdx: number,
  verdicts: QuestionVerdictService | null | undefined
): QuestionVerdictState | null {
  if (!verdicts) return null;

  const quizId = (quizService as any)?.quizId as string | undefined;
  const questionText = questionTextForDisplayIndex(quizService, qIdx);
  if (!quizId || !questionText) return null;

  return verdicts.verdictFor(quizId, questionText);
}

/**
 * The full correct-option set, normalized for text matching — but ONLY once a
 * terminal phase has authorized the reveal.
 *
 * Returns null while the question is unresolved. Callers must treat that as
 * "unknown", never as an empty correct set: an empty set would say "no option
 * is correct", which is a claim nobody has made.
 */
export function authorizedCorrectTexts(
  quizService: QuizService,
  qIdx: number,
  verdicts: QuestionVerdictService | null | undefined
): ReadonlySet<string> | null {
  const state = verdictStateForDisplayIndex(quizService, qIdx, verdicts);
  if (!state) return null;

  // NON-EMPTINESS *IS* THE AUTHORIZATION.
  //
  // This also required a terminal phase. That reads as the stricter rule but is
  // actually redundant — `correctOptionTexts` is only ever populated by a
  // server reveal — and it cost real behaviour: revisiting an answered question
  // re-submits, the re-check answers `incomplete`, and the phase gate then
  // withheld a reveal the player had already been shown. A correctly answered
  // question came back from a revisit painted INCORRECT.
  //
  // An empty set still means "not revealed" and still returns null, so nothing
  // is disclosed early; what changed is that a reveal already granted is not
  // rescinded by a later partial submission.
  if (state.correctOptionTexts.length === 0) return null;

  return new Set(state.correctOptionTexts.map((text) => norm(text)));
}

/**
 * The AUTHORIZED explanation for the question at a display index.
 *
 * Null until a terminal phase authorizes it — which is the same moment
 * `authorizedCorrectTexts` starts answering, and for the same reason: the
 * explanation names the correct options, so releasing it early would reveal the
 * answer key to anyone who opened a question and read the network tab.
 *
 * `/check` already enforces this on the wire — `explanation` appears on
 * `resolved` and `expired` and on nothing else — so this is the client-side
 * mirror of a rule the server keeps independently.
 *
 * NULL MEANS "NOT AUTHORIZED", NOT "EMPTY". A caller must render nothing
 * rather than reach for `question.explanation`: the local bank is what this
 * migration exists to remove, and a fallback there would work in every test and
 * then fail the day the asset is deleted.
 */
export function authorizedExplanation(
  quizService: QuizService,
  qIdx: number,
  verdicts: QuestionVerdictService | null | undefined
): string | null {
  const state = verdictStateForDisplayIndex(quizService, qIdx, verdicts);
  return explanationFromVerdict(state);
}

/**
 * The same rule, for a caller that already holds the state.
 *
 * Split out so the FET pipeline can ask without re-resolving the question by
 * display index — several of its call sites have the state in hand and
 * re-deriving it would risk keying to a different question than the one they
 * are rendering.
 */
export function explanationFromVerdict(
  state: QuestionVerdictState | null
): string | null {
  if (!state) return null;
  if (state.phase !== 'resolved' && state.phase !== 'expired') return null;

  const text = (state.explanation ?? '').trim();
  return text.length > 0 ? text : null;
}

/**
 * Was THIS option, which the user selected, correct?
 *
 * `undefined` when the option carries no verdict — either it was never selected
 * or nothing has been checked yet. Distinct from `false`, which is an authorized
 * "you got this one wrong".
 */
export function selectedVerdictFor(
  state: QuestionVerdictState | null,
  optionText: string | null | undefined
): boolean | undefined {
  if (!state || !optionText) return undefined;

  const direct = state.selectedVerdicts.get(optionText);
  if (direct !== undefined) return direct;

  // The map is keyed by the option's exact text; fall back to a normalized
  // comparison so trailing-whitespace drift in the bank cannot lose a verdict.
  const target = norm(optionText);
  for (const [text, correct] of state.selectedVerdicts) {
    if (norm(text) === target) return correct;
  }
  return undefined;
}

/**
 * Has every correct option been selected, per the verdict?
 *
 * Null when unknown. Reads only authorized facts: a terminal correct result, or
 * the count of correct options still outstanding — never which ones.
 */
export function allCorrectSelectedFromVerdict(
  state: QuestionVerdictState | null
): boolean | null {
  if (!state) return null;
  if (state.phase === 'resolved') return state.isResolvedCorrect === true;
  if (state.phase === 'incomplete') {
    return state.remainingCorrectCount === 0;
  }
  return null;
}
