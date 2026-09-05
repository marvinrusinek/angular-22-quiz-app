import { test, expect } from '@playwright/test';
import { NEXT_BTN, PREV_BTN, HEADING, diQuiz, correctRowsForHeading } from './helpers';

/**
 * Regression guard for revisit clickability — updated 2026-07-05 for the
 * "remember on revisit" behavior.
 *
 * On revisit, a previously-clicked option is REMEMBERED and READ-ONLY (red for a
 * wrong pick, green for a correct one — those classes carry pointer-events:none
 * by design). But UNSELECTED options must stay CLICKABLE so the user can still
 * add to / complete their answer — they must never be left stuck-disabled (the
 * original durable-disabled-set bug this file has always guarded).
 *
 * DI Q2 is multi-answer. Option rows are resolved by visible text (shuffle-immune).
 */

test('revisit — remembered pick is read-only, unselected options stay clickable', async ({ page }) => {
  await page.goto('/quiz/question/fixture-gadgets/1');
  const rows = page.locator('.option-row');
  await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

  // Answer Q1 so Next is enabled, then go to Q2 (multi-answer).
  await rows.nth(0).click();
  await expect(page.locator(NEXT_BTN)).toBeEnabled();
  await page.locator(NEXT_BTN).click();
  await expect(page).toHaveURL(/\/2$/);
  await rows.first().waitFor({ state: 'visible' });

  const heading = (await page.locator(HEADING).first().textContent()) ?? '';
  const corrects = await correctRowsForHeading(rows, diQuiz, heading);
  const count = await rows.count();
  const wrongs = [...Array(count).keys()].filter((i) => !corrects.includes(i));
  expect(corrects.length).toBeGreaterThan(0);
  expect(wrongs.length).toBeGreaterThan(0);

  // First visit: click a WRONG option — it highlights (red).
  await rows.nth(wrongs[0]).click();
  await expect(rows.nth(wrongs[0])).toHaveClass(/selected/);

  // Back to Q1, forward to Q2 again (revisit).
  await page.locator(PREV_BTN).click();
  await expect(page).toHaveURL(/\/1$/);
  await page.locator(NEXT_BTN).click();
  await expect(page).toHaveURL(/\/2$/);
  await rows.first().waitFor({ state: 'visible' });

  // Remembered: the wrong pick shows red (incorrect-option), read-only.
  await expect(rows.nth(wrongs[0])).toHaveClass(/incorrect-option/);

  // An UNSELECTED option must NOT be stuck-disabled on revisit — it stays
  // clickable so the user can keep answering.
  const fresh = corrects[0];
  await expect(rows.nth(fresh)).not.toHaveClass(/disabled-option/);
  await rows.nth(fresh).click();
  await expect(rows.nth(fresh)).toHaveClass(/selected/, { timeout: 5000 });
});
