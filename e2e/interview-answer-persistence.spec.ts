import { test, expect, Page } from '@playwright/test';

/**
 * Focused reproduction for a manually-observed regression: an Interview
 * answer the user definitely clicked showed as "Unanswered" in Review.
 *
 * Uses a single-topic (Fixture Widgets, 10 questions) custom session so ALL
 * 10 questions — including the target question below — are guaranteed to
 * appear every run, at a random position. Which specific question is the
 * target is not load-bearing to the regression (it reproduces on any answer,
 * not a question-specific one); any single-topic question works.
 */

const RESULTS_URL = /\/interview\/results\/[^/?#]+/;
const TARGET_QUESTION_TEXT = 'Which widget size is the smallest?';

async function configureTypeScriptOnly(page: Page) {
  await page.goto('/interview');
  await page.locator('.chip:has-text("Mixed")').first().click();
  const boxes = page.locator('.topic-check input[type="checkbox"]');
  await expect(boxes.first()).toBeVisible();
  await page.locator('.topics-toolbar button:has-text("Clear All")').click();
  await page.locator('.topic-check:has-text("Fixture Widgets")').locator('input[type="checkbox"]').check();
  await page.locator('.chip--button:has-text("10")').first().click();
  await page.locator('.start-interview-btn').click();
  await page.waitForURL(/\/interview\/session\/[^/?#]+/);
  await expect(page.locator('.interview-question-box')).toBeVisible();
}

async function submitAndOpenReview(page: Page) {
  await page.locator('.show-results-btn').click();
  await expect(page.getByText('Submit Assessment?')).toBeVisible();
  await page.locator('button:has-text("Submit Assessment")').last().click();
  await page.waitForURL(RESULTS_URL);
  await page.locator('button:has-text("Review Answers")').click();
  await expect(page.locator('.rv-item')).toHaveCount(10);
}

test.describe('Interview answer-persistence regression repro', () => {
  test('normal pace: every answer, including the reported question, survives to Review', async ({ page }) => {
    test.setTimeout(120_000);
    await configureTypeScriptOnly(page);

    for (let i = 1; i <= 10; i++) {
      const firstOption = page.locator('.io-option').first();
      await firstOption.click();
      await expect(firstOption).toHaveClass(/io-selected/);
      // Deliberately wait for the save to CONFIRM before moving on.
      await expect(page.locator('.interview-save--pending')).toHaveCount(0);
      if (i < 10) {
        await page.locator('.pg-next').first().click();
        await expect(page.locator('.interview-progress')).toContainText(`Question ${i + 1}`);
      }
    }

    await submitAndOpenReview(page);

    const targetItem = page.locator('.rv-item', { hasText: TARGET_QUESTION_TEXT });
    await expect(targetItem).toHaveCount(1);
    await expect(targetItem).not.toHaveClass(/rv-status-unanswered/);
    await expect(targetItem.locator('.rv-badge')).not.toContainText('Unanswered');
  });

  test('fast pace: clicking Next immediately after selecting must not lose the answer', async ({ page }) => {
    test.setTimeout(120_000);
    await configureTypeScriptOnly(page);

    for (let i = 1; i <= 10; i++) {
      const firstOption = page.locator('.io-option').first();
      await firstOption.click();
      // NO wait for io-selected, NO wait for Saving to clear — click Next as
      // fast as Playwright allows, exactly mirroring the reported fast path.
      if (i < 10) {
        await page.locator('.pg-next').first().click();
        await expect(page.locator('.interview-progress')).toContainText(`Question ${i + 1}`);
      }
    }

    await submitAndOpenReview(page);

    const targetItem = page.locator('.rv-item', { hasText: TARGET_QUESTION_TEXT });
    await expect(targetItem).toHaveCount(1);
    await expect(targetItem).not.toHaveClass(/rv-status-unanswered/);
    await expect(targetItem.locator('.rv-badge')).not.toContainText('Unanswered');

    // Nothing should be unanswered at all under the fast path.
    await expect(page.locator('.rv-summary__unanswered')).toHaveText('0');
  });

  test('slow backend: Next click during an in-flight save must not lose the answer', async ({ page }) => {
    test.setTimeout(150_000);

    // Delay every answer PUT to simulate real Render-tier latency, so a fast
    // Next click has a wide window to land WHILE the save is still pending.
    await page.route('**/interview-sessions/*/answers/*', async (route) => {
      if (route.request().method() === 'PUT') {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      await route.continue();
    });

    await configureTypeScriptOnly(page);

    for (let i = 1; i <= 10; i++) {
      const firstOption = page.locator('.io-option').first();
      await firstOption.click();
      // Fire the Next click immediately — while the artificially delayed save
      // is guaranteed to still be in flight (1.5s delay, click is near-instant).
      if (i < 10) {
        await page.locator('.pg-next').first().click();
        // If the click was correctly blocked, the progress indicator will only
        // advance once the save confirms and the gate lifts — this MUST still
        // land on the next question, just later than an unguarded click would.
        await expect(page.locator('.interview-progress')).toContainText(`Question ${i + 1}`, { timeout: 10_000 });
      }
    }

    await submitAndOpenReview(page);

    const targetItem = page.locator('.rv-item', { hasText: TARGET_QUESTION_TEXT });
    await expect(targetItem).toHaveCount(1);
    await expect(targetItem).not.toHaveClass(/rv-status-unanswered/);
    await expect(page.locator('.rv-summary__unanswered')).toHaveText('0');
  });

  test('changed selection: clicking a second option before the first save confirms must keep the final choice', async ({ page }) => {
    test.setTimeout(120_000);
    await configureTypeScriptOnly(page);

    for (let i = 1; i <= 10; i++) {
      const options = page.locator('.io-option');
      // Click the FIRST option, then IMMEDIATELY the SECOND — before the first
      // save can possibly have confirmed — on every question. Final choice
      // must be the second option once things settle.
      await options.nth(0).click();
      await options.nth(1).click();
      await expect(options.nth(1)).toHaveClass(/io-selected/);
      await expect(page.locator('.interview-save--pending')).toHaveCount(0);
      if (i < 10) {
        await page.locator('.pg-next').first().click();
        await expect(page.locator('.interview-progress')).toContainText(`Question ${i + 1}`);
      }
    }

    await submitAndOpenReview(page);

    const targetItem = page.locator('.rv-item', { hasText: TARGET_QUESTION_TEXT });
    await expect(targetItem).toHaveCount(1);
    await expect(targetItem).not.toHaveClass(/rv-status-unanswered/);
    await expect(page.locator('.rv-summary__unanswered')).toHaveText('0');
  });

  test('repeated real-world runs: mixed all-topic interviews never lose a clicked answer (stress)', async ({ page }) => {
    test.setTimeout(300_000);

    for (let run = 1; run <= 3; run++) {
      await page.goto('/interview');
      await page.locator('.chip:has-text("Mixed")').first().click();
      const boxes = page.locator('.topic-check input[type="checkbox"]');
      await expect(boxes.first()).toBeVisible();
      await page.locator('.topics-toolbar button:has-text("Select All")').click();
      await expect(boxes.first()).toBeChecked();
      await page.locator('.chip--button:has-text("10")').first().click();
      await page.locator('.start-interview-btn').click();
      await page.waitForURL(/\/interview\/session\/[^/?#]+/);
      await expect(page.locator('.interview-question-box')).toBeVisible();

      for (let i = 1; i <= 10; i++) {
        const firstOption = page.locator('.io-option').first();
        await firstOption.click();
        await expect(firstOption).toHaveClass(/io-selected/);
        await expect(page.locator('.interview-save--pending')).toHaveCount(0);
        if (i < 10) {
          await page.locator('.pg-next').first().click();
          await expect(page.locator('.interview-progress')).toContainText(`Question ${i + 1}`);
        }
      }

      await submitAndOpenReview(page);
      await expect(page.locator('.rv-summary__unanswered')).toHaveText('0', { timeout: 5_000 });

      if (run < 3) {
        await page.locator('button:has-text("Build Another Assessment")').click();
        await expect(page).toHaveURL(/\/interview$/);
      }
    }
  });

  test('mixed topic + question-type transitions: Fixture Widgets + Fixture Gadgets (has a multi-answer question)', async ({ page }) => {
    test.setTimeout(300_000);

    for (let run = 1; run <= 6; run++) {
      await page.goto('/interview');
      await page.locator('.chip:has-text("Mixed")').first().click();
      const boxes = page.locator('.topic-check input[type="checkbox"]');
      await expect(boxes.first()).toBeVisible();
      await page.locator('.topics-toolbar button:has-text("Clear All")').click();
      await page.locator('.topic-check:has-text("Fixture Widgets")').locator('input[type="checkbox"]').check();
      await page
        .locator('.topic-check:has-text("Fixture Gadgets")')
        .locator('input[type="checkbox"]')
        .check();
      await page.locator('.chip--button:has-text("10")').first().click();
      await page.locator('.start-interview-btn').click();
      await page.waitForURL(/\/interview\/session\/[^/?#]+/);
      await expect(page.locator('.interview-question-box')).toBeVisible();

      for (let i = 1; i <= 10; i++) {
        const firstOption = page.locator('.io-option').first();
        await firstOption.click();
        await expect(firstOption).toHaveClass(/io-selected/);
        await expect(page.locator('.interview-save--pending')).toHaveCount(0);
        if (i < 10) {
          await page.locator('.pg-next').first().click();
          await expect(page.locator('.interview-progress')).toContainText(`Question ${i + 1}`);
        }
      }

      await submitAndOpenReview(page);
      await expect(page.locator('.rv-summary__unanswered')).toHaveText('0', { timeout: 5_000 });

      const targetItem = page.locator('.rv-item', { hasText: TARGET_QUESTION_TEXT });
      const targetCount = await targetItem.count();
      if (targetCount > 0) {
        await expect(targetItem).not.toHaveClass(/rv-status-unanswered/);
      }

      if (run < 6) {
        await page.locator('button:has-text("Build Another Assessment")').click();
        await expect(page).toHaveURL(/\/interview$/);
      }
    }
  });
});
