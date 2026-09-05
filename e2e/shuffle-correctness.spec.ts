import { test, expect, Page } from '@playwright/test';
import {
  tsQuiz, HEADING, NEXT_BTN, RESULTS_BTN, correctRowsForHeading,
} from './helpers';

/**
 * Phase 2 — shuffle CORRECTNESS coverage. The existing shuffle specs only
 * assert "doesn't crash / explanation shows". These assert the actual score
 * and per-question results are right in shuffle mode, to find out whether the
 * known shuffle index mis-attribution corrupts scoring/results (it records
 * clicks under index 0) or only affects the Next-button-on-revisit edge.
 *
 * Both question AND option order are randomized in shuffle, so the correct
 * option is resolved by matching the displayed option TEXT to the quiz data.
 */

async function startQuiz(page: Page, shuffle: boolean) {
  await page.goto('/quiz/intro/fixture-widgets');
  if (shuffle) {
    const toggle = page.locator('mat-slide-toggle button[role="switch"]');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
  }
  await page.locator('.start-btn').click();
  await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 20_000 });
}

/**
 * Walk the whole quiz in display order. For positions in `wrongAt`, click a
 * deliberately-incorrect option; otherwise click the correct one. Ends on the
 * results page.
 */
async function playThroughShuffle(page: Page, wrongAt: Set<number>) {
  const total = tsQuiz.questions.length;
  for (let pos = 0; pos < total; pos++) {
    const rows = page.locator('.option-row');
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });
    await expect
      .poll(async () =>
        (await correctRowsForHeading(rows, tsQuiz, (await page.locator(HEADING).textContent()) ?? '')).length,
        { timeout: 8000 })
      .toBeGreaterThan(0);

    const heading = (await page.locator(HEADING).textContent()) ?? '';
    const correct = await correctRowsForHeading(rows, tsQuiz, heading);
    const optCount = await rows.count();

    if (wrongAt.has(pos)) {
      const wrongIdx = [...Array(optCount).keys()].find((i) => !correct.includes(i)) ?? 0;
      await rows.nth(wrongIdx).click();
      await page.waitForTimeout(400); // let the click settle (relaxed)
    } else {
      // Click every correct option (multi-answer aware — fixture-widgets has
      // one multi-answer question among otherwise single-answer ones).
      for (const idx of correct) {
        await rows.nth(idx).click();
        await page.waitForTimeout(250);
      }
    }

    if (pos < total - 1) {
      await page.locator(NEXT_BTN).click(); // auto-waits for enabled
      await expect(page).toHaveURL(new RegExp(`/${pos + 2}$`));
    }
  }
  await page.locator(RESULTS_BTN).click();
  await expect(page).toHaveURL(/\/results\//);
}

async function readScore(page: Page): Promise<{ correct: number; total: number; pct: number }> {
  // Ensure the Score Analysis section is visible.
  const scoreTab = page.locator('text=Score Analysis').first();
  if (await scoreTab.count()) {
    await scoreTab.click().catch(() => {});
  }
  await page.locator('.your-score').first().waitFor({ state: 'visible', timeout: 15_000 });
  const results = page.locator('.your-score .result');
  const correct = Number((await results.nth(0).textContent())?.trim());
  const total = Number((await results.nth(1).textContent())?.trim());
  const pctText = (await page.locator('.percentage').first().textContent()) ?? '';
  const pct = Number(pctText.replace('%', '').trim());
  return { correct, total, pct };
}

test.describe('correctness — scoring control (non-shuffle)', () => {
  test('all-correct non-shuffle scores 100%', async ({ page }) => {
    await startQuiz(page, false);
    await playThroughShuffle(page, new Set());
    const { correct, total, pct } = await readScore(page);
    expect(total).toBe(tsQuiz.questions.length);
    expect(correct).toBe(total);
    expect(pct).toBe(100);
  });
});

test.describe('shuffle correctness — scoring', () => {
  // FIXED: previously an all-correct shuffle run scored wrong (e.g. 7/9)
  // because some clicks were silently dropped — the contentClick branch in
  // SharedOptionClickService bailed (deferring to the radio's change event)
  // when the click was inside the radio control, but the wrapper's
  // stopPropagation meant change never fired, so the click was lost. Now
  // contentClick processes as a backstop unless the option is already
  // selected. This is the regression guard.
  test('all-correct in shuffle scores 100%', async ({ page }) => {
    await startQuiz(page, true);
    await playThroughShuffle(page, new Set());
    const { correct, total, pct } = await readScore(page);
    expect(total).toBe(tsQuiz.questions.length);
    expect(correct).toBe(total);
    expect(pct).toBe(100);
  });
});
