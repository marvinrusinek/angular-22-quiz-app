/**
 * ONE coordinated screen-reader announcement per answer outcome.
 *
 * Previously three independent `aria-live="polite"` regions each
 * self-announced on the same click — the question/FET heading, the
 * selection-message guidance, and this persistent feedback announcer — which
 * a live MutationObserver diagnostic confirmed mutate within the same
 * synchronous tick. Multiple simultaneously-mutating polite regions are not
 * reliably queued by every assistive technology. This function composes the
 * single utterance the persistent announcer now carries for every answer
 * outcome; the heading and selection-message region keep their VISIBLE
 * content and remain reachable by normal reading, but no longer
 * independently self-announce for these events (see
 * AnswerAnnouncementCoordinatorService for the wiring).
 */

const SELECT_MORE_PATTERN = /select\s+\d+\s+more\s+correct\s+answers?\b/i;

/**
 * Strips the handful of inline tags the heading's own sanitizer allows
 * through (<code>/<strong>/<span>/<em>) and decodes basic entities, for a
 * PLAIN-TEXT live-region announcement. The visible heading keeps its real
 * markup; this is only for what gets spoken.
 */
export function htmlToAnnouncementText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    // A closing tag directly before punctuation (e.g. "</strong>.") leaves
    // "word .", an awkward pause for speech — collapse that one space.
    .replace(/\s+([.,!?;:])/g, '$1')
    .trim();
}

export interface AnswerAnnouncementInputs {
  /** The per-click feedback verdict text (FeedbackComponent's displayMessage). */
  feedbackText: string;
  /** The AUTHORIZED correct/incorrect verdict for this click — never 'checking'. */
  isCorrect: boolean;
  /** Does the heading's own shouldShowFet() say the explanation is due RIGHT NOW? */
  fetDue: boolean;
  /** Raw (possibly HTML) explanation text; '' when not available. */
  fetText: string;
  /** The CURRENT selection-message guidance text (plain). */
  progressGuidance: string;
}

/**
 * Decide the one composed utterance for an answer outcome:
 *
 *  - Incorrect: feedback alone. The guidance for a wrong pick ("Please
 *    select the correct answer to continue.") is unchanged boilerplate, not
 *    new information, so it is not repeated.
 *  - Correct, not yet complete (multi-answer in progress): feedback + the
 *    CURRENT "Select N more..." guidance, when present — genuinely useful,
 *    changing information.
 *  - Correct AND complete (single-answer correct, multi-answer just
 *    finished, or a genuine timer expiry — all of which set fetDue): brief
 *    feedback followed by the explanation, as ONE message. The "click
 *    Next"/"Show Results" guidance is not spoken — it stays visible,
 *    unchanged, and reachable by normal navigation.
 */
export function composeAnswerAnnouncement(i: AnswerAnnouncementInputs): string {
  const feedback = i.feedbackText.trim();
  if (!feedback) return '';
  if (!i.isCorrect) return feedback;
  if (i.fetDue && i.fetText.trim()) {
    return `${feedback} ${htmlToAnnouncementText(i.fetText)}`;
  }
  if (SELECT_MORE_PATTERN.test(i.progressGuidance)) {
    return `${feedback} ${i.progressGuidance.trim()}`;
  }
  return feedback;
}
