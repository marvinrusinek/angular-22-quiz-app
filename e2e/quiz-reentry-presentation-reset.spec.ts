import { test, expect, Page } from '@playwright/test';
import { HEADING } from './helpers';

/**
 * THE REGRESSION (two symptoms, one shared root cause):
 *
 *   3. Re-entering a Topic Quiz (QuizSelection -> Intro -> Start Quiz) showed
 *      the STALE FET for a question answered correctly in an earlier visit,
 *      even though the user was simply landing on it again, not living
 *      through the completion that earned it.
 *   4. On that same re-entry, navigating to a fresh, never-answered question
 *      could show "Answered [checkmark] Click Next to continue..." — a
 *      PREVIOUS question's completion state leaking onto a question the user
 *      has never touched.
 *
 * ── Root cause ──────────────────────────────────────────────────────
 *
 * Every OTHER way of arriving at a question (Next, Previous, a dot) already
 * runs through `QuizNavigationService#navigateToQuestion`, which marks the
 * arrival as exactly that -- an arrival, not a live completion -- by setting
 * `isNavigatingToPreviousSig` and clearing `interactedThisVisit` for the
 * target index. `heading-inputs.ts`'s `shouldShowFet` already has a guard for
 * this (`isNavigatingToPrevious && !interactedThisVisit`) that correctly
 * suppresses the FET on a Next -> Previous revisit of an earned question.
 *
 * A fresh quiz-entry (`QuizNavigationService#resetUIAndNavigate`, the
 * chokepoint Introduction's "Start the Quiz!" button calls) NEVER set either
 * flag -- it looked like neither a revisit nor a live answer, so
 * `verdictEarnedReveal` (the durable-verdict-backed reveal authority, which
 * correctly and deliberately survives refresh) was the only signal left, and
 * it doesn't know the difference between "the user just refreshed while
 * looking at this FET" and "the user is walking back into the quiz from the
 * selection screen" -- both look identical to a fact that's merely durable.
 *
 * Fixed by having `resetUIAndNavigate` set the exact same two flags
 * `navigateToQuestion` already sets, treating quiz re-entry as the same kind
 * of arrival Next/Previous/a dot already are.
 *
 * ── Revised: re-entry ALSO clears durable completion (see the sibling
 *    multi-answer-incremental-highlight.spec.ts regression) ─────────────
 *
 * The first cut of this fix left durable completion/verdict state (`_ques
 * tionResolved` / `_multiAnswerCompletion` / `_multiAnswerPerfect`, and the
 * `QuestionVerdictService` store) untouched by re-entry, reasoning that only
 * the LIVE reveal needed to reset. That surfaced a worse bug: those
 * authorities survive a mere re-entry, so completing a multi-answer question
 * once, leaving to QuizSelection, and re-entering the SAME quiz left the
 * OLD completion in place for the new attempt -- `getRevisitOptionClasses`
 * (unconditional) then painted a single fresh pick as if the whole question
 * were already resolved, revealing every correct option immediately.
 *
 * `resetUIAndNavigate`'s "fresh start guard" already resets score and
 * selections unconditionally on every Q1 entry -- that pre-existing intent
 * (leaving to Selection always begins a clean attempt) now extends to
 * completion/verdict state too, for the same reason. So on re-entry Q1
 * (and every question) reads as genuinely UNANSWERED again: question text,
 * Next disabled, no "Answered" message, until re-answered in this attempt.
 */

async function answerFirstQuestionCorrectly(page: Page): Promise<void> {
  await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 30000 });
  const rows = page.locator('.option-row');
  const n = await rows.count();
  for (let i = 0; i < n; i++) {
    await rows.nth(i).click({ timeout: 15000 });
    await page.waitForTimeout(1000);
    const msg = await page.locator('.instructions-message').textContent();
    if (msg?.includes('Next button')) return;
  }
  throw new Error('could not find the correct option on Q1');
}

async function enterQuizFromSelection(page: Page, tileNameSubstring: string): Promise<void> {
  await page.locator('.quiz-tile:not(.interview-tile)').first().waitFor({ state: 'visible', timeout: 30000 });
  await page.locator('.quiz-tile:not(.interview-tile)', { hasText: tileNameSubstring }).first()
    .click({ timeout: 15000 });
  await page.locator('.start-btn').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('.start-btn').click({ timeout: 15000 });
  await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 30000 });
}

test.describe('Quiz re-entry starts a genuinely fresh attempt (presentation AND completion state reset)', () => {
  test('CASE A: a genuine browser refresh WHILE viewing an earned FET restores the FET', async ({ page }) => {
    await page.goto('/select');
    await enterQuizFromSelection(page, 'Fixture Widgets');
    await answerFirstQuestionCorrectly(page);
    await page.waitForTimeout(500);

    const headingBeforeRefresh = await page.locator(HEADING).first().innerHTML();
    expect(headingBeforeRefresh).not.toBe('Which widget size is the smallest?');

    await page.reload();
    await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 30000 });
    await page.waitForTimeout(500);

    const headingAfterRefresh = await page.locator(HEADING).first().innerHTML();
    expect(headingAfterRefresh, 'a genuine refresh while on the FET must restore it').toBe(headingBeforeRefresh);
  });

  test('CASE B: leaving to QuizSelection and re-entering the SAME quiz shows Q1 question text, not the stale FET', async ({ page }) => {
    await page.goto('/select');
    await enterQuizFromSelection(page, 'Fixture Widgets');
    await answerFirstQuestionCorrectly(page);
    await page.waitForTimeout(500);

    // Leave via the real in-app header link, not a hard navigation.
    await page.locator('a[matTooltip="Back to Codelab Quiz Selection"]').click({ timeout: 15000 });
    await page.locator('.quiz-tile:not(.interview-tile)').first().waitFor({ state: 'visible', timeout: 30000 });

    await enterQuizFromSelection(page, 'Fixture Widgets');
    await page.waitForTimeout(500);

    const headingOnReentry = await page.locator(HEADING).first().textContent();
    expect(headingOnReentry, 'Q1 must show QUESTION TEXT on re-entry, not the earlier FET')
      .toBe('Which widget size is the smallest?');

    // RE-ENTRY IS A GENUINELY FRESH ATTEMPT, NOT A REVISIT.
    //
    // "Start the Quiz!" already resets score and selections unconditionally
    // (the pre-existing "fresh start guard" in resetUIAndNavigate) -- the
    // completion/verdict authorities now follow the SAME rule, for the same
    // reason: leaving one question's stale completion state reachable by a
    // fresh attempt is exactly what let a partially-answered LATER question
    // read as already-fully-resolved and paint every correct option green
    // (the over-highlight regression this file's sibling spec pins). Next
    // must therefore be DISABLED again -- Q1 has not been answered in this
    // attempt -- and the message must be the fresh prompt, not "Answered".
    const nextEnabled = await page.locator('.nav-btn[aria-label="Next Question"]').isEnabled();
    expect(nextEnabled, 'Next must be disabled -- re-entry starts a genuinely fresh attempt').toBe(false);

    const msgOnReentry = await page.locator('.instructions-message').textContent();
    expect(msgOnReentry, 'Q1 must read as unanswered after re-entry, not "Answered"')
      .toBe('Please start the quiz by selecting an option.');
  });

  test('a fresh, never-answered question after re-entry shows the normal unanswered prompt, not a leaked "Answered"', async ({ page }) => {
    await page.goto('/select');
    await enterQuizFromSelection(page, 'Fixture Widgets');
    await answerFirstQuestionCorrectly(page);
    await page.waitForTimeout(500);

    await page.locator('a[matTooltip="Back to Codelab Quiz Selection"]').click({ timeout: 15000 });
    await page.locator('.quiz-tile:not(.interview-tile)').first().waitFor({ state: 'visible', timeout: 30000 });

    await enterQuizFromSelection(page, 'Fixture Widgets');
    await page.waitForTimeout(500);

    // Re-entry is a fresh attempt (see CASE B above) -- Q1 must be re-answered
    // before Next unlocks.
    await answerFirstQuestionCorrectly(page);
    await page.waitForTimeout(500);

    await page.locator('.nav-btn[aria-label="Next Question"]').click({ timeout: 15000 });
    await page.waitForTimeout(1000);

    const q2Msg = await page.locator('.instructions-message').textContent();
    expect(q2Msg, 'a never-answered Q2 must not inherit Q1\'s completion message')
      .not.toContain('Answered');
    expect(q2Msg).toBe('Please select an option to continue...');
  });
});
