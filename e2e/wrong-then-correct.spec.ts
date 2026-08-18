import { test, expect } from '@playwright/test';
import { diQuiz } from './helpers';

/**
 * A WRONG pick followed by the CORRECT one must end GREEN, with the win message.
 *
 * The suite tested a wrong click and a correct click, but never the SEQUENCE —
 * so this shipped: on a single-answer question the app published BOTH the new
 * pick and the previous one (a `highlight` leftover counts as selected, which is
 * right for multi-answer and wrong here). That sent a second POST /check
 * carrying two selections for a single-answer question, the server rejected it
 * 400, and the error verdict overwrote the `resolved correct:true` the right
 * answer had just earned.
 *
 * The user saw a RED box with NO feedback text after answering correctly. Two
 * separate defects produced that: the errored verdict (class + missing reveal)
 * and a `Math.max` merge that could never lower a count for a selection the user
 * had ABANDONED, which pinned the message at "Not this one, try again!".
 *
 * Asserted here on the DOM the user actually sees, not on internals.
 */
const QUIZ = 'dependency-injection';

test('wrong pick then correct pick ends green with the win message', async ({ page }) => {
  test.setTimeout(120_000);

  const rejected: string[] = [];
  page.on('response', (r) => {
    if (r.url().includes('/check') && r.status() >= 400) rejected.push(`${r.status()}`);
  });

  await page.goto(`/quiz/question/${QUIZ}/1`);
  const rows = page.locator('.option-row');
  await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

  const q: any = diQuiz.questions[0];
  const correctIdx = (q.options ?? []).findIndex((o: any) => o.correct === true);
  const wrongIdx = (q.options ?? []).findIndex((o: any) => o.correct !== true);
  expect(correctIdx, 'Q1 must have a correct option').toBeGreaterThanOrEqual(0);
  expect(wrongIdx, 'Q1 must have an incorrect option').toBeGreaterThanOrEqual(0);

  const feedback = page.locator('.feedback-message').first();

  // WRONG first — the state that used to poison everything after it.
  await rows.nth(wrongIdx).click();
  await expect(feedback).toHaveClass(/wrong-message/, { timeout: 10_000 });
  await expect(feedback).toContainText(/not this one/i);

  // Then CORRECT.
  await rows.nth(correctIdx).click();

  await expect(feedback).toHaveClass(/correct-message/, { timeout: 10_000 });
  await expect(feedback).not.toHaveClass(/wrong-message/);
  await expect(feedback).toContainText(/you're right/i);
  await expect(feedback).not.toContainText(/not this one/i);

  // A single-answer question must never submit two selections.
  expect(rejected, 'no /check may be rejected').toEqual([]);
});

test('a single-answer question never submits two selections', async ({ page }) => {
  test.setTimeout(120_000);

  const sizes: number[] = [];
  page.on('request', (r) => {
    if (!r.url().includes('/check') || !r.postData()) return;
    try { sizes.push((JSON.parse(r.postData()!).selectedOptionTexts ?? []).length); } catch { /* ignore */ }
  });

  await page.goto(`/quiz/question/${QUIZ}/1`);
  const rows = page.locator('.option-row');
  await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

  const q: any = diQuiz.questions[0];
  const correctIdx = (q.options ?? []).findIndex((o: any) => o.correct === true);
  const wrongIdx = (q.options ?? []).findIndex((o: any) => o.correct !== true);

  await rows.nth(wrongIdx).click();
  await page.waitForTimeout(1200);
  await rows.nth(correctIdx).click();
  await page.waitForTimeout(1500);

  // Every submission carries at most ONE text: picking a second option REPLACES
  // the first. A 2 here is the exact bug this file exists for.
  expect(Math.max(...sizes, 0)).toBeLessThanOrEqual(1);
});
