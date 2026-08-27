/**
 * Single-source heading-derivation model (Stage 1 of the heading/FET state-model
 * refactor — see E6_FET_STATE_MACHINE_DESIGN.md §7).
 *
 * The `<h3 #qText>` heading is currently produced by 5+ competing imperative
 * writers (writeQText/qTextHtmlSig, questionHeadingService.setHtml,
 * computeIntendedQText, the timer-expiry DOM write, the MutationObserver
 * watchdog) plus a chain of gates in cqc-fet-guard. This pure function is the
 * intended REPLACEMENT decision: given the resolved state for a question,
 * return the heading HTML — question(+banner) or the FET.
 *
 * It is intentionally UNUSED for now. Stage 2 runs it in shadow mode (compute +
 * compare against the live heading, dev-log mismatches) to validate it matches
 * the current behavior across every scenario BEFORE anything is switched over.
 * Keep it PURE (no services, no DOM, no signals) so it stays trivially testable.
 */

export interface HeadingInputs {
  /** Question text already with the multi-answer banner attached when applicable
   *  (i.e. what should show while NOT displaying the FET). */
  questionHtml: string;
  /** Formatted explanation text (FET) for this question, or '' if not available. */
  fetHtml: string;
  /** Pristine: does this question have >1 correct option? */
  isMultiAnswer: boolean;
  /** Multi-answer completed — every pristine-correct option selected
   *  (a.k.a. multiAnswerCompletion / fetBypass for this index). */
  isMultiAnswerComplete: boolean;
  /** Single-answer answered correctly (the pristine-correct option selected). */
  isSingleAnswered: boolean;
  /** The per-question countdown expired for this question. */
  isTimedOut: boolean;
  /** A real in-session interaction happened for this question. */
  hasInteracted: boolean;
  /** Options have rendered for this index. False during a cold load / reload
   *  before options arrive — we must never show a stale FET then (§5.3). */
  optionsReady: boolean;
  /** Navigated here (revisit). NOTE: this is a coarse signal — it is NOT reliably
   *  cleared when the user answers a question reached by navigation, so on its own
   *  it produces a FALSE NEGATIVE on a genuine completion view. Pair it with
   *  `interactedThisVisit` (below): a revisit suppresses the FET only when the user
   *  has NOT interacted this visit (§5.2, §5.11). */
  isNavigatingToPrevious: boolean;

  /** The user made a genuine interaction (option click) with THIS question on
   *  THIS visit. Race-immune: set synchronously on the click, cleared on
   *  navigation (QuizStateService.wasInteractedThisVisit). Distinguishes the live
   *  answer view (FET) from a revisit of an already-answered question (question
   *  text) even when isNavigatingToPrevious is stale-true. */
  interactedThisVisit: boolean;

  /** Interview Mode: feedback is DEFERRED until submission, so the heading must
   *  ALWAYS show the question text and NEVER the FET, regardless of answered/
   *  timeout state. Optional so existing (immediate-feedback) callers are
   *  unaffected — undefined behaves exactly as before. */
  deferFeedback?: boolean;

  /** The AUTHORIZED correct option texts, for the timeout notice only.
   *
   *  Populated from the verdict once the deadline reveal has arrived
   *  (`phase === expired`), and empty otherwise — so a question whose reveal
   *  has not been authorized shows the notice without naming an answer rather
   *  than inventing one. Never sourced from the bundled bank.
   *
   *  Optional so existing callers are unaffected. */
  timeoutCorrectAnswers?: readonly string[];
}

/**
 * Decide whether the heading should show the FET (vs the question + banner).
 *
 * Rules distilled from this codebase's behavior (resolveDisplayText /
 * computeIntendedQText / the multi-answer heading rule + the §5 contract):
 *  - Cold load (options not ready) never shows the FET — only the question.
 *  - On a revisit (navigated here, not re-answered) the FET is suppressed even
 *    for a resolved/timed-out question; it shows only on the live answer view.
 *  - A first-time timeout on the live view reveals the FET (no interaction).
 *  - Otherwise the FET shows only after a real interaction AND the question is
 *    "done": multi-answer fully selected, or single-answer answered correctly.
 *  - In-progress / unanswered multi-answer keeps the question + banner.
 *
 * Branch order is the precedence: cold-load and revisit both override timeout,
 * and revisit overrides a still-set resolution flag.
 */
export function shouldShowFet(i: HeadingInputs): boolean {
  // Interview Mode: correctness feedback is deferred until submission — the
  // heading stays on the question text for the entire interview. Highest
  // precedence so it overrides timeout/answered/revisit alike.
  if (i.deferFeedback) {
    return false;
  }
  if (!i.optionsReady) {
    return false;
  }
  // A LIVE timeout overrides the revisit guard. `isTimedOut`
  // (expiredForQuestionIndexSig === idx) is reset on every nav away from a
  // question, so it is only ever true for the question that just timed out on
  // this visit — never a genuine backward revisit (which reads isTimedOut=false
  // and is still suppressed by the branches below). Without this exclusion the
  // fast-path (Q2+) timeout was blocked because isNavigatingToPrevious can remain
  // stale-true after a forward Next and interactedThisVisit is false on a timeout.
  if (i.isNavigatingToPrevious && !i.interactedThisVisit && !i.isTimedOut) {
    return false;
  }
  if (i.isTimedOut) {
    return true;
  }
  if (!i.hasInteracted) {
    return false;
  }
  if (i.isMultiAnswer) {
    return i.isMultiAnswerComplete;
  }
  return i.isSingleAnswered;
}

/**
 * Option text is PLAIN TEXT and goes into an HTML heading, so it is escaped.
 *
 * The heading is sanitized before it reaches innerHTML, but sanitizing protects
 * the document — it does not stop an option that legitimately reads "<div>"
 * from being swallowed as markup. Quiz content genuinely contains tag-like
 * text, so escaping here is about rendering it faithfully.
 */
function escapeText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, `&quot;`)
    .replace(/'/g, '&#39;');
}

/**
 * The heading for a question whose time ran out.
 *
 * WHY THE NOTICE EXISTS. A timeout replaced the question text with the
 * explanation and said nothing about why. That is confusing when it happens
 * under the user's nose, and actively misleading when it happens while the
 * browser is minimised: they come back to find an explanation sitting where
 * their question used to be, with no indication that a deadline passed. It
 * reads as the app spontaneously giving away the answer.
 *
 * The explanation itself is unchanged — this only states the reason for it, and
 * names the correct answer when the deadline reveal has authorized one.
 */
export function withTimeoutContext(
  fetHtml: string,
  correctAnswers: readonly string[] = []
): string {
  // THREE DISTINCT PARTS, each its own element.
  //
  // Rendered inline they read as one run-on sentence — the answer running
  // straight into the explanation — which is close to the "the explanation just
  // replaced my question" impression this notice exists to dispel. The styling
  // makes each part a block; the structure here is what gives it something to
  // style.
  const parts = [`<span class="timeout-notice">Time&#39;s up.</span>`];

  // Named only when the reveal is authorized. No answer is better than a
  // guessed one, and the bank is deliberately unreachable from here.
  const named = correctAnswers.filter((t) => (t ?? '').trim().length > 0);
  if (named.length > 0) {
    const label = named.length > 1 ? 'Correct answers' : 'Correct answer';
    const list = named.map((t) => escapeText(t.trim())).join(', ');
    parts.push(
      `<span class="timeout-answer">${label}: ${list}</span>`
    );
  }

  // The explanation is optional. A deadline can pass before the reveal has
  // arrived, and the notice stands on its own until it does — stating the
  // timeout without one is honest; fabricating filler text is not.
  const explanation = (fetHtml ?? '').trim();
  if (explanation.length > 0) {
    parts.push(
      `<span class="timeout-explanation"><span class="timeout-label">Explanation:</span> ${explanation}</span>`
    );
  }

  return parts.join(' ');
}

/** The single source of truth for the heading HTML. Falls back to the question
 *  HTML whenever the FET should show but no FET text is available. */
export function deriveHeadingHtml(i: HeadingInputs): string {
  if (!shouldShowFet(i)) return i.questionHtml;

  // A TIMEOUT IS WORTH STATING EVEN WITH NOTHING TO EXPLAIN YET.
  //
  // The notice does not wait for the reveal. A deadline passing is itself the
  // news, and the explanation joins it when the server authorizes one — which
  // against a deployed backend is a round trip later, not immediately.
  //
  // Every other route to the FET was chosen by the user: they answered, so the
  // explanation needs no introduction, and with no text there is nothing to
  // show but the question.
  if (i.isTimedOut) {
    return withTimeoutContext(i.fetHtml, i.timeoutCorrectAnswers ?? []);
  }

  return i.fetHtml.trim().length > 0 ? i.fetHtml : i.questionHtml;
}
