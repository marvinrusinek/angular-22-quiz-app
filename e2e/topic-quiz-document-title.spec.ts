import { test, expect } from '@playwright/test';
import { quizData, startQuizViaUi, NEXT_BTN } from './helpers';

/**
 * Document-title fix: src/index.html's static "Angular Quiz App" title
 * never updated for a Topic Quiz in progress (confirmed by exhaustive grep
 * — nothing in the Topic Quiz flow ever called Angular's `Title` service
 * before this fix). Narrator was observed announcing "Angular Quiz App" on
 * Q1 arrival — this is the only mechanism in the app that could produce
 * that exact string as the page title; it does not by itself prove that
 * string is what Narrator spoke (no automated check here can observe
 * actual spoken output).
 *
 * Uses the isolated synthetic fixture quiz (fixture-doohickeys), never the
 * real catalog — no production data, no live backend content involved.
 */

const doohickeys = quizData.find((q: any) => (q.quizId || q.id) === 'fixture-doohickeys');
const EXPECTED_TITLE = 'Fixture Doohickeys Quiz | Angular Quiz App';
const DEFAULT_TITLE = 'Angular Quiz App';

test.describe('Topic Quiz browser tab title (document-title fix)', () => {
  test('Introduction already shows the quiz-specific title, before Q1 even loads', async ({ page }) => {
    await page.goto('/quiz');
    await page.locator('.quiz-tile').first().waitFor({ state: 'visible', timeout: 30_000 });
    const tile = page.locator('.quiz-tile').filter({ hasText: /fixture doohickeys/i }).first();
    await tile.scrollIntoViewIfNeeded();
    await tile.click();

    await page.locator('h1[tabindex="-1"]').waitFor({ state: 'visible', timeout: 20_000 });
    await expect(page).toHaveTitle(EXPECTED_TITLE);
  });

  test('Q1 arrival keeps the quiz-specific title — the generic default is never shown there', async ({ page }) => {
    await startQuizViaUi(page, 'fixture-doohickeys', /fixture doohickeys/i);
    await expect(page).toHaveTitle(EXPECTED_TITLE);
  });

  test('the title survives Next (still the same quiz, not reset to generic)', async ({ page }) => {
    const qIdx = 0;
    await startQuizViaUi(page, 'fixture-doohickeys', /fixture doohickeys/i);

    const correctIdx = doohickeys.questions[qIdx].options.findIndex(
      (o: any) => o.correct === true || o.correct === 'true'
    );
    await page.locator('.option-row').nth(correctIdx).click();
    await page.waitForTimeout(900);
    await page.locator(NEXT_BTN).click();
    await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 20_000 });

    await expect(page).toHaveTitle(EXPECTED_TITLE);
  });

  test('navigating away from the quiz entirely restores the generic default — no stale topic title', async ({ page }) => {
    await startQuizViaUi(page, 'fixture-doohickeys', /fixture doohickeys/i);
    await expect(page).toHaveTitle(EXPECTED_TITLE);

    await page.goto('/quiz');
    await page.locator('.quiz-tile').first().waitFor({ state: 'visible', timeout: 30_000 });
    await expect(page).toHaveTitle(DEFAULT_TITLE);
  });
});
