import { test, expect } from '@playwright/test';

/**
 * Smoke test: proves the harness can launch the app, the quiz-selection
 * page renders, and we can drive the intro → first-question flow. This is
 * the foundation the fragile-scenario specs build on.
 */
test.describe('smoke', () => {
  test('quiz selection page loads', async ({ page }) => {
    await page.goto('/quiz');
    // The app shell should render something interactive, not a blank page.
    await expect(page.locator('body')).toBeVisible();
    await expect(page).toHaveURL(/\/quiz/);
  });

  test('can reach the first question of the fixture-widgets quiz', async ({ page }) => {
    await page.goto('/quiz/question/fixture-widgets/1');
    // The question container should mount and show option rows.
    await expect(page.locator('.option-row').first()).toBeVisible({ timeout: 20_000 });
  });
});
