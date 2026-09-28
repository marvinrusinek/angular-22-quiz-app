import { test, expect, Page } from '@playwright/test';
import { quizData, correctIndicesForHeading, HEADING, NEXT_BTN, RESULTS_BTN, startQuizViaUi } from './helpers';

/**
 * A FAILED answer check is recoverable — and never a verdict.
 *
 * The first `/check` of the attempt is failed at the network layer (a fast,
 * deterministic stand-in for an outage; the 20 s timeout is covered by the unit
 * tests). The user must be told, keep their selection, be able to resend the SAME
 * answer, and — once verification succeeds — carry on to Results. At no point may
 * the failure reveal correctness.
 *
 * `fixture-thingamajigs`: 12 single-answer questions, so completing it is cheap.
 */
test.describe.configure({ timeout: 300_000 });

const QUIZ_ID = 'fixture-thingamajigs';
const quiz = quizData.find((q: any) => (q.quizId || q.id) === QUIZ_ID);
const ROW = '.option-row';
const NOTICE = '.verdict-notice';
const RETRY = '.verdict-notice__retry';

/** Anything that would be an answer key or a correctness reveal. */
const CORRECTNESS_KEYS = /"correctOptionTexts"|"isCorrect"|"correct"\s*:|"explanation"\s*:/;

async function correctRowFor(page: Page): Promise<number> {
  const heading = (await page.locator(HEADING).first().textContent()) ?? '';
  const [correct] = correctIndicesForHeading(quiz, heading);
  return correct ?? 0;
}

test('a failed /check shows a message, keeps the selection, retries the same answer, and reaches Results', async ({ page }) => {
  const checkBodies: string[] = [];
  const pageJson: string[] = [];        // every JSON body the app received BEFORE the retry
  let failedOnce = false;
  let retrying = false;

  page.on('response', async (response) => {
    if (retrying || !/\/api\//.test(response.url())) return;
    if ((response.headers()['content-type'] ?? '').includes('json')) {
      pageJson.push(await response.text().catch(() => ''));
    }
  });

  await page.route('**/api/quizzes/*/check', async (route) => {
    checkBodies.push(route.request().postData() ?? '');
    if (!failedOnce) {
      failedOnce = true;
      await route.abort('failed');       // the FIRST check never reaches the server
      return;
    }
    await route.continue();
  });

  // Public UI, not a direct goto — this test's own Next-loop to Results
  // needs a real attempt to persist each unlock (Root Cause A, direct-route
  // P1; found via Gate 5's static review — this test's failure in the
  // interrupted full run was masked by the tail-end memory-exhaustion
  // crash, so it was never individually diagnosed until this pass).
  await startQuizViaUi(page, QUIZ_ID, /fixture thingamajigs/i);
  await page.locator(ROW).first().waitFor({ state: 'visible', timeout: 30_000 });

  const picked = await correctRowFor(page);
  const pickedText = ((await page.locator(ROW).nth(picked).locator('.option-text').textContent()) ?? '').trim();
  await page.locator(ROW).nth(picked).click();

  // ── the user is told, in an accessible alert ────────────────────────
  const notice = page.locator(NOTICE);
  await expect(notice).toBeVisible({ timeout: 10_000 });
  await expect(notice).toHaveAttribute('role', 'alert');
  await expect(notice).toContainText(/couldn't verify your answer/i);

  // ── the selection is still there, and nothing was revealed ──────────
  await expect(page.locator(ROW).nth(picked).locator('input')).toBeChecked();
  for (const cls of ['correct-option', 'incorrect-option']) {
    await expect(page.locator(`${ROW}.${cls}`)).toHaveCount(0);
  }
  await expect(page.locator(NEXT_BTN)).toBeDisabled();          // no verdict, so no progression
  expect(checkBodies).toHaveLength(1);

  // No answer key or correctness data reached the page while the check was failed.
  for (const body of pageJson) expect(body, 'no correctness data before a verdict').not.toMatch(CORRECTNESS_KEYS);
  await expect(notice).not.toContainText(pickedText);

  // ── Retry resends the SAME answer, once ─────────────────────────────
  retrying = true;
  const retry = page.locator(RETRY);
  await expect(retry).toBeVisible();
  await retry.focus();
  await expect(retry).toBeFocused();                            // keyboard reachable
  await page.keyboard.press('Enter');

  await expect.poll(() => checkBodies.length, { timeout: 10_000 }).toBe(2);
  expect(JSON.parse(checkBodies[1]).selectedOptionTexts).toEqual(JSON.parse(checkBodies[0]).selectedOptionTexts);
  await page.waitForTimeout(500);
  expect(checkBodies, 'exactly one retry request').toHaveLength(2);

  // ── the successful response restores normal progression ─────────────
  await expect(notice).toHaveCount(0);
  await expect(page.locator(NEXT_BTN)).toBeEnabled({ timeout: 10_000 });

  // ── ...and the user can carry on all the way to Results ─────────────
  const total = quiz.questions.length;
  for (let i = 1; i < total; i++) {
    await page.locator(NEXT_BTN).click();
    await page.locator(ROW).first().waitFor({ state: 'visible', timeout: 15_000 });
    await page.locator(ROW).nth(await correctRowFor(page)).click();
    await expect(page.locator(i === total - 1 ? RESULTS_BTN : NEXT_BTN).first()).toBeEnabled({ timeout: 15_000 });
  }
  await page.locator(RESULTS_BTN).first().click();
  await expect(page).toHaveURL(new RegExp(`/quiz/results/${QUIZ_ID}`), { timeout: 15_000 });
});
