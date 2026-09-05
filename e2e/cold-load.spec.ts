import { test, expect, Page } from '@playwright/test';
import { tsQuiz, diQuiz, HEADING, findQuestionIn } from './helpers';

/**
 * Cold-load options-render guard.
 *
 * Loading DIRECTLY into a question route (page.goto / reload, not a
 * click-through from the intro) is the path that intermittently failed to
 * render options — fixed 2026-06-13 with: (1) the render-gate made reactive to
 * quiz-data load (combinedQuestionDataView tracks questionsSig), (2) a
 * create-on-ready self-heal effect for the dynamic answer component, and
 * (3) eager-bundling AnswerComponent (no lazy chunk to fail-fetch).
 *
 * e2e can't reproduce the timing RACE deterministically, but it can assert the
 * invariant — options always render on a direct deep-link / reload — which a
 * hard regression (gate stuck empty, component never created) would break.
 * Run with --repeat-each to also probe the race.
 */

async function assertOptionsRender(page: Page, quizId: string, oneBasedIndex: number, quiz: any) {
  const rows = page.locator('.option-row');
  await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

  // Options actually rendered (not an empty container).
  const expectedCount = quiz.questions[oneBasedIndex - 1].options.length;
  expect(await rows.count()).toBe(expectedCount);

  // Heading rendered a real question (not blank), and it's a known quiz question.
  await expect(page.locator(HEADING)).not.toBeEmpty();
  await expect
    .poll(async () => (findQuestionIn(quiz, (await page.locator(HEADING).textContent()) ?? '') ? 'ok' : 'no'),
      { timeout: 8000 })
    .toBe('ok');
}

test.describe('cold load — options render on direct deep-link', () => {
  test('fixture-widgets Q1 renders options on a fresh deep-link', async ({ page }) => {
    await page.goto('/quiz/question/fixture-widgets/1');
    await assertOptionsRender(page, 'fixture-widgets', 1, tsQuiz);
  });

  test('fixture-widgets mid-quiz question renders options on a fresh deep-link', async ({ page }) => {
    const idx = Math.min(4, tsQuiz.questions.length); // a later question exercises URL-index resolution
    await page.goto(`/quiz/question/fixture-widgets/${idx}`);
    await assertOptionsRender(page, 'fixture-widgets', idx, tsQuiz);
  });

  test('fixture-gadgets Q1 (from the multi-answer bank) renders options on a fresh deep-link', async ({ page }) => {
    await page.goto('/quiz/question/fixture-gadgets/1');
    await assertOptionsRender(page, 'fixture-gadgets', 1, diQuiz);
  });

  test('options still render after an in-place reload (address-bar reload path)', async ({ page }) => {
    const idx = Math.min(3, tsQuiz.questions.length);
    await page.goto(`/quiz/question/fixture-widgets/${idx}`);
    await assertOptionsRender(page, 'fixture-widgets', idx, tsQuiz);

    await page.reload();
    await assertOptionsRender(page, 'fixture-widgets', idx, tsQuiz);
  });
});
