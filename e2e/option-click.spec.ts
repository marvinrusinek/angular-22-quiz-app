import { test, expect, Page } from '@playwright/test';
import { formsQuiz, findMultiAnswerQuestion, correctRowsForHeading } from './helpers';

/**
 * Behavioral safety net for OptionInteractionService.handleOptionClick and
 * the FET (explanation) gate. These assert the user-observable outcomes the
 * click handler produces — option highlighting, feedback, explanation
 * display/clear, multi-answer gating, and rehydration on revisit.
 *
 * Every regression that previously made handleOptionClick "undecomposable"
 * was browser-only (Jest passed, app broke). These specs are the gate for
 * any decomposition of that method: extract a piece, run these, and a red
 * test pinpoints exactly which behavior broke.
 *
 * Ground truth from the deterministic synthetic E2E bank (fixture-widgets
 * Q1 single-answer, fixture-gizmos' first multi-answer question, resolved
 * dynamically via findMultiAnswerQuestion rather than hardcoded).
 */

const HEADING = 'codelab-quiz-content h3';
const FEEDBACK = 'codelab-quiz-feedback';
const NEXT_BTN = '.nav-btn[aria-label="Next Question"]';
const PREV_BTN = '.nav-btn[aria-label="Previous Question"]';

async function gotoQuestion(page: Page, quiz: string, n: number) {
  await page.goto(`/quiz/question/${quiz}/${n}`);
  await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 20_000 });
}

test.describe('single-answer click', () => {
  test('correct click highlights the option and shows the explanation', async ({ page }) => {
    await gotoQuestion(page, 'fixture-widgets', 1);
    const rows = page.locator('.option-row');

    await rows.nth(0).click(); // ':' is the correct answer

    await expect(rows.nth(0)).toHaveClass(/correct-option/);
    await expect(rows.nth(0)).toHaveClass(/selected/);
    await expect(page.locator(FEEDBACK)).toContainText(/right/i);
    await expect(page.locator(HEADING)).toContainText(/is correct because/i);
    await expect(page.locator(NEXT_BTN)).toBeVisible();
  });

  test('wrong click marks the option incorrect', async ({ page }) => {
    await gotoQuestion(page, 'fixture-widgets', 1);
    const rows = page.locator('.option-row');

    await rows.nth(1).click(); // ';' is wrong

    await expect(rows.nth(1)).toHaveClass(/incorrect-option/);
  });
});

test.describe('multi-answer click', () => {
  // Resolve the fixture-gizmos multi-answer question from the data (was hardcoded Q4; the
  // quiz was edited so the multi-answer question is elsewhere now).
  const MULTI = findMultiAnswerQuestion(formsQuiz);

  test('shows the "N answers are correct" banner before any selection', async ({ page }) => {
    await gotoQuestion(page, 'fixture-gizmos', MULTI.index);
    await expect(page.locator('.correct-count')).toBeVisible();
    await expect(page.locator('.correct-count'))
      .toContainText(new RegExp(`${MULTI.correctCount} answers are correct`, 'i'));
  });

  test('gates the explanation until ALL correct answers are selected', async ({ page }) => {
    await gotoQuestion(page, 'fixture-gizmos', MULTI.index);
    const rows = page.locator('.option-row');
    const heading = (await page.locator(HEADING).first().textContent()) ?? '';
    const corrects = await correctRowsForHeading(rows, formsQuiz, heading);

    // Partial: select all-but-one correct — explanation must NOT show yet.
    for (let i = 0; i < corrects.length - 1; i++) await rows.nth(corrects[i]).click();
    await expect(page.locator(FEEDBACK)).toContainText(/select 1 more/i);
    await expect(page.locator(HEADING)).not.toContainText(/are correct because/i);

    // Complete: last correct selected — explanation now shows.
    await rows.nth(corrects[corrects.length - 1]).click();
    await expect(page.locator(HEADING)).toContainText(/are correct because/i);
    await expect(page.locator(FEEDBACK)).toContainText(/right/i);
  });
});

test.describe('FET gate across navigation', () => {
  test('explanation does not leak from Q1 into Q2', async ({ page }) => {
    await gotoQuestion(page, 'fixture-widgets', 1);
    await page.locator('.option-row').nth(0).click();
    await expect(page.locator(HEADING)).toContainText(/is correct because/i);

    await page.locator(NEXT_BTN).click();

    // Q2 heading shows Q2's question, not Q1's leftover explanation.
    await expect(page.locator(HEADING)).toContainText(/glossy/i);
    await expect(page.locator(HEADING)).not.toContainText(/is correct because/i);
  });

  test('selected option rehydrates when navigating back', async ({ page }) => {
    await gotoQuestion(page, 'fixture-widgets', 1);
    await page.locator('.option-row').nth(0).click();
    await expect(page.locator('.option-row').nth(0)).toHaveClass(/selected/);

    await page.locator(NEXT_BTN).click();
    await expect(page.locator(HEADING)).toContainText(/glossy/i);

    await page.locator(PREV_BTN).click();
    // Back on Q1, the previously-correct option is still highlighted.
    await expect(page.locator(HEADING)).toContainText(/smallest/i);
    await expect(page.locator('.option-row').nth(0)).toHaveClass(/selected/);
  });
});
