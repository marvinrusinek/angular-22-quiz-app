import { test, expect, Page } from '@playwright/test';

import { HEADING, quizData, correctIndicesForHeading } from './helpers';

/**
 * RESTARTING A QUIZ STARTS A NEW RUN, NOT A REPLAY OF THE OLD ONE.
 *
 * ── The regressions this pins ─────────────────────────────────────
 *
 * Completing a quiz, then pressing "Restart Quiz" on Results, produced a
 * question 1 that was already finished before the user touched it:
 *
 *   message   "Answered ✓ Click Next to continue..."
 *   timer     0:00, and not running
 *
 * Both came from the completed run's state outliving the restart, and both were
 * the same shape of defect: the Results button hand-rolls its own reset
 * sequence and had never been given two cleanup calls the in-quiz restart
 * already makes through `QuizResetService.performRestartServiceResets`.
 *
 *   timer    the SIGNED DEADLINE for q1 survived. `startTimerUntil` measured a
 *            deadline that had expired during the first run, computed zero
 *            seconds remaining and called `expireImmediately()`.
 *
 *   message  the VERDICT for q1 survived as resolved+correct.
 *            `isQuestionCompleted` derives completion from that and memoizes
 *            it, so clearing the memo (which restart already did) achieved
 *            nothing — the next query rebuilt it from the old run.
 *
 * ── Why this drives the real button ───────────────────────────────
 *
 * An earlier investigation reproduced stale state by navigating straight to
 * `/quiz/question/<id>/1`, which is not a route a user can reach — a completed
 * quiz's tile goes to Results. That made the finding unusable. Everything here
 * goes through the UI: tile, intro, the questions, Show Results, and the actual
 * Restart Quiz button.
 *
 * Uses `router` (7 questions, no multi-answer) so completing the quiz fits a
 * test budget: a partial multi-answer keeps Next locked.
 */

test.describe.configure({ timeout: 420_000 });

const ROW = '.option-row';
const TIMER = '.scoreboard-timer .scoreboard';
const MSG = '.instructions-message';
const NEXT = '.nav-btn[aria-label="Next Question"]';
const PREV = '.nav-btn[aria-label="Previous Question"]';
const RESULTS_BTN = '.show-results-btn';
const TILE = '.quiz-tile';
const ANSWERED = 'Answered ✓ Click Next to continue...';

const routerQuiz = (quizData as any[]).find((q) => (q.quizId || q.id) === 'router');

/** "0:29" -> 29 */
async function timerSeconds(page: Page): Promise<number> {
  const raw = ((await page.locator(TIMER).first().textContent({ timeout: 5000 }).catch(() => '')) ?? '').trim();
  const m = raw.match(/(\d+):(\d+)/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
}

async function dirtyRows(page: Page): Promise<string[]> {
  return page.locator(ROW).evaluateAll((els: Element[]) =>
    els.map((el, i) => ({ i, c: el.className || '' }))
      .filter((r) => /\bselected\b|correct-option|incorrect-option|disabled-option|highlighted/.test(r.c))
      .map((r) => String(r.i))
  );
}

async function startRouterViaUi(page: Page): Promise<void> {
  await page.goto('/quiz');
  await page.locator(TILE).first().waitFor({ state: 'visible', timeout: 30_000 });
  const tile = page.locator(TILE).filter({ hasText: /router/i }).first();
  await tile.scrollIntoViewIfNeeded();
  await tile.click();
  await page.waitForTimeout(1200);
  const start = page.locator('.start-btn').first();
  if (await start.count() > 0) await start.click().catch(() => {});
  await page.locator(ROW).first().waitFor({ state: 'visible', timeout: 30_000 });
}

/** Answer every question correctly and land on Results. */
async function completeRouter(page: Page): Promise<void> {
  for (let q = 0; q < 8; q++) {
    await page.locator(ROW).first().waitFor({ state: 'visible', timeout: 8000 });
    const heading = (await page.locator(HEADING).first().textContent()) ?? '';
    const correct = correctIndicesForHeading(routerQuiz, heading);
    for (const c of (correct.length ? correct : [0])) {
      await page.locator(ROW).nth(c).click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(800);
    }
    await page.waitForTimeout(400);

    if (await page.locator(RESULTS_BTN).first().isVisible().catch(() => false)) {
      await page.locator(RESULTS_BTN).first().click();
      await page.waitForTimeout(3000);
      return;
    }
    await page.locator(NEXT).first().click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(600);
  }
}

async function pressRestart(page: Page): Promise<void> {
  const restart = page.locator('[title="restart"]').first();
  await restart.scrollIntoViewIfNeeded();   // the Results controls sit below the fold
  await page.waitForTimeout(500);
  await restart.click();
  await page.locator(ROW).first().waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForTimeout(1800);
}

test.describe('Results -> Restart Quiz starts a genuinely new run', () => {
  test('question 1 is not already answered, and its timer runs', async ({ page }) => {
    await startRouterViaUi(page);
    await completeRouter(page);
    await pressRestart(page);

    // ── the message must not claim the question is finished ──────
    await expect(page.locator(MSG)).not.toHaveText(ANSWERED, { timeout: 10_000 });

    // ── nothing from the completed run may be painted ────────────
    expect(await dirtyRows(page), 'no option carries state from the old run').toEqual([]);

    // ── the timer must be fresh AND moving ───────────────────────
    const first = await timerSeconds(page);
    expect(first, 'timer starts near the full question duration').toBeGreaterThan(20);

    await page.waitForTimeout(3000);
    const second = await timerSeconds(page);
    // Was 0:00 and frozen: the restarted question resumed against the previous
    // run's expired deadline instead of receiving a new one.
    expect(second, 'timer is counting down, not frozen').toBeLessThan(first);
    expect(second, 'timer is not stuck at zero').toBeGreaterThan(0);
  });

  test('the restarted run answers, advances and revisits normally', async ({ page }) => {
    await startRouterViaUi(page);
    await completeRouter(page);
    await pressRestart(page);

    // q1 answers normally
    const heading = (await page.locator(HEADING).first().textContent()) ?? '';
    const correct = correctIndicesForHeading(routerQuiz, heading);
    const pick = correct.length ? correct[0] : 0;
    await page.locator(ROW).nth(pick).click({ timeout: 8000 });
    await expect(page.locator(ROW).nth(pick)).toHaveClass(/correct-option/, { timeout: 15_000 });

    // q2 is fresh — not carried over from the completed run
    await page.locator(NEXT).first().click();
    await page.locator(ROW).first().waitFor({ state: 'visible' });
    await page.waitForTimeout(1800);
    await expect(page.locator(MSG)).not.toHaveText(ANSWERED, { timeout: 10_000 });
    expect(await dirtyRows(page), 'question 2 starts clean').toEqual([]);

    const q2 = await timerSeconds(page);
    expect(q2, 'question 2 also gets a fresh timing window').toBeGreaterThan(20);

    // revisiting q1 restores the answer from THIS run
    await page.locator(PREV).first().click();
    await page.locator(ROW).first().waitFor({ state: 'visible' });
    await page.waitForTimeout(1800);
    await expect(page.locator(ROW).nth(pick)).toHaveClass(/correct-option/, { timeout: 10_000 });
  });
});
