import { test, expect } from '@playwright/test';
import { HEADING, NEXT_BTN, RESULTS_BTN, diQuiz, correctRowsForHeading } from './helpers';

/**
 * End-to-end: completing a quiz with a perfect score unlocks the "Perfect Score"
 * achievement on the Results screen, and — crucially — the unlock does NOT
 * re-appear after a page refresh (it is earned once, persisted, never re-shown).
 *
 * The other achievements (Explorer / difficulty / Master) require completing many
 * quizzes and are covered by the unit tests, per the plan.
 */

const UNLOCKED = '.achievement-unlocked';

test('perfect quiz unlocks an achievement on results, and it does not re-appear after refresh', async ({ page }) => {
  // Playwright gives each test a fresh browser context (empty localStorage), so
  // no achievement is earned yet at the start of this run.
  await page.goto('/quiz/question/fixture-gadgets/1');
  const total = diQuiz.questions.length;

  // Answer every question with ALL its correct options (multi-answer aware) → 100%.
  for (let i = 0; i < total; i++) {
    const rows = page.locator('.option-row');
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    let corrects: number[] = [];
    await expect
      .poll(async () => {
        const heading = (await page.locator(HEADING).first().textContent()) ?? '';
        corrects = await correctRowsForHeading(rows, diQuiz, heading);
        return corrects.length;
      }, { timeout: 8000 })
      .toBeGreaterThan(0);

    for (const idx of corrects) {
      await rows.nth(idx).click();
    }

    if (i < total - 1) {
      await page.locator(NEXT_BTN).click();
      await expect(page).toHaveURL(new RegExp(`/${i + 2}$`));
    }
  }

  await page.locator(RESULTS_BTN).click();
  await expect(page).toHaveURL(/\/results\//);

  // The unlock banner appears with the earned achievement's name.
  const banner = page.locator(UNLOCKED);
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await expect(banner).toContainText('Achievement Unlocked');
  await expect(banner).toContainText('Perfect Score');

  // The expandable catalog shows the earned count collapsed, and all 6 (with
  // earned + locked states) once expanded.
  const toggle = page.locator('.achievements-catalog__toggle');
  await expect(toggle).toBeVisible();
  await expect(toggle).toContainText('/ 6');
  await expect(page.locator('.achievements-catalog__item')).toHaveCount(0);  // collapsed
  await toggle.click();
  await expect(page.locator('.achievements-catalog__item')).toHaveCount(6);
  await expect(page.locator('.achievements-catalog__item.is-earned').first()).toContainText('Earned');
  await expect(page.locator('.achievements-catalog__item.is-locked').first()).toContainText('Locked');

  // Refresh: the achievement is already earned, so the unlock must NOT re-appear,
  // but the catalog still lists it as earned.
  await page.reload();
  await expect(page.locator(UNLOCKED)).toHaveCount(0);
  await expect(page.locator('.achievements-catalog__toggle')).toContainText('/ 6');
});
