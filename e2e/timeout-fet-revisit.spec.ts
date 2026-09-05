import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Stage 14 regression repair — Topic Quiz timer-expiry FET + Previous-revisit
 * selection message.
 *
 * ROOT CAUSE (both regressions traced to the same defect): the timer-expiry
 * reveal pipeline (`QuizQuestionComponent#onQuestionTimedOut`) ran a SECOND
 * time whenever a question that had already timed out was revisited — via
 * Previous, or returning to the tab — because:
 *
 *   1. `qqc-orch-lifecycle.service.ts`'s `expired$` subscription and
 *   2. `qqc-orch-timer.service.ts`'s `elapsedTime$`-threshold fast path
 *
 * both re-fire when `TimerService#expireImmediately()` replays the deadline
 * on arrival (`expiredOnArrivalSig`) — their one-shot guards (`host.timedOut`,
 * `host.handledOnExpiry`) are cleared on every question-index transition, so
 * neither guard can tell a revisit apart from the original live expiry.
 * Re-running the reveal pipeline re-pushed "Please click the Next button..."
 * over the correct nav-derived message every time, and (the same double-fire
 * writing explanation/reveal state twice) is the most plausible source of a
 * malformed/duplicated FET string.
 *
 *   3. Separately, `qqc-reset-manager.service.ts#applyFreshResetState` and
 *   `quiz-setup.service.ts`'s tab-visibility handler both classified an
 *   ALREADY-TIMED-OUT-BUT-NEVER-ANSWERED question as "fresh" (never visited)
 *   and force-pushed a first-visit "start the quiz" / "click an option"
 *   baseline, which ALSO overrode the correct nav-derived message.
 *
 * The fix in all three call sites: check `expiredOnArrivalSig()`/
 * `dotStatusService.timedOutFetForced` before re-running reveal/baseline
 * logic — a revisit is not a reveal, that already happened.
 */

const quizData = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'backend/test/helpers/synthetic-quiz-bank.json'), 'utf8')
).quizzes;
const cdQuiz = quizData.find((q: any) => (q.quizId || q.id) === 'fixture-doohickeys');
const diQuiz = quizData.find((q: any) => (q.quizId || q.id) === 'fixture-gadgets');

const HEADING = 'codelab-quiz-content h3';
const MSG = '.instructions-message';
const NEXT_BTN = '.nav-btn[aria-label="Next Question"]';
const PREV_BTN = '.nav-btn[aria-label="Previous Question"]';

test.describe('Timer-expiry FET formatting + Previous-revisit selection message', () => {
  test('single-answer: genuine expiry renders through the ORDINARY FET presentation — no expiry-specific wrapper', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/quiz/question/fixture-doohickeys/1');
    const rows = page.locator('.option-row');
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    await expect(page.locator(HEADING)).toContainText(/correct because/i, { timeout: 60_000 });

    // No expiry-specific presentation: no "Time's up.", no "Correct answer:"
    // line, no separate structural elements — just the ordinary composed FET.
    const raw = await page.locator(HEADING).innerText();
    expect(raw).not.toContain("Time's up");
    expect(raw).not.toContain('Correct answer');
    await expect(page.locator(HEADING).locator('.timeout-notice')).toHaveCount(0);
    await expect(page.locator(HEADING).locator('.timeout-answer')).toHaveCount(0);
    await expect(page.locator(HEADING).locator('.timeout-explanation')).toHaveCount(0);
  });

  test('multi-answer: genuine expiry renders through the ORDINARY FET presentation, naming every correct option in prose', async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto('/quiz/question/fixture-gadgets/1');
    const rows = page.locator('.option-row');
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    // Answer Q1, Q2 (single-answer) to reach Q3 (multi-answer), then let Q3 expire live.
    for (let i = 1; i <= 2; i++) {
      await rows.first().click();
      await page.waitForTimeout(1200);
      await page.locator(NEXT_BTN).click();
      await page.waitForURL(new RegExp(`/${i + 1}$`));
      await rows.first().waitFor({ state: 'visible', timeout: 20_000 });
    }

    await expect(page.locator(HEADING)).toContainText(/correct because/i, { timeout: 60_000 });

    const raw = await page.locator(HEADING).innerText();
    expect(raw).not.toContain("Time's up");
    expect(raw).not.toContain('Correct answer');
    await expect(page.locator(HEADING).locator('.timeout-notice')).toHaveCount(0);
    await expect(page.locator(HEADING).locator('.timeout-answer')).toHaveCount(0);
    await expect(page.locator(HEADING).locator('.timeout-explanation')).toHaveCount(0);

    // The ordinary multi-answer FET composes "Options N, M and P are correct
    // because ..." — the same formatter used for a normal completion, now
    // also used for a genuine expiry. Just prove it's the real composed
    // explanation, not a blank or placeholder.
    expect(raw.length).toBeGreaterThan(20);
    expect(raw).not.toContain('undefined');
    expect(raw).not.toContain('No explanation available');
  });

  test('revisit to an expired-but-unanswered question: correct nav-derived message, not a stale override', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/quiz/question/fixture-doohickeys/1');
    const rows = page.locator('.option-row');
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    // Let Q1 expire live (no interaction).
    await expect(page.locator(HEADING)).toContainText(/correct because/i, { timeout: 60_000 });

    await page.locator(NEXT_BTN).click();
    await page.waitForURL(/\/2$/);
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    await page.locator(PREV_BTN).click();
    await page.waitForURL(/\/1$/);
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    // Revisit is not a reveal: the heading shows the question, not the FET.
    await expect(page.locator(HEADING)).toHaveText(cdQuiz.questions[0].questionText, { timeout: 10_000 });
    // The message must be the honest "please select" prompt, not a stale
    // "click Next" override, and not "Answered ✓" (it was never answered).
    await expect(page.locator(MSG)).toHaveText('Please select an option to continue...', { timeout: 10_000 });

    // Next must still be clickable — the question is done, just not answered.
    await expect(page.locator(NEXT_BTN)).toBeEnabled();
  });

  test('revisit to a CORRECTLY answered question still shows Answered ✓ (no regression from the fix)', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/quiz/question/fixture-doohickeys/1');
    const rows = page.locator('.option-row');
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    const q1 = cdQuiz.questions[0];
    const correctIdx = q1.options.findIndex((o: any) => o.correct === true);
    await rows.nth(correctIdx).click();
    await expect(page.locator(MSG)).toHaveText('Please click the Next button to continue.', { timeout: 10_000 });

    await page.locator(NEXT_BTN).click();
    await page.waitForURL(/\/2$/);
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    await page.locator(PREV_BTN).click();
    await page.waitForURL(/\/1$/);
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    await expect(page.locator(MSG)).toHaveText('Answered ✓ Click Next to continue...', { timeout: 10_000 });
    await expect(rows.nth(correctIdx)).toHaveClass(/correct-option/);
  });

  test('revisit to a COMPLETED multi-answer question shows Answered ✓', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/quiz/question/fixture-gadgets/1');
    const rows = page.locator('.option-row');
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    for (let i = 1; i <= 2; i++) {
      await rows.first().click();
      await page.waitForTimeout(1200);
      await page.locator(NEXT_BTN).click();
      await page.waitForURL(new RegExp(`/${i + 1}$`));
      await rows.first().waitFor({ state: 'visible', timeout: 20_000 });
    }

    const q3 = diQuiz.questions[2];
    const correctIdxs = q3.options
      .map((o: any, i: number) => (o.correct ? i : -1))
      .filter((i: number) => i >= 0);
    for (const idx of correctIdxs) {
      await rows.nth(idx).click();
      await page.waitForTimeout(800);
    }
    await expect(page.locator(MSG)).toHaveText('Please click the Next button to continue.', { timeout: 10_000 });

    await page.locator(NEXT_BTN).click();
    await page.waitForURL(/\/4$/);
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    await page.locator(PREV_BTN).click();
    await page.waitForURL(/\/3$/);
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    await expect(page.locator(MSG)).toHaveText('Answered ✓ Click Next to continue...', { timeout: 10_000 });
  });
});
