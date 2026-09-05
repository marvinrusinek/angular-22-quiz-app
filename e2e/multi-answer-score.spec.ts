import { test, expect, Page, Locator } from '@playwright/test';
import { NEXT_BTN, PREV_BTN, HEADING, diQuiz, correctRowsForHeading, findMultiAnswerQuestion, norm } from './helpers';

/**
 * A multi-answer question's score must increment the MOMENT all correct answers
 * are selected (that completing click), NOT later when navigating away.
 *
 * The target question is resolved FROM THE DATA (findMultiAnswerQuestion) rather
 * than hardcoded, so these specs don't drift when the quiz is re-ordered/edited.
 */
const SCORE = '.scoreboard';
const MULTI = findMultiAnswerQuestion(diQuiz);  // fixture-gadgets: the >=2-correct question

const optText = async (row: Locator): Promise<string> =>
  norm(((await row.locator('.option-text').textContent()) ?? '').replace(/^\s*\d+\.\s*/, ''));

/**
 * Answer Q1 correctly (score -> 1), then navigate forward WITHOUT answering the
 * in-between questions until the multi-answer question is shown. Returns the
 * `.option-row` locator, positioned on the multi-answer question.
 */
async function reachMultiAnswerQuestion(page: Page): Promise<Locator> {
  await page.goto('/quiz/question/fixture-gadgets/1');
  const rows = page.locator('.option-row');
  await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

  // Q1 (single-answer): pick the correct option -> score becomes 1.
  const h1 = (await page.locator(HEADING).first().textContent()) ?? '';
  const c1 = await correctRowsForHeading(rows, diQuiz, h1);
  await rows.nth(c1[0]).click();
  await expect(page.locator(SCORE).first()).toContainText('1/', { timeout: 5000 });

  // Walk forward (unanswered) to the multi-answer question.
  for (let pos = 1; pos < MULTI.index; pos++) {
    await page.locator(NEXT_BTN).click();
    await expect(page).toHaveURL(new RegExp(`/${pos + 1}$`));
    await rows.first().waitFor({ state: 'visible' });
  }
  return rows;
}

test('multi-answer score increments only on the completing click, not before', async ({ page }) => {
  const rows = await reachMultiAnswerQuestion(page);

  const heading = (await page.locator(HEADING).first().textContent()) ?? '';
  const corrects = await correctRowsForHeading(rows, diQuiz, heading);
  expect(corrects.length).toBe(MULTI.correctCount);

  // Select every correct option EXCEPT the last -> still partial -> score stays 1.
  for (let i = 0; i < corrects.length - 1; i++) {
    await rows.nth(corrects[i]).click();
    await expect(page.locator(SCORE).first()).toContainText('1/');
  }

  // Final correct -> ALL correct selected -> score becomes 2 IMMEDIATELY + win feedback.
  await rows.nth(corrects[corrects.length - 1]).click();
  await expect(page.locator(SCORE).first()).toContainText('2/', { timeout: 5000 });
  await expect(
    page.locator('.feedback-message').filter({ hasText: "You're right!" }).first()
  ).toBeVisible({ timeout: 5000 });
});

test('a PARTIAL multi-answer must NOT be credited on navigation', async ({ page }) => {
  const rows = await reachMultiAnswerQuestion(page);

  const heading = (await page.locator(HEADING).first().textContent()) ?? '';
  const corrects = await correctRowsForHeading(rows, diQuiz, heading);

  // Select ONLY the first correct (partial — not all correct).
  await rows.nth(corrects[0]).click();
  await expect(page.locator(SCORE).first()).toContainText('1/');

  // Navigate forward. A partial multi-answer must NOT be credited — score stays 1.
  await page.locator(NEXT_BTN).click();
  await expect(page).toHaveURL(new RegExp(`/${MULTI.index + 1}$`));
  await rows.first().waitFor({ state: 'visible' });
  await expect(page.locator(SCORE).first()).toContainText('1/', { timeout: 5000 });
});

test('completing a multi-answer ON REVISIT credits the score ON THE CLICK', async ({ page }) => {
  const rows = await reachMultiAnswerQuestion(page);

  const heading = (await page.locator(HEADING).first().textContent()) ?? '';
  let corrects = await correctRowsForHeading(rows, diQuiz, heading);
  const lastText = await optText(rows.nth(corrects[corrects.length - 1]));

  // First visit: select all-but-one correct (partial) -> score stays 1.
  for (let i = 0; i < corrects.length - 1; i++) {
    await rows.nth(corrects[i]).click();
  }
  await expect(page.locator(SCORE).first()).toContainText('1/');

  // Leave forward, then return (revisit). Score still 1.
  await page.locator(NEXT_BTN).click();
  await expect(page).toHaveURL(new RegExp(`/${MULTI.index + 1}$`));
  await rows.first().waitFor({ state: 'visible' });
  await expect(page.locator(SCORE).first()).toContainText('1/');
  await page.locator(PREV_BTN).click();
  await expect(page).toHaveURL(new RegExp(`/${MULTI.index}$`));
  await rows.first().waitFor({ state: 'visible' });

  // Complete on revisit: click the remaining correct (matched by text, shuffle-safe)
  // -> ALL correct now selected across visits.
  corrects = await correctRowsForHeading(rows, diQuiz, heading);
  for (const c of corrects) {
    if ((await optText(rows.nth(c))) === lastText) {
      await rows.nth(c).click();
      break;
    }
  }

  // Completing on revisit must credit the score IMMEDIATELY on the click + WIN feedback.
  await expect(page.locator(SCORE).first()).toContainText('2/', { timeout: 5000 });
  await expect(
    page.locator('.feedback-message').filter({ hasText: "You're right!" }).first()
  ).toBeVisible({ timeout: 5000 });

  // Navigating away must NOT change the score (no double-count).
  await page.locator(NEXT_BTN).click();
  await expect(page).toHaveURL(new RegExp(`/${MULTI.index + 1}$`));
  await rows.first().waitFor({ state: 'visible' });
  await expect(page.locator(SCORE).first()).toContainText('2/');
});

test('revisiting a PARTIAL multi-answer WITHOUT completing must NOT credit', async ({ page }) => {
  const rows = await reachMultiAnswerQuestion(page);

  const heading = (await page.locator(HEADING).first().textContent()) ?? '';
  const corrects = await correctRowsForHeading(rows, diQuiz, heading);

  // Select ONLY the 1st correct (partial).
  await rows.nth(corrects[0]).click();
  await expect(page.locator(SCORE).first()).toContainText('1/');

  // forward -> back -> forward, never completing. Score must stay 1 throughout.
  await page.locator(NEXT_BTN).click();
  await expect(page).toHaveURL(new RegExp(`/${MULTI.index + 1}$`));
  await rows.first().waitFor({ state: 'visible' });
  await expect(page.locator(SCORE).first()).toContainText('1/');
  await page.locator(PREV_BTN).click();
  await expect(page).toHaveURL(new RegExp(`/${MULTI.index}$`));
  await rows.first().waitFor({ state: 'visible' });
  await expect(page.locator(SCORE).first()).toContainText('1/');
  await page.locator(NEXT_BTN).click();
  await expect(page).toHaveURL(new RegExp(`/${MULTI.index + 1}$`));
  await rows.first().waitFor({ state: 'visible' });
  await expect(page.locator(SCORE).first()).toContainText('1/', { timeout: 5000 });
});

// ── SHUFFLE-MODE revisit scoring ────────────────────────────────────────────
// In shuffle mode the SOC path owns multi-answer scoring. The fix folds the
// cross-visit uiSelectedTexts union into the all-correct count so COMPLETING a
// multi-answer on REVISIT credits the score (not just the win feedback).
async function startShuffledDI(page: Page): Promise<void> {
  await page.goto('/quiz/intro/fixture-gadgets');
  const toggle = page.locator('mat-slide-toggle button[role="switch"]');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.locator('.start-btn').click();
  await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 20_000 });
}

// Walk forward until the multi-answer question (its data correct-count) is shown.
// Returns its heading and 1-based position (shuffle puts it anywhere).
async function walkToMulti(page: Page): Promise<{ heading: string; position: number }> {
  const rows = page.locator('.option-row');
  const total = diQuiz.questions.length;
  for (let pos = 1; pos <= total; pos++) {
    const heading = (await page.locator(HEADING).first().textContent()) ?? '';
    const corrects = await correctRowsForHeading(rows, diQuiz, heading);
    if (corrects.length === MULTI.correctCount) return { heading, position: pos };
    if (pos < total) {
      // In shuffle mode Next is disabled until the current (single-answer)
      // question is answered, so answer it (any option) before advancing.
      await rows.nth(0).click();
      await expect(page.locator(NEXT_BTN)).toBeEnabled({ timeout: 5000 });
      await page.locator(NEXT_BTN).click();
      await rows.first().waitFor({ state: 'visible' });
      await page.waitForTimeout(300);
    }
  }
  return { heading: '', position: -1 };
}

// Leave the current question and return to it (a revisit). Position-aware so it
// works even when the (shuffled) multi-answer question is the LAST one — where
// there is no Next button — by going backward instead.
async function leaveAndReturn(page: Page, rows: Locator, position: number): Promise<void> {
  const total = diQuiz.questions.length;
  const [away, back] = position < total ? [NEXT_BTN, PREV_BTN] : [PREV_BTN, NEXT_BTN];
  await page.locator(away).click();
  await rows.first().waitFor({ state: 'visible' });
  await page.waitForTimeout(300);
  await page.locator(back).click();
  await rows.first().waitFor({ state: 'visible' });
  await page.waitForTimeout(300);
}

const baseScore = async (page: Page): Promise<number> => {
  const m = ((await page.locator(SCORE).first().textContent()) ?? '').match(/(\d+)\//);
  return m ? Number(m[1]) : 0;
};

test('SHUFFLE: completing a multi-answer ON REVISIT credits the score ON THE CLICK', async ({ page }) => {
  await startShuffledDI(page);
  const rows = page.locator('.option-row');
  const { heading, position } = await walkToMulti(page);
  expect(heading).not.toBe('');
  const base = await baseScore(page);

  let corrects = await correctRowsForHeading(rows, diQuiz, heading);
  const lastText = await optText(rows.nth(corrects[corrects.length - 1]));

  // Partial: select all-but-one correct -> no credit.
  for (let i = 0; i < corrects.length - 1; i++) {
    await rows.nth(corrects[i]).click();
  }
  await page.waitForTimeout(300);
  await expect(page.locator(SCORE).first()).toContainText(`${base}/`);

  // Leave then return (revisit).
  await leaveAndReturn(page, rows, position);

  // Complete: click the remaining correct -> credit ON THE CLICK + win feedback.
  const backHeading = (await page.locator(HEADING).first().textContent()) ?? '';
  corrects = await correctRowsForHeading(rows, diQuiz, backHeading);
  for (const c of corrects) {
    if ((await optText(rows.nth(c))) === lastText) { await rows.nth(c).click(); break; }
  }
  await expect(page.locator(SCORE).first()).toContainText(`${base + 1}/`, { timeout: 5000 });
  await expect(
    page.locator('.feedback-message').filter({ hasText: "You're right!" }).first()
  ).toBeVisible({ timeout: 5000 });
});

test('SHUFFLE: revisiting a PARTIAL multi-answer WITHOUT completing must NOT credit', async ({ page }) => {
  await startShuffledDI(page);
  const rows = page.locator('.option-row');
  const { heading, position } = await walkToMulti(page);
  expect(heading).not.toBe('');
  const base = await baseScore(page);

  const corrects = await correctRowsForHeading(rows, diQuiz, heading);
  await rows.nth(corrects[0]).click();  // partial only
  await page.waitForTimeout(300);

  // Leave and return without completing — must NEVER credit.
  await leaveAndReturn(page, rows, position);
  await page.waitForTimeout(200);
  await expect(page.locator(SCORE).first()).toContainText(`${base}/`);
});
