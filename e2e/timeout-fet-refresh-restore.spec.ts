import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Stage 14 regression repair — refresh after a FET reveal must not lose it.
 *
 * ROOT CAUSE: `shouldShowFet` (heading-model.ts) only ever earned a
 * no-interaction reveal through `isTimedOut`, a LIVE-only `TimerService`
 * signal that resets to false on every reload. A genuine expiry rehydrates
 * correctly into `QuestionVerdictService` on bootstrap (via
 * `rehydrateEarnedVerdicts`, called from `quiz.service.ts` right after
 * `/questions` resolves — the persisted record in `earned-verdict-
 * storage.ts` was never the problem), but the heading's render decision
 * never consulted that restored verdict, so a refresh landed on the
 * question text with the reveal lost.
 *
 * FIX: `HeadingInputs.verdictEarnedReveal` — true when the verdict for this
 * question has EARNED the reveal (expired, or resolved with the completion
 * condition met), whether from a live `/check` this session or restored
 * after a reload. `shouldShowFet` checks it ahead of `hasInteracted` — the
 * existing revisit guard (`isNavigatingToPrevious && !interactedThisVisit
 * && !isTimedOut`) still runs first, so a same-session Previous-revisit is
 * unaffected: it already returns false before `verdictEarnedReveal` is ever
 * consulted. See `heading-inputs-fet-eligibility.spec.ts` for the follow-up
 * fix: the first version of this field read the verdict's raw TERMINAL
 * phase, which also covers a resolved-but-WRONG single-answer pick (the
 * shipped `/check` rule resolves on the first submission, right or wrong) —
 * that regressed incorrect-answer FET suppression until it was narrowed to
 * an actually-EARNED verdict.
 */

const quizData = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'backend/data/quiz.json'), 'utf8')
).quizzes;
const cdQuiz = quizData.find((q: any) => (q.quizId || q.id) === 'change-detection');
const diQuiz = quizData.find((q: any) => (q.quizId || q.id) === 'dependency-injection');

const HEADING = 'codelab-quiz-content h3';
const MSG = '.instructions-message';
const TIMER = '.scoreboard-timer .scoreboard';
const NEXT_BTN = '.nav-btn[aria-label="Next Question"]';
const PREV_BTN = '.nav-btn[aria-label="Previous Question"]';
const RESTART_BTN = '.restart-btn';
const CONFIRM_RESTART_BTN = '.confirm-actions button:has-text("Restart")';

test.describe('Refresh after a legitimate FET reveal restores the FET, from durable verdict state', () => {
  test('1. expire -> FET shows -> refresh -> FET remains (the core fix)', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/quiz/question/change-detection/1');
    const rows = page.locator('.option-row');
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    // Let Q1 expire live (no interaction).
    await expect(page.locator(HEADING)).toContainText(/correct because/i, { timeout: 60_000 });
    const beforeReload = (await page.locator(HEADING).innerText()).trim();
    expect(beforeReload).not.toBe(cdQuiz.questions[0].questionText);

    await page.reload();
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    // The FET must still be showing — restored, not re-earned.
    await expect(page.locator(HEADING)).toContainText(/correct because/i, { timeout: 15_000 });
    const afterReload = (await page.locator(HEADING).innerText()).trim();
    expect(afterReload).not.toBe(cdQuiz.questions[0].questionText);
  });

  test('2. expire -> Next -> Previous still shows the question, not the FET (revisit is not a reveal, unaffected by the fix)', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/quiz/question/change-detection/1');
    const rows = page.locator('.option-row');
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    await expect(page.locator(HEADING)).toContainText(/correct because/i, { timeout: 60_000 });

    await page.locator(NEXT_BTN).click();
    await page.waitForURL(/\/2$/);
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    await page.locator(PREV_BTN).click();
    await page.waitForURL(/\/1$/);
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    await expect(page.locator(HEADING)).toHaveText(cdQuiz.questions[0].questionText, { timeout: 10_000 });
    await expect(page.locator(MSG)).toHaveText('Please select an option to continue...', { timeout: 10_000 });
  });

  test('3. expire -> refresh (FET restored) -> Next -> Previous: still question text, not a leaked FET from the restore', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/quiz/question/change-detection/1');
    const rows = page.locator('.option-row');
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    await expect(page.locator(HEADING)).toContainText(/correct because/i, { timeout: 60_000 });

    await page.reload();
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });
    await expect(page.locator(HEADING)).toContainText(/correct because/i, { timeout: 15_000 });

    await page.locator(NEXT_BTN).click();
    await page.waitForURL(/\/2$/);
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    await page.locator(PREV_BTN).click();
    await page.waitForURL(/\/1$/);
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    await expect(page.locator(HEADING)).toHaveText(cdQuiz.questions[0].questionText, { timeout: 10_000 });
    await expect(page.locator(MSG)).toHaveText('Please select an option to continue...', { timeout: 10_000 });
  });

  test('4. a NORMAL correctly-answered question also restores its FET on refresh (verdictEarnedReveal is not expiry-specific)', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/quiz/question/change-detection/1');
    const rows = page.locator('.option-row');
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    const q1 = cdQuiz.questions[0];
    const correctIdx = q1.options.findIndex((o: any) => o.correct === true);
    await rows.nth(correctIdx).click();
    await expect(page.locator(HEADING)).toContainText(/correct because/i, { timeout: 15_000 });
    const beforeReload = (await page.locator(HEADING).innerText()).trim();

    await page.reload();
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    await expect(page.locator(HEADING)).toContainText(/correct because/i, { timeout: 15_000 });
    const afterReload = (await page.locator(HEADING).innerText()).trim();
    expect(afterReload).toBe(beforeReload);
    // Still no expiry-specific wrapper leaking in from anywhere.
    expect(afterReload).not.toContain("Time's up");
  });

  test('5. an unanswered, not-yet-expired question still shows the question text on refresh', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/quiz/question/change-detection/1');
    const rows = page.locator('.option-row');
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    // Refresh immediately, well before the 30s deadline — no interaction, no expiry.
    await page.reload();
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    await expect(page.locator(HEADING)).toHaveText(cdQuiz.questions[0].questionText, { timeout: 10_000 });
  });

  test('6. restarting the quiz clears the durable expiry/FET state — Q1 is fresh again', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/quiz/question/change-detection/1');
    const rows = page.locator('.option-row');
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    await expect(page.locator(HEADING)).toContainText(/correct because/i, { timeout: 60_000 });

    // The restart button only renders once past Q1 (shouldShowRestartButton
    // requires idx > 0) — advance to Q2 first, same as a real user would.
    await page.locator(NEXT_BTN).click();
    await page.waitForURL(/\/2$/);
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    await page.locator(RESTART_BTN).click();
    await page.locator(CONFIRM_RESTART_BTN).click();
    await page.waitForURL(/\/1$/);
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    await expect(page.locator(HEADING)).toHaveText(cdQuiz.questions[0].questionText, { timeout: 10_000 });
    await expect(page.locator(TIMER)).not.toHaveText('0:00', { timeout: 10_000 });

    // The restarted run's own state must survive a refresh too — a fresh
    // run must not immediately look "expired" again from stale storage.
    await page.reload();
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });
    await expect(page.locator(HEADING)).toHaveText(cdQuiz.questions[0].questionText, { timeout: 10_000 });
  });

  test('7. switching to a different topic quiz does not leak a restored FET into its Q1', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/quiz/question/change-detection/1');
    const rows = page.locator('.option-row');
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    await expect(page.locator(HEADING)).toContainText(/correct because/i, { timeout: 60_000 });
    await page.reload();
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });
    await expect(page.locator(HEADING)).toContainText(/correct because/i, { timeout: 15_000 });

    // Now switch quizzes entirely (in-SPA, not a fresh page.goto reload).
    await page.goto('/quiz/question/dependency-injection/1');
    const diRows = page.locator('.option-row');
    await diRows.first().waitFor({ state: 'visible', timeout: 20_000 });

    await expect(page.locator(HEADING)).toHaveText(diQuiz.questions[0].questionText, { timeout: 10_000 });
  });
});
