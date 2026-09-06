import { test, expect, Page } from '@playwright/test';

/**
 * Mark for Review (Interview Mode only) — end-to-end coverage.
 *
 * Marking is a user-facing NOTE, never an answer: it must never select an
 * option, alter scoring, reveal correctness, or block submission. These specs
 * drive the real backend through the actual UI, the same way interview.spec.ts
 * does, rather than mocking the session service.
 */
const RESULTS_URL = /\/interview\/results\/[^/?#]+/;

async function configureAndStart(page: Page, count: '10' | '20' | '30' = '10') {
  await page.locator('.chip:has-text("Beginner")').first().click();
  const boxes = page.locator('.topic-check input[type="checkbox"]');
  await expect(boxes.first()).toBeVisible();
  await page.locator('.topics-toolbar button:has-text("Select All")').click();
  await expect(boxes.first()).toBeChecked();
  await page.locator(`.chip--button:has-text("${count}")`).first().click();
  await page.locator('.start-interview-btn').click();
  await page.waitForURL(/\/interview\/session\/[^/?#]+/);
  await expect(page.locator('.interview-question-box')).toBeVisible();
}

const markBtn = (page: Page) => page.locator('.ai-mark-review-btn');

test.describe('Mark for Review', () => {
  test('marking an UNANSWERED question persists it, without answering the question', async ({ page }) => {
    await page.goto('/interview');
    await configureAndStart(page, '10');

    await expect(markBtn(page)).toHaveAttribute('aria-pressed', 'false');
    await markBtn(page).click();
    await expect(markBtn(page)).toHaveAttribute('aria-pressed', 'true');

    // No option was selected, and the paginator does not count it as answered.
    await expect(page.locator('.io-option.io-selected')).toHaveCount(0);
    await expect(page.locator('.interview-session__progress')).toContainText('0 / 10');
    await expect(page.locator('.pg-page.current')).toHaveClass(/marked/);
    await expect(page.locator('.pg-page.current')).not.toHaveClass(/answered/);
  });

  test('answer + mark combine — marking never alters the selection, answering never clears the mark', async ({ page }) => {
    await page.goto('/interview');
    await configureAndStart(page, '10');

    const firstOption = page.locator('.io-option').first();
    await firstOption.click();
    await expect(firstOption).toHaveClass(/io-selected/);

    await markBtn(page).click();
    await expect(markBtn(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(firstOption).toHaveClass(/io-selected/);   // untouched by marking

    await expect(page.locator('.pg-page.current')).toHaveClass(/answered/);
    await expect(page.locator('.pg-page.current')).toHaveClass(/marked/);

    // Changing the answer afterward leaves the mark exactly as it was.
    await page.locator('.io-option').nth(1).click();
    await expect(markBtn(page)).toHaveAttribute('aria-pressed', 'true');
  });

  test('unmarking clears the flag', async ({ page }) => {
    await page.goto('/interview');
    await configureAndStart(page, '10');

    await markBtn(page).click();
    await expect(markBtn(page)).toHaveAttribute('aria-pressed', 'true');
    await markBtn(page).click();
    await expect(markBtn(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.pg-page.current')).not.toHaveClass(/marked/);
  });

  test('the mark survives a refresh (server-persisted, not a client-side flag)', async ({ page }) => {
    await page.goto('/interview');
    await configureAndStart(page, '10');

    const saved = page.waitForResponse((res) => res.url().includes('/review/') && res.request().method() === 'PUT');
    await markBtn(page).click();
    await expect(markBtn(page)).toHaveAttribute('aria-pressed', 'true');
    await saved;   // wait for the server to confirm before reloading, or the reload can race the write

    await page.reload();
    await expect(page.locator('.interview-question-box')).toBeVisible();
    await expect(markBtn(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.pg-page.current')).toHaveClass(/marked/);
  });

  test('marked questions remain fully submittable — Submit is never blocked or gated by marks', async ({ page }) => {
    await page.goto('/interview');
    await configureAndStart(page, '10');

    // Mark 3 unanswered questions via direct page jumps (never gated), leave the
    // rest unanswered, then submit anyway.
    await markBtn(page).click();
    for (const q of [2, 3]) {
      await page.locator(`.pg-page[aria-label^="Go to question ${q},"]`).click();
      await markBtn(page).click();
    }

    await expect(page.locator('.pg-page.marked')).toHaveCount(3);

    await page.locator('.pg-page[aria-label^="Go to question 10,"]').click();
    await page.locator('.show-results-btn').click();
    await expect(page.getByText('Submit Assessment?')).toBeVisible();

    // Informational only — never disables Submit.
    await expect(page.locator('.submit-marked-notice')).toBeVisible();
    await expect(page.locator('.submit-marked-notice')).toContainText(/marked for review/i);
    const submitButton = page.locator('button:has-text("Submit Assessment")').last();
    await expect(submitButton).toBeEnabled();

    await submitButton.click();
    await page.waitForURL(RESULTS_URL);
  });

  test('deferred feedback: marking never reveals correctness during the assessment', async ({ page }) => {
    await page.goto('/interview');
    await configureAndStart(page, '10');

    await markBtn(page).click();
    await expect(page.locator('.correct-option, .incorrect-option')).toHaveCount(0);
    await expect(page.locator('.rv-correct, .rv-wrong')).toHaveCount(0);
    await expect(page.locator('.interview-question-box')).not.toContainText(/Explanation/i);
  });

  test('post-submission Review shows the marked questions via the existing Flagged filter', async ({ page }) => {
    await page.goto('/interview');
    await configureAndStart(page, '10');

    // Mark question 1, answer the rest, submit.
    await markBtn(page).click();
    for (let i = 1; i <= 10; i++) {
      await page.locator('.io-option').first().click();
      if (i < 10) {
        await page.locator('.pg-next').first().click();
        await expect(page.locator('.interview-progress')).toContainText(`Question ${i + 1}`);
      }
    }
    await page.locator('.show-results-btn').click();
    await expect(page.getByText('Submit Assessment?')).toBeVisible();
    await page.locator('button:has-text("Submit Assessment")').last().click();
    await page.waitForURL(RESULTS_URL);

    await page.locator('button:has-text("Review Answers")').click();
    await expect(page.locator('app-interview-review')).toHaveCount(1, { timeout: 30_000 });

    // The Flagged chip appears because a real mark exists — no config flag needed.
    await expect(page.locator('.rv-filter', { hasText: 'Flagged' })).toBeVisible();
    await page.locator('.rv-filter', { hasText: 'Flagged' }).click();
    await expect(page.locator('.rv-item')).toHaveCount(1);
    await expect(page.locator('.rv-flag-badge')).toBeVisible();
  });
});
