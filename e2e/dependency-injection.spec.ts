import { test, expect, Page } from '@playwright/test';
import {
  diQuiz, HEADING, FEEDBACK, NEXT_BTN, RESULTS_BTN,
  correctIndicesForHeading, correctRowsForHeading,
} from './helpers';

/**
 * fixture-gadgets quiz coverage — the most COMPLEX synthetic quiz in the
 * suite: it has multiple multi-answer questions (Q2, Q3, Q4), which the
 * fixture-widgets quiz lacks entirely. Multi-answer exercises the hardest
 * paths (the FET gate, the "all correct found" logic, partial-correct
 * handling), so this closes the biggest gap in the playthrough net.
 *
 * Question order is randomized in shuffle; option order is not. The correct
 * option(s) are resolved by matching the displayed heading to the quiz data
 * (multi-answer aware via correctIndicesForHeading).
 */

async function startDi(page: Page, shuffle: boolean) {
  await page.goto('/quiz/intro/fixture-gadgets');
  if (shuffle) {
    const toggle = page.locator('mat-slide-toggle button[role="switch"]');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
  }
  await page.locator('.start-btn').click();
  await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 20_000 });
}

/**
 * Walk the whole DI quiz in display order. For each question, click ALL correct
 * options (multi-answer aware); for positions in `wrongAt`, click a single
 * deliberately-incorrect option instead. Ends on the results page.
 */
async function playThroughDi(page: Page, wrongAt: Set<number>) {
  const total = diQuiz.questions.length;
  for (let pos = 0; pos < total; pos++) {
    const rows = page.locator('.option-row');
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    // Wait until the heading resolves to a known DI question.
    await expect
      .poll(async () =>
        correctIndicesForHeading(diQuiz, (await page.locator(HEADING).textContent()) ?? '').length,
        { timeout: 8000 })
      .toBeGreaterThan(0);

    const heading = (await page.locator(HEADING).textContent()) ?? '';
    const correct = await correctRowsForHeading(rows, diQuiz, heading);
    const optCount = await rows.count();

    if (wrongAt.has(pos)) {
      // Click a single incorrect option.
      const wrongIdx = [...Array(optCount).keys()].find((i) => !correct.includes(i)) ?? 0;
      await rows.nth(wrongIdx).click();
      await page.waitForTimeout(300);
    } else {
      // Click every correct option (one click each), in order.
      for (const idx of correct) {
        await rows.nth(idx).click();
        await page.waitForTimeout(250);
      }
    }

    if (pos < diQuiz.questions.length - 1) {
      await page.locator(NEXT_BTN).click(); // auto-waits for enabled
      await expect(page).toHaveURL(new RegExp(`/${pos + 2}$`));
    }
  }
  await page.locator(RESULTS_BTN).click();
  await expect(page).toHaveURL(/\/results\//);
}

/**
 * Walk forward in display order (answering each single-answer question to
 * advance) until the heading resolves to a MULTI-answer question that also has
 * at least one incorrect option. Returns that question's correct indices.
 * Order is randomized in shuffle, so the multi-answer question can be anywhere.
 */
async function walkToMultiAnswer(page: Page): Promise<number[]> {
  const rows = page.locator('.option-row');
  const total = diQuiz.questions.length;
  for (let pos = 0; pos < total; pos++) {
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });
    await expect
      .poll(async () =>
        correctIndicesForHeading(diQuiz, (await page.locator(HEADING).textContent()) ?? '').length,
        { timeout: 8000 })
      .toBeGreaterThan(0);

    const heading = (await page.locator(HEADING).textContent()) ?? '';
    const correct = await correctRowsForHeading(rows, diQuiz, heading);
    const optCount = await rows.count();

    if (correct.length >= 2 && optCount > correct.length) {
      return correct; // multi-answer with at least one incorrect option
    }

    // Single-answer: answer it and advance to keep walking.
    await rows.nth(correct[0]).click();
    await page.waitForTimeout(250);
    if (pos < total - 1) {
      await page.locator(NEXT_BTN).click();
      await expect(page).toHaveURL(new RegExp(`/${pos + 2}$`));
    }
  }
  throw new Error('No multi-answer question found in the DI quiz');
}

async function readScore(page: Page): Promise<{ correct: number; total: number; pct: number }> {
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

test.describe('fixture-gadgets — multi-answer correctness (control, non-shuffle)', () => {
  test('all-correct scores 100% (clicking every correct option per question)', async ({ page }) => {
    await startDi(page, false);
    await playThroughDi(page, new Set());
    const { correct, total, pct } = await readScore(page);
    expect(total).toBe(diQuiz.questions.length);
    expect(correct).toBe(total);
    expect(pct).toBe(100);
  });

  test('multi-answer question shows its explanation once all correct options are selected', async ({ page }) => {
    await startDi(page, false);
    const rows = page.locator('.option-row');

    // Walk forward to the first multi-answer question.
    const total = diQuiz.questions.length;
    for (let pos = 0; pos < total; pos++) {
      await rows.first().waitFor({ state: 'visible', timeout: 20_000 });
      const heading = (await page.locator(HEADING).textContent()) ?? '';
      const correct = await correctRowsForHeading(rows, diQuiz, heading);

      if (correct.length > 1) {
        // Select all correct options; the explanation should then appear.
        for (const idx of correct) {
          await rows.nth(idx).click();
          await page.waitForTimeout(250);
        }
        await expect(page.locator(NEXT_BTN)).toBeEnabled();
        await expect(page.locator(FEEDBACK)).toContainText(/\w/, { timeout: 8000 });
        return; // asserted the multi-answer FET path; done.
      }

      // Single-answer: click the correct one and advance.
      await rows.nth(correct[0]).click();
      await page.waitForTimeout(250);
      await page.locator(NEXT_BTN).click();
      await expect(page).toHaveURL(new RegExp(`/${pos + 2}$`));
    }
    throw new Error('No multi-answer question found in the DI quiz');
  });
});

test.describe('fixture-gadgets — multi-answer correctness (shuffle)', () => {
  test('all-correct in shuffle scores 100%', async ({ page }) => {
    await startDi(page, true);
    await playThroughDi(page, new Set());
    const { correct, total, pct } = await readScore(page);
    expect(total).toBe(diQuiz.questions.length);
    expect(correct).toBe(total);
    expect(pct).toBe(100);
  });

  // Regression guard for the shuffle multi-answer FET gate: the "N answers are
  // correct" banner must persist during partial selection, the FET (explanation)
  // must NOT appear until EVERY correct option is selected, and then it must
  // appear. Correct-only selection — on this app clicking an incorrect option on
  // a multi-answer question reveals the answer early, which is a separate path.
  test('multi-answer FET appears only after ALL correct options are selected (banner persists)', async ({ page }) => {
    await startDi(page, true);
    const correct = await walkToMultiAnswer(page);

    const rows = page.locator('.option-row');

    // Banner shown before any selection (question text + "N answers are correct").
    await expect(page.locator('.correct-count')).toBeVisible();
    await expect(page.locator('.correct-count')).toContainText(/answers are correct/i);

    // Select every correct option EXCEPT the last — the FET must NOT appear yet
    // (partial), and the "N answers are correct" banner persists.
    for (let i = 0; i < correct.length - 1; i++) {
      await rows.nth(correct[i]).click();
      await page.waitForTimeout(300);
      await expect(page.locator(HEADING)).not.toContainText(/are correct because/i);
      await expect(page.locator('.correct-count')).toBeVisible();
    }

    // Final correct click — every correct option is now selected, so the heading
    // flips to the formatted explanation (FET).
    await rows.nth(correct[correct.length - 1]).click();
    await expect(page.locator(HEADING)).toContainText(/are correct because/i, { timeout: 8000 });
  });
});
