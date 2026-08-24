import { test, expect, Page } from '@playwright/test';

import { diQuiz, correctIndicesForHeading, HEADING, NEXT_BTN, PREV_BTN } from './helpers';

/**
 * THE REMAINING-CORRECT COUNT MUST TRACK EVERY PICK.
 *
 * ── The regression these pin ──────────────────────────────────────
 *
 * On a three-correct question the SECOND correct pick kept rendering
 * "Select 2 more correct answers to continue..." — the count from the FIRST
 * check — and only changed when the question resolved.
 *
 * `computeFinalMessage` runs on the click, while the check for that click is
 * still in flight, so the stored `remainingCorrectCount` answers the PREVIOUS
 * submission. Nothing corrected it afterwards: the recompute subscribed to
 * `terminalVerdicts$`, and an `incomplete` verdict is never terminal, so a
 * multi-answer question in progress never produced an arrival to listen for.
 *
 * ── What the count means ──────────────────────────────────────────
 *
 * CORRECT answers still required — never selections still required. The server
 * computes it as the correct options not yet selected, so an incorrect pick
 * cannot decrement it. That half already worked and is pinned here so it
 * cannot regress while the other half is fixed.
 *
 * ── Current visit vs revisit ──────────────────────────────────────
 *
 * Completing the question NOW ends on the Next-button prompt. "Answered ✓" is
 * the REVISIT message and must not appear on the completing click. These are
 * deliberately different states.
 */

const MSG = '.instructions-message';
const NEXT_MSG = 'Please click the Next button to continue.';
const ANSWERED = 'Answered ✓ Click Next to continue...';

const remainingMsg = (n: number) =>
  `Select ${n} more correct answer${n === 1 ? '' : 's'} to continue...`;

async function openDiMulti(page: Page): Promise<number[]> {
  await page.goto('/quiz/question/dependency-injection/3');
  await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 30_000 });
  const heading = (await page.locator(HEADING).first().textContent()) ?? '';
  const correct = correctIndicesForHeading(diQuiz, heading);
  expect(correct.length, 'fixture must have exactly 3 correct options').toBe(3);
  return correct;
}

const click = (page: Page, i: number) =>
  page.locator('.option-row').nth(i).click({ timeout: 15_000 });

test.describe('multi-answer remaining-correct count', () => {
  test('counts down 2 -> 1 -> complete as each correct answer is picked', async ({ page }) => {
    const correct = await openDiMulti(page);

    await click(page, correct[0]);
    await expect(page.locator(MSG)).toHaveText(remainingMsg(2), { timeout: 15_000 });

    // THE REGRESSION: this stayed at 2 until the question resolved.
    await click(page, correct[1]);
    await expect(page.locator(MSG)).toHaveText(remainingMsg(1), { timeout: 15_000 });

    await click(page, correct[2]);
    await expect(page.locator(MSG)).toHaveText(NEXT_MSG, { timeout: 15_000 });
  });

  test('an INCORRECT pick never decrements the count', async ({ page }) => {
    const correct = await openDiMulti(page);
    const wrong = [0, 1, 2, 3].filter((i) => !correct.includes(i));
    expect(wrong.length, 'fixture must have a wrong option').toBeGreaterThan(0);

    await click(page, correct[0]);
    await expect(page.locator(MSG)).toHaveText(remainingMsg(2), { timeout: 15_000 });

    // Still TWO correct answers outstanding — a wrong pick is not progress.
    await click(page, wrong[0]);
    await expect(page.locator(MSG)).toHaveText(remainingMsg(2), { timeout: 15_000 });

    await click(page, correct[1]);
    await expect(page.locator(MSG)).toHaveText(remainingMsg(1), { timeout: 15_000 });

    // A wrong pick already made does not stop the question completing.
    await click(page, correct[2]);
    await expect(page.locator(MSG)).toHaveText(NEXT_MSG, { timeout: 15_000 });
  });

  test('completing NOW shows the Next prompt, and only a REVISIT shows Answered', async ({ page }) => {
    const correct = await openDiMulti(page);
    for (const c of correct) {
      await click(page, c);
      await page.waitForTimeout(1200);
    }

    // Current visit — deliberately NOT "Answered ✓".
    await expect(page.locator(MSG)).toHaveText(NEXT_MSG, { timeout: 15_000 });

    await page.locator(NEXT_BTN).click();
    await page.locator('.option-row').first().waitFor({ state: 'visible' });
    await page.waitForTimeout(800);
    await page.locator(PREV_BTN).click();
    await page.locator('.option-row').first().waitFor({ state: 'visible' });

    await expect(page.locator(MSG)).toHaveText(ANSWERED, { timeout: 15_000 });
  });

  test('a PARTIAL question never claims completion on revisit', async ({ page }) => {
    const correct = await openDiMulti(page);
    await click(page, correct[0]);
    await expect(page.locator(MSG)).toHaveText(remainingMsg(2), { timeout: 15_000 });

    await page.locator(NEXT_BTN).click();
    await page.locator('.option-row').first().waitFor({ state: 'visible' });
    await page.waitForTimeout(800);
    await page.locator(PREV_BTN).click();
    await page.locator('.option-row').first().waitFor({ state: 'visible' });

    await expect(page.locator(MSG)).not.toHaveText(ANSWERED, { timeout: 15_000 });
  });

  test('revisit paints the picks: correct green, wrong red, untouched neutral', async ({ page }) => {
    const correct = await openDiMulti(page);
    const wrong = [0, 1, 2, 3].filter((i) => !correct.includes(i));

    await click(page, correct[0]);
    await page.waitForTimeout(1500);
    await click(page, wrong[0]);
    await page.waitForTimeout(2000);

    await page.locator(NEXT_BTN).click().catch(() => { /* may be gated */ });
    await page.waitForTimeout(1200);
    await page.locator(PREV_BTN).click().catch(() => {});
    await page.locator('.option-row').first().waitFor({ state: 'visible' });
    await page.waitForTimeout(1500);

    const rows = page.locator('.option-row');
    await expect(rows.nth(correct[0])).toHaveClass(/correct-option/, { timeout: 15_000 });
    await expect(rows.nth(wrong[0])).toHaveClass(/incorrect-option/, { timeout: 15_000 });

    // An unselected CORRECT option must stay neutral — being correct is not a
    // reason to reveal it while the question is unfinished.
    await expect(rows.nth(correct[1])).not.toHaveClass(/correct-option/);
  });
});
