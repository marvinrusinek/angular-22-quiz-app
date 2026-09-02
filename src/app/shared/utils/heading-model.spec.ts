import {
  deriveHeadingHtml,
  shouldShowFet,
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

  // A genuine timeout with no explanation text YET (the deadline reveal is a
  // round trip behind the deadline itself) falls back to the question, same
  // as any other FET-due-but-textless case — there is no expiry-specific
  // wrapper to state the timeout instead.
  it('falls back to the question when a timeout has no explanation text yet', () => {
    const i = inputs({ isTimedOut: true, fetHtml: '   ' });
    expect(deriveHeadingHtml(i)).toBe(i.questionHtml);
  });

  it('a genuine timeout with explanation text renders through the ordinary FET path — no special wrapper', () => {
    const FET = 'Option 1 is correct because change detection keeps the view in sync.';
    const html = deriveHeadingHtml(inputs({ isTimedOut: true, fetHtml: FET }));
    expect(html).toBe(FET);
    expect(html).not.toContain('Time&#39;s up');
    expect(html).not.toContain('timeout-notice');
    expect(html).not.toContain('timeout-answer');
    expect(html).not.toContain('timeout-explanation');
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
 * NO EXPIRY-SPECIFIC PRESENTATION.
 *
 * A prior iteration wrapped a genuine timeout in a "Time's up. / Correct
 * answer(s): ... / Explanation: ..." block. That block has been removed
 * entirely: a genuine timer expiry now enters the exact same rendering path
 * as any other earned reveal — `shouldShowFet` still decides a timeout earns
 * one, but `deriveHeadingHtml` no longer branches on `isTimedOut` when
 * building the CONTENT, only when deciding whether to show it at all.
 */
describe('heading-model: genuine timeout uses the ordinary FET presentation, not a special one', () => {
  const FET = 'Option 1 is correct because TS uses structural typing.';

  it('a timeout with explanation text renders IDENTICALLY to a normal answered reveal', () => {
    const timedOutHtml = deriveHeadingHtml(inputs({ isTimedOut: true, fetHtml: FET }));
    const answeredHtml = deriveHeadingHtml(inputs({ hasInteracted: true, isSingleAnswered: true, fetHtml: FET }));
    expect(timedOutHtml).toBe(FET);
    expect(timedOutHtml).toBe(answeredHtml);
  });

  it('contains none of the removed expiry-presentation markers', () => {
    const html = deriveHeadingHtml(inputs({ isTimedOut: true, fetHtml: FET }));
    expect(html).not.toContain('Time&#39;s up');
    expect(html).not.toContain('timeout-notice');
    expect(html).not.toContain('timeout-answer');
    expect(html).not.toContain('timeout-explanation');
    expect(html).not.toContain('timeout-label');
    expect(html).not.toContain('Correct answer');
  });

  it('shows the QUESTION, not any notice, when nothing may be revealed yet', () => {
    const html = deriveHeadingHtml(inputs({ hasInteracted: true, fetHtml: FET }));
    expect(html).toBe(base.questionHtml);
  });
});

/**
 * REFRESH AFTER FET REVEAL MUST NOT LOSE THE FET — BUT ONLY WHEN IT WAS
 * ACTUALLY EARNED.
 *
 * A page reload zeroes every LIVE signal (`isTimedOut`, `hasInteracted`,
 * `interactedThisVisit`) — none of them survive a reload by design. Before
 * this fix, `shouldShowFet` only ever earned a no-interaction reveal through
 * `isTimedOut`, so a reload landed on the question text even though the
 * verdict had already been correctly rehydrated from
 * `earned-verdict-storage.ts`. `verdictEarnedReveal` carries that durable
 * fact through the reload; `isNavigatingToPrevious` still gates it so a
 * genuine in-session revisit is unaffected.
 *
 * These tests exercise `shouldShowFet` directly with `verdictEarnedReveal`
 * already computed — they pin the CONTRACT (a true value always wins, ahead
 * of `hasInteracted`, behind the revisit guard). The COMPUTATION of the value
 * itself — correctly false for a resolved-but-wrong pick or an incomplete
 * multi-answer selection, true only once earned — is a separate concern and
 * is pinned at the `heading-inputs.ts` level in
 * `heading-inputs-fet-eligibility.spec.ts`, which is where the "wrong answer
 * revealed the FET" regression actually lived.
 */
describe('heading-model: verdictEarnedReveal restores the FET across a reload', () => {
  it('cold reload, no live interaction, but a rehydrated earned verdict → FET restores', () => {
    expect(shouldShowFet(inputs({ verdictEarnedReveal: true }))).toBe(true);
  });

  it('cold reload with no earned verdict (never earned) → question text, not FET', () => {
    expect(shouldShowFet(inputs({ verdictEarnedReveal: false }))).toBe(false);
    expect(shouldShowFet(inputs({}))).toBe(false); // field absent (undefined) behaves as false
  });

  it('a same-session Previous-revisit still suppresses the FET even when the verdict is earned', () => {
    // The revisit guard runs BEFORE the verdictEarnedReveal branch is ever
    // reached — this is the regression this fix must never reintroduce: a
    // rehydrated earned verdict must not leak the FET into a plain revisit.
    expect(shouldShowFet(inputs({
      isNavigatingToPrevious: true, interactedThisVisit: false, verdictEarnedReveal: true,
    }))).toBe(false);
  });

  it('deriveHeadingHtml renders the restored FET text on a cold reload', () => {
    const FET = 'Option 1 is correct because change detection keeps the view in sync.';
    const html = deriveHeadingHtml(inputs({ verdictEarnedReveal: true, fetHtml: FET }));
    expect(html).toBe(FET);
  });

  it('cold reload with an earned verdict but no FET text yet falls back to the question', () => {
    const html = deriveHeadingHtml(inputs({ verdictEarnedReveal: true, fetHtml: '   ' }));
    expect(html).toBe(base.questionHtml);
  });

  // `_hasUserInteracted` (quizstate.service.ts) IS persisted across a reload,
  // unlike the live selection map `isSingleAnswered`/`isMultiAnswerComplete`
  // are computed from. A correctly-answered (not timed-out) question reloads
  // with `hasInteracted: true` (stale-true from storage) but the completion
  // signals false (nothing currently selected) — the earned verdict must
  // still win, or a normal answered question loses its FET on refresh too.
  it('reload with stale hasInteracted=true but an earned verdict → FET still restores', () => {
    expect(shouldShowFet(inputs({
      hasInteracted: true, isSingleAnswered: false, verdictEarnedReveal: true,
    }))).toBe(true);
    expect(shouldShowFet(inputs({
      isMultiAnswer: true, hasInteracted: true, isMultiAnswerComplete: false, verdictEarnedReveal: true,
    }))).toBe(true);
  });

  it('reload with stale hasInteracted=true and NO earned verdict → still no FET', () => {
    expect(shouldShowFet(inputs({
      hasInteracted: true, isSingleAnswered: false, verdictEarnedReveal: false,
    }))).toBe(false);
  });
});
