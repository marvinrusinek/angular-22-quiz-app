import { test, expect, Page } from '@playwright/test';
import { NEXT_BTN, PREV_BTN, HEADING, diQuiz, correctRowsForHeading, findMultiAnswerQuestion } from './helpers';

/**
 * Repro + regression guard for the "multi-answer completion lock on REVISIT" bug.
 *
 * The target multi-answer question is resolved FROM THE DATA
 * (findMultiAnswerQuestion) rather than hardcoded, so this spec follows the quiz
 * when it is re-ordered/edited. Intended behavior: once ALL correct options are
 * selected, the remaining unselected option(s) LOCK — disabled + dark-gray
 * (DISABLED_COLOR = #a0a0a0 = rgb(160, 160, 160)).
 *
 * - CONTROL (first visit): selecting all correct grays the remaining options.
 * - REVISIT: answer partially, navigate away and back, then finish selecting the
 *   correct options — the remaining unselected option must gray. See the
 *   project_ma_revisit_completion_lock memory.
 */

const DISABLED_GRAY = 'rgb(160, 160, 160)'; // #a0a0a0 DISABLED_COLOR
const MULTI = findMultiAnswerQuestion(diQuiz);  // the >=2-correct question
const M = MULTI.index;

// Navigate Q1 -> the multi-answer question. Returns the correct/wrong DOM row
// indices resolved by visible text (shuffle-immune).
async function gotoMulti(page: Page) {
  await page.goto('/quiz/question/dependency-injection/1');
  const rows = page.locator('.option-row');
  await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

  // Answer Q1 (any option) so Next is enabled, then walk to the multi-answer question.
  await rows.nth(0).click();
  await expect(page.locator(NEXT_BTN)).toBeEnabled();
  for (let pos = 1; pos < M; pos++) {
    await page.locator(NEXT_BTN).click();
    await expect(page).toHaveURL(new RegExp(`/${pos + 1}$`));
    await rows.first().waitFor({ state: 'visible' });
  }

  const heading = (await page.locator(HEADING).first().textContent()) ?? '';
  const corrects = await correctRowsForHeading(rows, diQuiz, heading);
  const count = await rows.count();
  const wrongs = [...Array(count).keys()].filter((i) => !corrects.includes(i));
  return { rows, corrects, wrongs };
}

test('CONTROL: first-visit — selecting all correct grays the remaining options', async ({ page }) => {
  const { rows, corrects, wrongs } = await gotoMulti(page);
  expect(corrects.length).toBe(MULTI.correctCount);
  expect(wrongs.length).toBeGreaterThan(0);

  // Select ALL correct options.
  for (const c of corrects) await rows.nth(c).click();

  // Every remaining (unselected, wrong) option locks to dark gray.
  for (const w of wrongs) {
    await expect(rows.nth(w)).toHaveCSS('background-color', DISABLED_GRAY);
  }
});

/**
 * WRONG FIRST. The target question has exactly ONE wrong option, so clicking it
 * exhausts every incorrect option on the user's first click — which used to fire
 * the terminal auto-reveal and disable every correct option they had not yet
 * found. The question became unanswerable on click one, and it shipped
 * (main d3d13ee7). Ordering is the whole point of this test: the two cases below
 * cover wrong-LAST, which is a different thing.
 */
test('wrong pick FIRST leaves the question answerable and completable', async ({ page }) => {
  const { rows, corrects, wrongs } = await gotoMulti(page);
  expect(corrects.length).toBe(MULTI.correctCount);
  expect(wrongs.length).toBeGreaterThan(0);

  // The wrong option, before anything else.
  await rows.nth(wrongs[0]).click();
  await expect(rows.nth(wrongs[0])).toHaveClass(/incorrect-option/);

  // Every correct option is still live: not disabled, not greyed out.
  for (const c of corrects) {
    await expect(rows.nth(c)).toBeEnabled();
    await expect(rows.nth(c)).not.toHaveCSS('background-color', DISABLED_GRAY);
    // And none of them was handed over as an answer.
    await expect(rows.nth(c)).not.toHaveClass(/correct-option/);
  }

  // The user can still finish the question — the clicks must actually land.
  for (const c of corrects) await rows.nth(c).click();
  for (const c of corrects) await expect(rows.nth(c)).toHaveClass(/correct-option/);

  // Completed with a wrong pick present: the wrong pick stays red rather than
  // being greyed out with the losers.
  await expect(rows.nth(wrongs[0])).toHaveClass(/incorrect-option/);
});

test('revisit via previous question — a partial multi-answer keeps its remembered colors', async ({ page }) => {
  const { rows, corrects, wrongs } = await gotoMulti(page);
  expect(corrects.length).toBeGreaterThan(0);
  expect(wrongs.length).toBeGreaterThan(0);

  // Partial: select 1 wrong + 1 correct. On this multi-answer question a wrong
  // pick reveals immediately (incorrect-option), a correct pick shows green.
  await rows.nth(wrongs[0]).click();
  await rows.nth(corrects[0]).click();

  // Navigate to the previous question and back (revisit).
  await page.locator(PREV_BTN).click();
  await expect(page).toHaveURL(new RegExp(`/${M - 1}$`));
  await page.locator(NEXT_BTN).click();
  await expect(page).toHaveURL(new RegExp(`/${M}$`));
  await rows.first().waitFor({ state: 'visible' });

  // Remembered colors must persist: wrong pick red, correct pick green.
  await expect(rows.nth(wrongs[0])).toHaveClass(/incorrect-option/);
  await expect(rows.nth(corrects[0])).toHaveClass(/correct-option/);
});

test('revisit — completing a partial multi-answer grays the remaining option', async ({ page }) => {
  const { rows, corrects, wrongs } = await gotoMulti(page);
  expect(corrects.length).toBe(MULTI.correctCount);
  expect(wrongs.length).toBeGreaterThan(0);

  // First visit: PARTIAL — select all-but-one correct (a wrong pick would lock
  // the question, so complete-on-revisit uses correct picks only).
  for (let i = 0; i < corrects.length - 1; i++) await rows.nth(corrects[i]).click();

  // Navigate forward then back to the multi-answer question (revisit).
  await page.locator(NEXT_BTN).click();
  await expect(page).toHaveURL(new RegExp(`/${M + 1}$`));
  await rows.first().waitFor({ state: 'visible' });
  await page.locator(PREV_BTN).click();
  await expect(page).toHaveURL(new RegExp(`/${M}$`));
  await rows.first().waitFor({ state: 'visible' });

  // On revisit, select the LAST correct — all correct now selected (complete).
  await rows.nth(corrects[corrects.length - 1]).click();

  // Every remaining (unselected, wrong) option must lock to dark gray.
  for (const w of wrongs) {
    await expect(rows.nth(w)).toHaveCSS('background-color', DISABLED_GRAY);
  }
});

test('remembered colors survive a multi-hop round-trip', async ({ page }) => {
  const { rows, corrects, wrongs } = await gotoMulti(page);
  expect(corrects.length).toBeGreaterThan(0);
  expect(wrongs.length).toBeGreaterThan(0);

  // First visit: partial (1 wrong + 1 correct).
  await rows.nth(wrongs[0]).click();
  await rows.nth(corrects[0]).click();

  // Forward -> back -> back -> forward (multi-hop around the question).
  await page.locator(NEXT_BTN).click();
  await expect(page).toHaveURL(new RegExp(`/${M + 1}$`));
  await rows.first().waitFor({ state: 'visible' });
  await page.locator(PREV_BTN).click();
  await expect(page).toHaveURL(new RegExp(`/${M}$`));
  await rows.first().waitFor({ state: 'visible' });
  await page.locator(PREV_BTN).click();
  await expect(page).toHaveURL(new RegExp(`/${M - 1}$`));
  await page.locator(NEXT_BTN).click();
  await expect(page).toHaveURL(new RegExp(`/${M}$`));
  await rows.first().waitFor({ state: 'visible' });

  // Remembered colors must still be there after the full round-trip.
  await expect(rows.nth(wrongs[0])).toHaveClass(/incorrect-option/);
  await expect(rows.nth(corrects[0])).toHaveClass(/correct-option/);
});

test('after completing on revisit, colors persist through a round-trip', async ({ page }) => {
  const { rows, corrects, wrongs } = await gotoMulti(page);
  expect(corrects.length).toBe(MULTI.correctCount);
  expect(wrongs.length).toBeGreaterThan(0);

  // First visit: partial (all-but-one correct), then forward and back.
  for (let i = 0; i < corrects.length - 1; i++) await rows.nth(corrects[i]).click();
  await page.locator(NEXT_BTN).click();
  await expect(page).toHaveURL(new RegExp(`/${M + 1}$`));
  await rows.first().waitFor({ state: 'visible' });
  await page.locator(PREV_BTN).click();
  await expect(page).toHaveURL(new RegExp(`/${M}$`));
  await rows.first().waitFor({ state: 'visible' });

  // Complete it on revisit: select the last correct.
  await rows.nth(corrects[corrects.length - 1]).click();
  for (const w of wrongs) {
    await expect(rows.nth(w)).toHaveCSS('background-color', DISABLED_GRAY);
  }

  // Now back one and forward again: the completed state's colors must persist.
  await page.locator(PREV_BTN).click();
  await expect(page).toHaveURL(new RegExp(`/${M - 1}$`));
  await page.locator(NEXT_BTN).click();
  await expect(page).toHaveURL(new RegExp(`/${M}$`));
  await rows.first().waitFor({ state: 'visible' });

  for (const c of corrects) await expect(rows.nth(c)).toHaveClass(/correct-option/);
  for (const w of wrongs) {
    await expect(rows.nth(w)).toHaveCSS('background-color', DISABLED_GRAY);
  }
});
