import { test, expect, Page } from '@playwright/test';
import {
  HEADING, FEEDBACK, NEXT_BTN, PREV_BTN, tsQuiz,
  findTsQuestion as findQuestionForHeading, correctRowsForHeading,
} from './helpers';

/**
 * Shuffle-mode coverage for the explanation pipeline. The two extractions
 * that previously broke handleOptionClick (browser-only) failed in shuffle
 * mode, so this is the most important safety-net gap to close before any
 * decomposition. Both question AND option order are randomized in shuffle, so
 * we resolve the correct option by matching the displayed option TEXT against
 * the quiz data (via correctRowsForHeading) — index-based resolution would
 * click the wrong, reordered row.
 */

async function enableShuffleAndStart(page: Page) {
  await page.goto('/quiz/intro/fixture-widgets');
  const toggle = page.locator('mat-slide-toggle button[role="switch"]');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.locator('.start-btn').click();
  await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 20_000 });
}

test.describe('shuffle mode — explanation pipeline', () => {
  test('correct click shows the explanation for the displayed question', async ({ page }) => {
    await enableShuffleAndStart(page);

    const rows = page.locator('.option-row');
    const headingText = (await page.locator(HEADING).textContent()) ?? '';
    const correct = await correctRowsForHeading(rows, tsQuiz, headingText);
    expect(correct.length).toBeGreaterThan(0);

    // Multi-answer aware — fixture-widgets has one multi-answer question among
    // otherwise single-answer ones, and shuffle can land on it first.
    for (const idx of correct) await rows.nth(idx).click();
    await expect(page.locator(HEADING)).toContainText(/is correct because|are correct because/i);
    await expect(page.locator(FEEDBACK)).toContainText(/right/i);
  });

  test('explanation does not leak across forward navigation in shuffle', async ({ page }) => {
    await enableShuffleAndStart(page);

    const rows = page.locator('.option-row');
    const headingText = (await page.locator(HEADING).textContent()) ?? '';
    const correct = await correctRowsForHeading(rows, tsQuiz, headingText);
    // Multi-answer aware — fixture-widgets has one multi-answer question among
    // otherwise single-answer ones, and shuffle can land on it first.
    for (const idx of correct) await rows.nth(idx).click();
    await expect(page.locator(HEADING)).toContainText(/is correct because|are correct because/i);

    await page.locator(NEXT_BTN).click();

    // The next heading must be a real (unanswered) question, not the prior
    // explanation and not blank.
    await expect(page.locator(HEADING)).not.toContainText(/is correct because|are correct because/i);
    await expect
      .poll(async () => {
        const t = (await page.locator(HEADING).textContent()) ?? '';
        return findQuestionForHeading(t) ? 'question' : 'other';
      }, { timeout: 8000 })
      .toBe('question');
  });

  // FIXED (index-model rewrite, Phases 1+2): bouncing Q1<->Q2 repeatedly in
  // shuffle, the Next button used to fail to re-enable on the 3rd visit to Q2
  // (a timing race — selection stores are cleared on revisit, leaving the
  // answered state to a racy re-derivation stream). Phase 1 made handleOptionClick
  // trust the URL display index (1/8 -> 4/8); Phase 2 added a DURABLE
  // per-display-index answered flag (markQuestionAnswered on completion) that
  // the post-navigation re-derivation reads to deterministically re-enable Next
  // (4/8 -> 8/8, confirmed 16/16 across two batches). Now a permanent regression
  // guard.
  test('Next stays enabled on repeated revisits to position 2 (Q1<->Q2 x3)', async ({ page }) => {
    await enableShuffleAndStart(page);
    const next = page.locator(NEXT_BTN);
    const prev = page.locator(PREV_BTN);
    const rows = page.locator('.option-row');

    // Answer position 1.
    let h = (await page.locator(HEADING).textContent()) ?? '';
    let correct = await correctRowsForHeading(rows, tsQuiz, h);
    await rows.nth(correct[0]).click();
    await expect(next).toBeEnabled();

    // Go to position 2 and answer it.
    await next.click();
    await expect(page).toHaveURL(/\/2$/);
    await rows.first().waitFor({ state: 'visible' });
    h = (await page.locator(HEADING).textContent()) ?? '';
    correct = await correctRowsForHeading(rows, tsQuiz, h);
    await rows.nth(correct[0]).click();
    await expect(next).toBeEnabled();

    // Bounce: 2 -> 1 -> 2 (2nd visit), then 1 -> 2 (3rd visit).
    for (let i = 0; i < 2; i++) {
      await prev.click();
      await expect(page).toHaveURL(/\/1$/);
      await expect(next).toBeEnabled(); // Q1 answered -> Next enabled
      await next.click();
      await expect(page).toHaveURL(/\/2$/);
      await rows.first().waitFor({ state: 'visible' });
    }

    // On the 3rd visit to position 2 (already answered), Next must be enabled.
    await expect(next).toBeEnabled();
  });
});
