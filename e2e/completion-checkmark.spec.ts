import { test, expect } from '@playwright/test';
import { HEADING, NEXT_BTN, RESULTS_BTN, tsQuiz, correctIndexForHeading } from './helpers';

/**
 * Finishing a quiz marks its Quiz Selection tile with the "done" checkmark
 * regardless of score — a 90% completion counts, not just a perfect 100%.
 * (The 100% distinction is surfaced separately via achievements.)
 */
test('a non-perfect completion still shows the tile checkmark on Quiz Selection', async ({ page }) => {
  await page.goto('/quiz/question/fixture-widgets/1');
  const total = tsQuiz.questions.length;

  for (let i = 0; i < total; i++) {
    const rows = page.locator('.option-row');
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    await expect
      .poll(async () => correctIndexForHeading((await page.locator(HEADING).textContent()) ?? ''),
        { timeout: 8000 })
      .toBeGreaterThanOrEqual(0);

    const correct = correctIndexForHeading((await page.locator(HEADING).textContent()) ?? '');
    // Deliberately get the FIRST question wrong → non-perfect (~90%).
    const pick = i === 0 ? (correct === 0 ? 1 : 0) : correct;
    await rows.nth(pick).click();

    if (i < total - 1) {
      await page.locator(NEXT_BTN).click();
      await expect(page).toHaveURL(new RegExp(`/${i + 2}$`));
    }
  }

  await page.locator(RESULTS_BTN).click();
  await expect(page).toHaveURL(/\/results\//);

  // Return to selection via the "Select Quiz" button (/select redirects to /quiz).
  await page.getByTitle('select quiz').click();
  await page.locator('.quiz-tile').first().waitFor({ state: 'visible', timeout: 20_000 });

  // The completed quiz tile shows the checkmark despite the imperfect score.
  const completedTile = page.locator('.quiz-tile.completed');
  await expect(completedTile).toHaveCount(1);
  await expect(completedTile.locator('mat-icon').first()).toHaveText('done');
});
