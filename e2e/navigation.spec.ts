import { test, expect } from '@playwright/test';
import {
  tsQuiz, formsQuiz, HEADING, NEXT_BTN, PREV_BTN, RESULTS_BTN,
  correctIndices, correctIndexForHeading, findMultiAnswerQuestion, correctRowsForHeading,
  startQuizViaUi, advanceToQuestion,
} from './helpers';

/**
 * Deeper navigation coverage for the option-click handler's highlight and
 * selection-persistence behavior. These exercise the exact things the two
 * highlight loops in handleOptionClick produce (option .selected/.correct-
 * option state) across mid-quiz revisits, multi-answer revisits, and a full
 * run to results — the scenarios that must be covered before those loops
 * can be safely extracted.
 */

test.describe('deeper navigation — highlight persistence', () => {
  test('single-answer highlight persists on revisit (Q5 -> Q6 -> Q5)', async ({ page }) => {
    // A direct goto straight to question 5 is now correctly redirected by
    // QuizGuard on a fresh attempt — reach it via Start + legitimate
    // progression through 1-4 instead (Root Cause B, direct-route P1).
    await startQuizViaUi(page, 'fixture-widgets', /fixture widgets/i);
    await advanceToQuestion(page, tsQuiz, 5);
    const rows = page.locator('.option-row');
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    const correctIdx = correctIndices(tsQuiz.questions[4])[0];
    await rows.nth(correctIdx).click();
    await expect(rows.nth(correctIdx)).toHaveClass(/selected/);

    await page.locator(NEXT_BTN).click();
    await expect(page).toHaveURL(/\/6$/);
    await page.locator(PREV_BTN).click();
    await expect(page).toHaveURL(/\/5$/);

    // The previously-correct option is still highlighted after revisit.
    await expect(page.locator('.option-row').nth(correctIdx)).toHaveClass(/selected/);
  });

  test('multi-answer selections persist and Next stays enabled on revisit', async ({ page }) => {
    // Resolve the fixture-gizmos multi-answer question from the data (was hardcoded Q4).
    const multi = findMultiAnswerQuestion(formsQuiz);
    // Reach it via Start + legitimate progression, not a direct goto —
    // see the previous test's comment (Root Cause B, direct-route P1).
    await startQuizViaUi(page, 'fixture-gizmos', /fixture gizmos/i);
    await advanceToQuestion(page, formsQuiz, multi.index);
    const rows = page.locator('.option-row');
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    const heading = (await page.locator(HEADING).first().textContent()) ?? '';
    const corrects = await correctRowsForHeading(rows, formsQuiz, heading);
    expect(corrects.length).toBe(multi.correctCount);

    // Select ALL correct options (completes the multi-answer question).
    for (const c of corrects) await rows.nth(c).click();
    for (const c of corrects) await expect(rows.nth(c)).toHaveClass(/selected/);
    await expect(page.locator(NEXT_BTN)).toBeEnabled();

    await page.locator(NEXT_BTN).click();
    await expect(page).toHaveURL(new RegExp(`/${multi.index + 1}$`));
    await page.locator(PREV_BTN).click();
    await expect(page).toHaveURL(new RegExp(`/${multi.index}$`));

    // Both selections rehydrate and Next remains enabled.
    for (const c of corrects) await expect(rows.nth(c)).toHaveClass(/selected/);
    await expect(page.locator(NEXT_BTN)).toBeEnabled();
  });

  test('answering every question renders options each step and reaches results', async ({ page }) => {
    // Public UI, not a direct goto — this test's own Next clicks need a real
    // attempt to persist each unlock (Root Cause A, direct-route P1).
    await startQuizViaUi(page, 'fixture-widgets', /fixture widgets/i);
    const total = tsQuiz.questions.length;

    for (let i = 0; i < total; i++) {
      const rows = page.locator('.option-row');
      await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

      // Wait until the heading settles on a recognized (unanswered) question
      // — right after a Next click it can still show the prior explanation.
      await expect
        .poll(async () => correctIndexForHeading((await page.locator(HEADING).textContent()) ?? ''),
          { timeout: 8000 })
        .toBeGreaterThanOrEqual(0);

      const idx = correctIndexForHeading((await page.locator(HEADING).textContent()) ?? '');
      await rows.nth(idx).click();

      if (i < total - 1) {
        await page.locator(NEXT_BTN).click();
        await expect(page).toHaveURL(new RegExp(`/${i + 2}$`));
      }
    }

    await page.locator(RESULTS_BTN).click();
    await expect(page).toHaveURL(/\/results\//);
  });
});
