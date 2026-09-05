import { test, expect, Page } from '@playwright/test';
import {
  HEADING, NEXT_BTN, PREV_BTN, tsQuiz, diQuiz,
  correctRowsForHeading,
} from './helpers';

/**
 * Phase 3 single-source heading guard. With window.__headingSingleSource = true
 * the heading is driven by the `headingHtml` computed (the single source) instead
 * of htmlSig. Asserts the real heading behavior (the §5 contract) directly, since
 * the shadow can't validate a heading it now drives. Every test enables the flag
 * before the app boots. Guards the single-source path until it becomes the
 * default (later step), at which point the flag setup can be dropped.
 */
test.describe('single-source heading (flag on)', () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => { (window as any).__headingSingleSource = true; });
  });

  async function startTs(page: Page) {
    await page.goto('/quiz/intro/fixture-widgets');
    await page.locator('.start-btn').click();
    await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 20_000 });
  }
  async function startDi(page: Page) {
    await page.goto('/quiz/intro/fixture-gadgets');
    await page.locator('.start-btn').click();
    await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 20_000 });
  }

  test('single-answer: correct click -> FET; revisit -> question text', async ({ page }) => {
    await startTs(page);
    const rows = page.locator('.option-row');
    let h = (await page.locator(HEADING).textContent()) ?? '';
    const correct = await correctRowsForHeading(rows, tsQuiz, h);
    await rows.nth(correct[0]).click();
    await expect(page.locator(HEADING)).toContainText(/is correct because/i);

    await page.locator(NEXT_BTN).click();
    await expect(page).toHaveURL(/\/2$/);
    await rows.first().waitFor({ state: 'visible' });
    await page.locator(PREV_BTN).click();
    await expect(page).toHaveURL(/\/1$/);
    await rows.first().waitFor({ state: 'visible' });
    // Revisit shows question text, not the FET.
    await expect(page.locator(HEADING)).not.toContainText(/is correct because/i);
    await expect(page.locator(HEADING)).toContainText(tsQuiz.questions[0].questionText.slice(0, 20));
  });

  test('multi-answer: partial keeps question+banner; complete -> FET; revisit -> question', async ({ page }) => {
    await startDi(page);
    const rows = page.locator('.option-row');
    const total = diQuiz.questions.length;

    let correct: number[] = [];
    for (let pos = 0; pos < total; pos++) {
      await rows.first().waitFor({ state: 'visible', timeout: 20_000 });
      const h = (await page.locator(HEADING).textContent()) ?? '';
      const c = await correctRowsForHeading(rows, diQuiz, h);
      const optCount = await rows.count();
      if (c.length >= 2 && optCount > c.length) { correct = c; break; }
      await rows.nth(c[0]).click();
      await page.waitForTimeout(250);
      if (pos < total - 1) {
        await page.locator(NEXT_BTN).click();
        await expect(page).toHaveURL(new RegExp(`/${pos + 2}$`));
      }
    }
    expect(correct.length).toBeGreaterThanOrEqual(2);

    // Partial: first correct only -> no FET yet.
    await rows.nth(correct[0]).click();
    await page.waitForTimeout(400);
    await expect(page.locator(HEADING)).not.toContainText(/are correct because/i);

    // Complete -> FET.
    for (const idx of correct.slice(1)) {
      await rows.nth(idx).click();
      await page.waitForTimeout(250);
    }
    await expect(page.locator(HEADING)).toContainText(/are correct because/i, { timeout: 8000 });

    // Revisit -> question text.
    await page.locator(NEXT_BTN).click();
    await page.locator('.option-row').first().waitFor({ state: 'visible' });
    await page.locator(PREV_BTN).click();
    await page.locator('.option-row').first().waitFor({ state: 'visible' });
    await page.waitForTimeout(500);
    await expect(page.locator(HEADING)).not.toContainText(/are correct because/i);
  });

  test('cold-load: deep-link mid-quiz renders question text (no stale FET)', async ({ page }) => {
    await startTs(page);
    const rows = page.locator('.option-row');
    let h = (await page.locator(HEADING).textContent()) ?? '';
    const correct = await correctRowsForHeading(rows, tsQuiz, h);
    await rows.nth(correct[0]).click();
    await page.locator(NEXT_BTN).click();
    await expect(page).toHaveURL(/\/2$/);
    await rows.first().waitFor({ state: 'visible' });
    await page.reload();
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForTimeout(500);
    await expect(page.locator(HEADING)).not.toContainText(/is correct because/i);
  });

  test('shuffle: correct click -> FET', async ({ page }) => {
    await page.goto('/quiz/intro/fixture-widgets');
    const toggle = page.locator('mat-slide-toggle button[role="switch"]');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await page.locator('.start-btn').click();
    const rows = page.locator('.option-row');
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });
    const h = (await page.locator(HEADING).textContent()) ?? '';
    const correct = await correctRowsForHeading(rows, tsQuiz, h);
    // Multi-answer aware — fixture-widgets has one multi-answer question among
    // otherwise single-answer ones, and shuffle can land on it first.
    for (const idx of correct) await rows.nth(idx).click();
    await expect(page.locator(HEADING)).toContainText(/is correct because|are correct because/i);
  });

  test('timer expiry -> FET on live view; persists are question-text on revisit', async ({ page }) => {
    await startTs(page);
    const rows = page.locator('.option-row');
    // Let Q1's 30s timer expire with no interaction -> live FET.
    await expect(page.locator(HEADING)).toContainText(/is correct because/i, { timeout: 45_000 });
    // Navigate away and back -> question text on revisit.
    await page.locator(NEXT_BTN).click();
    await expect(page).toHaveURL(/\/2$/);
    await rows.first().waitFor({ state: 'visible' });
    await page.locator(PREV_BTN).click();
    await expect(page).toHaveURL(/\/1$/);
    await rows.first().waitFor({ state: 'visible' });
    await page.waitForTimeout(500);
    await expect(page.locator(HEADING)).not.toContainText(/is correct because/i);
  });

  test('reload of an answered question keeps the heading populated (no blank)', async ({ page }) => {
    await startTs(page);
    const rows = page.locator('.option-row');
    const h = (await page.locator(HEADING).textContent()) ?? '';
    const correct = await correctRowsForHeading(rows, tsQuiz, h);
    await rows.nth(correct[0]).click();
    await expect(page.locator(HEADING)).toContainText(/is correct because/i);
    await page.reload();
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForTimeout(500);
    // After F5 the heading must render real content (question or FET), never blank.
    const after = (await page.locator(HEADING).textContent())?.trim() ?? '';
    expect(after.length).toBeGreaterThan(0);
  });
});
