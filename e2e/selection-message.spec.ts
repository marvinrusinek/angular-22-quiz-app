import { test, expect, Page } from '@playwright/test';

import { NEXT_BTN, PREV_BTN } from './helpers';

/**
 * The single-answer selection-message lifecycle.
 *
 * ── The regression this pins ──────────────────────────────────────
 *
 * Selecting the CORRECT option displayed "Please select the correct answer to
 * continue." — the wrong-answer instruction — and kept displaying it across
 * Next → Previous and later revisits.
 *
 * Two independent causes, both needed for the fix:
 *
 *   1. The single-answer branch classified the click with the LOCAL
 *      `isOptionCorrect(option)`. API-sourced options carry no `correct`
 *      property at all, so every selection read as wrong. (The multi-answer
 *      branch had already migrated to the verdict; this one had not.)
 *   2. It ran while the verdict phase was still `checking`. Under the live API
 *      adapter that is ALWAYS the phase at click time, so simply swapping the
 *      source would still have classified against a verdict that did not exist
 *      yet. The message has to be recomputed when the verdict ARRIVES.
 *
 * These specs assert the user-visible contract of both halves. The existing
 * suite asserted highlighting and explanations on these same clicks but never
 * the message, which is why the regression shipped through a green suite.
 */

const MSG = '.instructions-message';
const CHECKING = 'Checking…';
const NEXT_MSG = 'Please click the Next button to continue.';
const WRONG_MSG = 'Please select the correct answer to continue.';
/**
 * Revisiting an ALREADY-ANSWERED question shows its own message rather than the
 * live one — a deliberate contract, pinned since before this work by
 * `selection-message.integration.spec.ts` ("revisit-derivation: ... completed-set
 * drives 'Answered ✓ Click Next...'"). The regression guard on a revisit is
 * therefore "not the WRONG-answer instruction", not "still the live instruction".
 */
const ANSWERED_MSG = 'Answered ✓ Click Next to continue...';

async function gotoQuestion(page: Page, quiz: string, n: number): Promise<void> {
  await page.goto(`/quiz/question/${quiz}/${n}`);
  await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 30_000 });
}

/**
 * Hold the /check response open so the in-flight state can be asserted.
 *
 * Returns a `release` that lets the real request proceed. The verdict still
 * comes from the real backend — only its ARRIVAL is gated, so "Checking…" is
 * observed deterministically rather than by racing a sleep against the network.
 */
async function gateCheck(page: Page): Promise<() => void> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));

  await page.route('**/quizzes/*/check', async (route) => {
    await gate;
    await route.continue();
  });

  return release;
}

test.describe('single-answer selection message', () => {
  test('a correct click ends on the Next-button instruction', async ({ page }) => {
    await gotoQuestion(page, 'typescript', 1);

    await page.locator('.option-row').nth(0).click();  // ':' is correct

    await expect(page.locator(MSG)).toHaveText(NEXT_MSG, { timeout: 15_000 });
  });

  test('a correct click shows Checking… while the verdict is in flight', async ({ page }) => {
    await gotoQuestion(page, 'typescript', 1);
    const release = await gateCheck(page);

    await page.locator('.option-row').nth(0).click();

    // The verdict cannot have arrived — its response is still held.
    await expect(page.locator(MSG)).toHaveText(CHECKING, { timeout: 15_000 });

    release();

    await expect(page.locator(MSG)).toHaveText(NEXT_MSG, { timeout: 15_000 });
  });

  test('NO wrong-answer instruction appears while the verdict is pending', async ({ page }) => {
    await gotoQuestion(page, 'typescript', 1);
    const release = await gateCheck(page);

    await page.locator('.option-row').nth(0).click();
    await expect(page.locator(MSG)).toHaveText(CHECKING, { timeout: 15_000 });

    // The exact regression: a correct pick classified as wrong because the
    // check had not come back yet. Pending must never read as incorrect.
    await expect(page.locator(MSG)).not.toHaveText(WRONG_MSG);

    release();
    await expect(page.locator(MSG)).toHaveText(NEXT_MSG, { timeout: 15_000 });
  });

  test('a wrong click ends on the select-correct instruction', async ({ page }) => {
    await gotoQuestion(page, 'typescript', 1);

    await page.locator('.option-row').nth(1).click();  // ';' is wrong

    await expect(page.locator(MSG)).toHaveText(WRONG_MSG, { timeout: 15_000 });
  });

  test('a wrong click also passes through Checking…', async ({ page }) => {
    await gotoQuestion(page, 'typescript', 1);
    const release = await gateCheck(page);

    await page.locator('.option-row').nth(1).click();

    await expect(page.locator(MSG)).toHaveText(CHECKING, { timeout: 15_000 });

    release();

    await expect(page.locator(MSG)).toHaveText(WRONG_MSG, { timeout: 15_000 });
  });
});

test.describe('selection message survives revisit', () => {
  test('Next then Previous shows the answered message, never the wrong-answer one', async ({ page }) => {
    await gotoQuestion(page, 'typescript', 1);

    await page.locator('.option-row').nth(0).click();
    await expect(page.locator(MSG)).toHaveText(NEXT_MSG, { timeout: 15_000 });

    await page.locator(NEXT_BTN).click();
    await page.locator('.option-row').first().waitFor({ state: 'visible' });

    await page.locator(PREV_BTN).click();

    // A correctly-answered question must never come back as "select the
    // correct answer" — that was the regression, and it persisted across
    // exactly this navigation.
    await expect(page.locator(MSG)).toHaveText(ANSWERED_MSG, { timeout: 15_000 });
    await expect(page.locator(MSG)).not.toHaveText(WRONG_MSG);
  });

  test('a second revisit still never shows the wrong-answer instruction', async ({ page }) => {
    await gotoQuestion(page, 'typescript', 1);

    await page.locator('.option-row').nth(0).click();
    await expect(page.locator(MSG)).toHaveText(NEXT_MSG, { timeout: 15_000 });

    for (let round = 0; round < 2; round++) {
      await page.locator(NEXT_BTN).click();
      await page.locator('.option-row').first().waitFor({ state: 'visible' });
      await page.locator(PREV_BTN).click();
      await expect(page.locator(MSG)).toHaveText(ANSWERED_MSG, { timeout: 15_000 });
      await expect(page.locator(MSG)).not.toHaveText(WRONG_MSG);
    }
  });

  test('an unanswered question asks for a selection, not a correction', async ({ page }) => {
    await gotoQuestion(page, 'typescript', 1);

    await page.locator('.option-row').nth(0).click();
    await expect(page.locator(MSG)).toHaveText(NEXT_MSG, { timeout: 15_000 });

    await page.locator(NEXT_BTN).click();
    await page.locator('.option-row').first().waitFor({ state: 'visible' });

    // Nothing selected on this question yet — it must not inherit either the
    // previous question's message or a wrong-answer verdict.
    await expect(page.locator(MSG)).not.toHaveText(NEXT_MSG, { timeout: 15_000 });
    await expect(page.locator(MSG)).not.toHaveText(WRONG_MSG);
    await expect(page.locator(MSG)).not.toHaveText(ANSWERED_MSG);
  });
});
