import { test, expect, Page } from '@playwright/test';

import { diQuiz, correctIndicesForHeading, HEADING, NEXT_BTN, PREV_BTN } from './helpers';

/**
 * "Answered ✓" MEANS COMPLETED, NOT MERELY ATTEMPTED.
 *
 * ── The regression this pins ──────────────────────────────────────
 *
 * One click on a three-correct multi-answer question made it report
 * "Answered ✓ Click Next to continue..." on every later revisit, for the rest
 * of the session.
 *
 * The message branch read
 *
 *     remainingCorrectFromVerdict(index) ?? (totalCorrect - selectedCorrect)
 *
 * The verdict answers null while `/check` is in flight — always the case at
 * click time under the API adapter — so the fallback decided it. API-sourced
 * options carry no `correct` flag, so `totalCorrect` and `selectedCorrect` were
 * both 0, and `0 - 0 === 0` satisfied "all correct answers selected".
 *
 * That emitted the Next-button message, and `pushMessage` records ANY
 * Next/Show-Results message into `_completedIdxSet` — the set the revisit
 * derivation reads. A transient wrong message therefore became a permanent
 * false claim of completion.
 *
 * ── Why these assert the MESSAGE and not internal state ───────────
 *
 * The defect was invisible live: the verdict landed a moment later and
 * corrected the displayed text, so only the REVISIT exposed it. Every case
 * below therefore navigates away and back, which is the only place the
 * completion record is observable.
 */

const MSG = '.instructions-message';
const ANSWERED = 'Answered ✓ Click Next to continue...';

/** Away and back — the only view that reads the completion record. */
async function roundTrip(page: Page): Promise<void> {
  await page.locator(NEXT_BTN).click();
  await page.locator('.option-row').first().waitFor({ state: 'visible' });
  await page.waitForTimeout(500);
  await page.locator(PREV_BTN).click();
  await page.locator('.option-row').first().waitFor({ state: 'visible' });
}

async function openDiMulti(page: Page): Promise<number[]> {
  await page.goto('/quiz/question/dependency-injection/3');
  await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 30_000 });
  const heading = (await page.locator(HEADING).first().textContent()) ?? '';
  const correct = correctIndicesForHeading(diQuiz, heading);
  expect(correct.length, 'fixture must be a 3-correct question').toBe(3);
  return correct;
}

test.describe('revisit reports completion, not attempts', () => {
  test('single-answer answered CORRECTLY reports Answered', async ({ page }) => {
    await page.goto('/quiz/question/typescript/1');
    await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 30_000 });

    await page.locator('.option-row').nth(0).click();   // ':' is correct
    await expect(page.locator(MSG)).toHaveText(
      'Please click the Next button to continue.', { timeout: 15_000 }
    );

    await roundTrip(page);
    await expect(page.locator(MSG)).toHaveText(ANSWERED, { timeout: 15_000 });
  });

  test('single-answer answered WRONGLY does NOT report Answered', async ({ page }) => {
    await page.goto('/quiz/question/typescript/1');
    await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 30_000 });

    await page.locator('.option-row').nth(1).click();   // ';' is wrong
    await expect(page.locator(MSG)).toHaveText(
      'Please select the correct answer to continue.', { timeout: 15_000 }
    );

    await roundTrip(page);
    await expect(page.locator(MSG)).not.toHaveText(ANSWERED, { timeout: 15_000 });
  });

  test('multi-answer PARTIALLY answered does NOT report Answered', async ({ page }) => {
    const correct = await openDiMulti(page);

    // ONE of three. This is the exact regression: before the fix, this single
    // click recorded the question as completed for the rest of the session.
    await page.locator('.option-row').nth(correct[0]).click();
    await expect(page.locator(MSG)).toContainText(/Select \d+ more correct answer/, { timeout: 15_000 });

    await roundTrip(page);
    await expect(page.locator(MSG)).not.toHaveText(ANSWERED, { timeout: 15_000 });
  });

  test('multi-answer FULLY answered reports Answered', async ({ page }) => {
    const correct = await openDiMulti(page);

    for (const ci of correct) {
      await page.locator('.option-row').nth(ci).click({ timeout: 10_000 });
      await page.waitForTimeout(700);
    }
    // Proves every correct option actually registered — without this the test
    // can pass while still partial, which is how the original diagnosis nearly
    // recorded a false negative.
    await expect(page.locator(MSG)).toHaveText(
      'Please click the Next button to continue.', { timeout: 15_000 }
    );

    await roundTrip(page);
    await expect(page.locator(MSG)).toHaveText(ANSWERED, { timeout: 15_000 });
  });

  test('WRONG first, then completed correctly, still reports Answered', async ({ page }) => {
    const correct = await openDiMulti(page);
    const wrong = [0, 1, 2, 3].filter((i) => !correct.includes(i));

    await page.locator('.option-row').nth(wrong[0]).click();
    await page.waitForTimeout(700);
    for (const ci of correct) {
      await page.locator('.option-row').nth(ci).click({ timeout: 10_000 }).catch(() => {
        // a completed question may lock remaining options; the assertion below
        // is what decides the outcome.
      });
      await page.waitForTimeout(700);
    }

    await roundTrip(page);
    // A wrong pick along the way must not deny credit for finishing.
    await expect(page.locator(MSG)).toHaveText(ANSWERED, { timeout: 15_000 });
  });
});

test.describe('multi-answer selection painting', () => {
  /**
   * correct → incorrect → correct on a 3-correct question.
   *
   * The unselected third correct option must stay NEUTRAL: revealing it early
   * would hand the user an answer they have not earned, which is the disclosure
   * the whole verdict migration exists to prevent.
   */
  test('selected correct stay green, wrong is red, unselected correct stays neutral', async ({ page }) => {
    const correct = await openDiMulti(page);
    const wrong = [0, 1, 2, 3].filter((i) => !correct.includes(i));
    const rows = page.locator('.option-row');

    await rows.nth(correct[0]).click();
    await expect(rows.nth(correct[0])).toHaveClass(/correct-option/, { timeout: 15_000 });

    await rows.nth(wrong[0]).click();
    await expect(rows.nth(wrong[0])).toHaveClass(/incorrect-option/, { timeout: 15_000 });
    // The first correct pick keeps its green through the wrong click.
    await expect(rows.nth(correct[0])).toHaveClass(/correct-option/);

    await rows.nth(correct[1]).click();
    await expect(rows.nth(correct[1])).toHaveClass(/correct-option/, { timeout: 15_000 });
    await expect(rows.nth(correct[0])).toHaveClass(/correct-option/);

    // The correct option the user has NOT selected is still unrevealed.
    await expect(rows.nth(correct[2])).not.toHaveClass(/correct-option/);
    await expect(rows.nth(correct[2])).not.toHaveClass(/incorrect-option/);
  });
});
