import {
  deriveHeadingHtml,
  shouldShowFet,
  withTimeoutContext,
  HeadingInputs
} from './heading-model';

/**
 * Stage 1 of the heading/FET refactor: lock the heading-derivation rules as an
 * executable spec. These are the rules the eventual single-source heading must
 * satisfy; Stage 2 validates the live behavior against this model.
 */

const base: HeadingInputs = {
  questionHtml: '<span>Question?</span>',
  fetHtml: 'Option 1 is correct because ...',
  isMultiAnswer: false,
  isMultiAnswerComplete: false,
  isSingleAnswered: false,
  isTimedOut: false,
  hasInteracted: false,
  optionsReady: true,
  isNavigatingToPrevious: false,
  interactedThisVisit: false,
};

const inputs = (over: Partial<HeadingInputs>): HeadingInputs => ({ ...base, ...over });

describe('heading-model: shouldShowFet', () => {
  it('single-answer, unanswered → question (no FET)', () => {
    expect(shouldShowFet(inputs({ hasInteracted: true }))).toBe(false);
  });

  it('single-answer, answered correctly → FET', () => {
    expect(shouldShowFet(inputs({ hasInteracted: true, isSingleAnswered: true }))).toBe(true);
  });

  it('multi-answer, in progress (interacted, not complete) → question + banner (no FET)', () => {
    expect(shouldShowFet(inputs({ isMultiAnswer: true, hasInteracted: true }))).toBe(false);
  });

  it('multi-answer, complete → FET', () => {
    expect(shouldShowFet(inputs({ isMultiAnswer: true, hasInteracted: true, isMultiAnswerComplete: true }))).toBe(true);
  });

  it('timeout reveals the FET even without interaction', () => {
    expect(shouldShowFet(inputs({ isTimedOut: true }))).toBe(true);
    expect(shouldShowFet(inputs({ isMultiAnswer: true, isTimedOut: true }))).toBe(true);
  });

  it('no interaction and no timeout → never FET', () => {
    expect(shouldShowFet(inputs({ isSingleAnswered: true }))).toBe(false);
    expect(shouldShowFet(inputs({ isMultiAnswer: true, isMultiAnswerComplete: true }))).toBe(false);
  });

  // §5.3 — cold load / options not ready never shows a (stale) FET.
  it('cold load (options not ready) → never FET, even when otherwise resolved', () => {
    expect(shouldShowFet(inputs({ optionsReady: false, hasInteracted: true, isSingleAnswered: true }))).toBe(false);
    expect(shouldShowFet(inputs({ optionsReady: false, isTimedOut: true }))).toBe(false);
  });

  // §5.2 / §5.11 — on a revisit the FET is suppressed for a RESOLVED (answered)
  // question; it shows only on the live answer view. A live timeout is the one
  // exception (see the live-timeout case below): isTimedOut is reset on nav, so a
  // true isTimedOut always means the current question just timed out this visit.
  it('revisit (navigated here, not re-answered) → never FET when resolved by answering', () => {
    expect(shouldShowFet(inputs({ isNavigatingToPrevious: true, hasInteracted: true, isSingleAnswered: true }))).toBe(false);
    expect(shouldShowFet(inputs({ isNavigatingToPrevious: true, isMultiAnswer: true, hasInteracted: true, isMultiAnswerComplete: true }))).toBe(false);
  });

  // §5.6 — a first-time timeout on the live view (not a revisit) reveals the FET.
  it('live first-time timeout (not a revisit) → FET', () => {
    expect(shouldShowFet(inputs({ isTimedOut: true }))).toBe(true);
    expect(shouldShowFet(inputs({ isTimedOut: true, isNavigatingToPrevious: false }))).toBe(true);
  });

  // §5.7 — completing a question REACHED BY NAVIGATION still shows the FET, even
  // though isNavigatingToPrevious can remain stale-true: interactedThisVisit
  // (set on the genuine click) distinguishes the live completion view from a
  // revisit. Regression guard for the shadow-sweep false negative.
  it('completion view reached by nav (isNavigatingToPrevious stale-true + interactedThisVisit) → FET', () => {
    expect(shouldShowFet(inputs({
      isMultiAnswer: true, hasInteracted: true, isMultiAnswerComplete: true,
      isNavigatingToPrevious: true, interactedThisVisit: true,
    }))).toBe(true);
    expect(shouldShowFet(inputs({
      hasInteracted: true, isSingleAnswered: true,
      isNavigatingToPrevious: true, interactedThisVisit: true,
    }))).toBe(true);
  });

  // The revisit suppression still holds for an ANSWER-resolved question when the
  // user has NOT interacted this visit.
  it('revisit without interaction this visit → no FET for an answer-resolved question', () => {
    expect(shouldShowFet(inputs({
      isMultiAnswer: true, hasInteracted: true, isMultiAnswerComplete: true,
      isNavigatingToPrevious: true, interactedThisVisit: false,
    }))).toBe(false);
  });

  // A live timeout on Q2+ reaches the heading via the fast-path, where
  // isNavigatingToPrevious is stale-true and interactedThisVisit is false (no
  // click). The FET must STILL show — isTimedOut overrides the revisit guard.
  it('live timeout with stale isNavigatingToPrevious + no interaction → FET', () => {
    expect(shouldShowFet(inputs({ isTimedOut: true, isNavigatingToPrevious: true }))).toBe(true);
    expect(shouldShowFet(inputs({ isTimedOut: true, isNavigatingToPrevious: true, interactedThisVisit: false }))).toBe(true);
  });
});

// Interview Mode: feedback deferred → the heading NEVER shows the FET, and this
// overrides answered/timeout/multi-complete alike. Immediate feedback (the field
// absent) is unchanged.
describe('heading-model: deferred feedback (Interview Mode)', () => {
  it('forces the question text even when single-answered', () => {
    expect(shouldShowFet(inputs({ deferFeedback: true, hasInteracted: true, isSingleAnswered: true }))).toBe(false);
  });

  it('forces the question text even on a timeout', () => {
    expect(shouldShowFet(inputs({ deferFeedback: true, isTimedOut: true }))).toBe(false);
  });

  it('forces the question text even when a multi-answer is complete', () => {
    expect(shouldShowFet(inputs({
      deferFeedback: true, isMultiAnswer: true, hasInteracted: true, isMultiAnswerComplete: true
    }))).toBe(false);
  });

  it('deriveHeadingHtml returns the question text while deferred', () => {
    const i = inputs({ deferFeedback: true, hasInteracted: true, isSingleAnswered: true });
    expect(deriveHeadingHtml(i)).toBe(i.questionHtml);
  });

  it('immediate feedback (deferFeedback absent) is unchanged', () => {
    expect(shouldShowFet(inputs({ hasInteracted: true, isSingleAnswered: true }))).toBe(true);
    expect(shouldShowFet(inputs({ deferFeedback: false, hasInteracted: true, isSingleAnswered: true }))).toBe(true);
  });
});

describe('heading-model: deriveHeadingHtml', () => {
  it('returns the FET when the FET should show and text exists', () => {
    const i = inputs({ hasInteracted: true, isSingleAnswered: true });
    expect(deriveHeadingHtml(i)).toBe(i.fetHtml);
  });

  it('returns the question (+banner) when the FET should NOT show', () => {
    const i = inputs({ isMultiAnswer: true, hasInteracted: true });
    expect(deriveHeadingHtml(i)).toBe(i.questionHtml);
  });

  // SUPERSEDED CONTRACT. This asserted that a timeout with no FET text fell
  // back to the question. It now states the timeout instead: against a deployed
  // backend the authorized reveal arrives a round trip AFTER the deadline, so
  // "no text yet" is the normal first frame of every timeout — and showing the
  // question there tells the user nothing happened when it did.
  it('states the timeout even when no explanation text exists yet', () => {
    const i = inputs({ isTimedOut: true, fetHtml: '   ' });
    expect(deriveHeadingHtml(i)).toContain('Time&#39;s up.');
  });

  it('still falls back to the question when the FET is due for a NON-timeout reason', () => {
    // Unchanged: an answered question with no explanation shows the question.
    const i = inputs({ hasInteracted: true, isSingleAnswered: true, fetHtml: '   ' });
    expect(deriveHeadingHtml(i)).toBe(i.questionHtml);
  });

  it('multi-answer in progress keeps the question + banner', () => {
    const i = inputs({ isMultiAnswer: true, hasInteracted: true, questionHtml: 'Q <span class="correct-count">2 answers are correct</span>' });
    expect(deriveHeadingHtml(i)).toBe(i.questionHtml);
  });
});

/**
 * A TIMEOUT SAYS WHY THE EXPLANATION IS THERE.
 *
 * ── The report this pins ──────────────────────────────────────────
 *
 * A quiz was left minimised for several minutes. The question deadline passed
 * while the window was hidden, and on returning the user found explanation text
 * where their question had been — reading as though the app had spontaneously
 * given away the answer.
 *
 * The reveal itself was correct: the deadline genuinely expired, and a timed-out
 * question is entitled to show its explanation. What was missing was any
 * statement of WHY, which is what made it look like a defect.
 *
 * ── Provenance, not just authorization ────────────────────────────
 *
 * These also pin where the named answer may come from. `fetHtml` is a fallback
 * chain whose first entry is the ordinary formatted explanation, so "the FET"
 * and "the explanation" are the same text in this codebase. The correct ANSWER
 * is different: it may only be named from the deadline reveal the server
 * authorized, never reconstructed locally.
 */
describe('heading-model: the timeout notice', () => {
  const FET = 'Option 1 is correct because TS uses structural typing.';

  it('emits three SEPARATE parts, each in its own element', () => {
    const html = deriveHeadingHtml(inputs({
      isTimedOut: true,
      fetHtml: FET,
      timeoutCorrectAnswers: ['Structural typing']
    }));

    // Structure, not just combined text: rendered inline these read as one
    // run-on sentence, which is the impression the notice exists to dispel.
    expect(html).toContain(`<span class="timeout-notice">Time&#39;s up.</span>`);
    expect(html).toContain(`<span class="timeout-answer">Correct answer: Structural typing</span>`);
    expect(html).toContain(`<span class="timeout-explanation">`);
    expect(html).toContain(`<span class="timeout-label">Explanation:</span>`);
    expect(html).toContain(FET);
  });

  it('labels the explanation so it cannot run into the answer', () => {
    const html = deriveHeadingHtml(inputs({
      isTimedOut: true,
      fetHtml: FET,
      timeoutCorrectAnswers: ['Structural typing']
    }));

    // The answer element must CLOSE before the explanation element opens.
    const answerEnd = html.indexOf('</span>', html.indexOf('timeout-answer'));
    const explStart = html.indexOf('timeout-explanation');
    expect(answerEnd).toBeGreaterThan(-1);
    expect(explStart).toBeGreaterThan(answerEnd);

    // …and the explanation is introduced, not merely appended.
    expect(html).toContain('<span class="timeout-label">Explanation:</span> ');
  });

  it('pluralises when the deadline reveal names several answers', () => {
    const html = deriveHeadingHtml(inputs({
      isTimedOut: true,
      fetHtml: FET,
      timeoutCorrectAnswers: ['map', 'filter']
    }));

    expect(html).toContain('Correct answers: map, filter');
  });

  it('omits the answer ELEMENT entirely when no reveal is authorized', () => {
    // A question can time out before the deadline reveal arrives. Naming
    // nothing is right; inventing an answer would be a fabricated disclosure.
    const html = deriveHeadingHtml(inputs({
      isTimedOut: true,
      fetHtml: FET,
      timeoutCorrectAnswers: []
    }));

    expect(html).toContain(`<span class="timeout-notice">`);
    expect(html).not.toContain('timeout-answer');
    expect(html).toContain(`<span class="timeout-explanation">`);
    expect(html).toContain(FET);
  });

  it('adds NO notice when the question was answered rather than timed out', () => {
    // The user chose to see this explanation by answering. Only a timeout needs
    // explaining, so the ordinary FET render must be untouched.
    const html = deriveHeadingHtml(inputs({
      hasInteracted: true,
      isSingleAnswered: true,
      fetHtml: FET
    }));

    expect(html).toBe(FET);
    expect(html).not.toContain('Time&#39;s up');
  });

  it('shows the QUESTION, not a notice, when nothing may be revealed yet', () => {
    // Unresolved and untouched: no explanation may appear at all.
    const html = deriveHeadingHtml(inputs({ hasInteracted: true, fetHtml: FET }));
    expect(html).toBe(base.questionHtml);
    expect(html).not.toContain('Time&#39;s up');
  });

  it('states the timeout before any explanation is authorized', () => {
    // Revised from "show the question when there is no text". The deadline
    // passing IS the news, and against a deployed backend the reveal lands a
    // round trip later — so this is what a live timeout looks like at first.
    const html = deriveHeadingHtml(inputs({ isTimedOut: true, fetHtml: '' }));
    expect(html).toContain('Time&#39;s up.');
    expect(html).not.toContain('No explanation available');
  });

  it('escapes option text so tag-like answers render as written', () => {
    // Quiz options legitimately contain things like "<div>". Sanitizing protects
    // the document; escaping is what renders the answer faithfully.
    const html = withTimeoutContext('expl', ['<div> element']);
    expect(html).toContain('&lt;div&gt; element');
    expect(html).not.toContain('<div> element');
  });

  it('ignores blank entries rather than naming an empty answer', () => {
    const html = withTimeoutContext('expl', ['', '   ']);
    expect(html).not.toContain('Correct answer');
  });
});
