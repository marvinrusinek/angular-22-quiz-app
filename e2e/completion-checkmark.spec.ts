import { test, expect } from '@playwright/test';
import { HEADING, NEXT_BTN, RESULTS_BTN, tsQuiz, correctIndexForHeading, startQuizViaUi } from './helpers';

/**
 * Finishing a quiz marks its Quiz Selection tile with the "done" checkmark
 * regardless of score — a 90% completion counts, not just a perfect 100%.
 * (The 100% distinction is surfaced separately via achievements.)
 */
test('a non-perfect completion still shows the tile checkmark on Quiz Selection', async ({ page }) => {
  // Public UI, not a direct goto — see achievements.spec.ts's comment on
  // why a direct `page.goto('/quiz/question/.../1')` no longer suffices to
  // let this test progress past question 1 (Root Cause A, direct-route P1).
  await startQuizViaUi(page, 'fixture-widgets', /fixture widgets/i);
  const total = tsQuiz.questions.length;

  for (let i = 0; i < total; i++) {
    const rows = page.locator('.option-row');
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    await expect
      .poll(async () => correctIndexForHeading((await page.locator(HEADING).textContent()) ?? ''),
        { timeout: 8000 })
      .toBeGreaterThanOrEqual(0);

    const correct = correctIndexForHeading((await page.locator(HEADING).textContent()) ?? '');
    // Deliberately get the LAST question wrong → non-perfect (~90%). Must be
    // the last one: an intermediate question requires a resolved-CORRECT
    // verdict to unlock Next (the mandatory progression rule — a wrong pick
    // there would leave Next permanently disabled). The final question has
    // its own, separate policy: Results is available after any selection,
    // correct or not.
    const isLast = i === total - 1;
    const pick = isLast ? (correct === 0 ? 1 : 0) : correct;
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
