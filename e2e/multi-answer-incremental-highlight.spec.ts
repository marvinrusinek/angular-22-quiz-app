import { test, expect, Page } from '@playwright/test';

import { diQuiz, correctIndicesForHeading, HEADING, NEXT_BTN, PREV_BTN } from './helpers';

/**
 * THE REGRESSION: on a multi-answer question with 3 correct options, picking
 * only ONE correct answer immediately painted ALL THREE correct options
 * green.
 *
 * ── Root cause ──────────────────────────────────────────────────────
 *
 * `question-resolution.service.ts#resolveMultiPerfect` read
 * `quizService.isQuestionResolved(qIdx)` as its "multi-answer PERFECT" signal.
 * That flag means only "some /check submission for this question resolved" —
 * true for a WRONG single-answer pick, and for multi-answer only ever set on
 * a genuinely full completion, but it answers "did this resolve", never "was
 * every correct option selected with nothing wrong". `isMultiAnswerPerfect`
 * is the actual authority for that: written exclusively by
 * `SelectedOptionService.applyAuthorizedMultiCompletion` when the backend
 * verdict reports full, clean completion for THIS question.
 *
 * Because `resolveMultiPerfect` fed a "resolved" (not "perfect") signal into
 * `combineFullyResolvedCorrect`'s `(isCanonMulti && multiPerfect)` term,
 * `fullyResolvedCorrect` could read true from an unrelated resolution. Every
 * option render runs through `option-item.component.ts#getRevisitOptionClasses`
 * UNCONDITIONALLY (no revisit gate), so once `fullyResolvedCorrect` is true it
 * paints every option in the authorized reveal set green — including the two
 * the user never touched.
 *
 * Fixed by reading `isMultiAnswerPerfect` (see question-resolution.service.ts).
 *
 * ── The contract pinned here ────────────────────────────────────────
 *
 * Picking correct answer #1 of 3 highlights ONLY #1; #2/#3 stay neutral.
 * Picking #2 highlights #1+#2; #3 stays neutral. Only picking #3 (completing
 * the question) reveals the full set.
 */

const MSG = '.instructions-message';

async function openDiMulti(page: Page): Promise<number[]> {
  await page.goto('/quiz/question/dependency-injection/3');
  await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 30_000 });
  const heading = (await page.locator(HEADING).first().textContent()) ?? '';
  const correct = correctIndicesForHeading(diQuiz, heading);
  expect(correct.length, 'fixture must have exactly 3 correct options').toBe(3);
  return correct;
}

async function classesOf(page: Page, i: number): Promise<string> {
  return (await page.locator('.option-row').nth(i).getAttribute('class')) ?? '';
}

test.describe('multi-answer incremental highlighting (3-correct question)', () => {
  test('selecting correct #1 of 3 highlights ONLY #1 — #2/#3 stay neutral, no FET', async ({ page }) => {
    const correct = await openDiMulti(page);

    await page.locator('.option-row').nth(correct[0]).click({ timeout: 15_000 });
    await expect(page.locator(MSG)).toBeVisible({ timeout: 15_000 });

    expect(await classesOf(page, correct[0])).toContain('correct-option');

    for (const i of [correct[1], correct[2]]) {
      const cls = await classesOf(page, i);
      expect(cls, `option ${i} must stay neutral after only 1 of 3 picks`).not.toContain('correct-option');
      expect(cls, `option ${i} must stay neutral after only 1 of 3 picks`).not.toContain('selected-option');
    }

    // No FET yet — the question stays visible, not the explanation.
    const heading = await page.locator(HEADING).first().innerHTML();
    expect(heading.toLowerCase()).not.toContain('because');
  });

  test('selecting correct #2 of 3 highlights #1+#2 — #3 stays neutral, no FET', async ({ page }) => {
    const correct = await openDiMulti(page);

    await page.locator('.option-row').nth(correct[0]).click({ timeout: 15_000 });
    await expect(page.locator(MSG)).toBeVisible({ timeout: 15_000 });
    await page.locator('.option-row').nth(correct[1]).click({ timeout: 15_000 });
    await page.waitForTimeout(800);

    expect(await classesOf(page, correct[0])).toContain('correct-option');
    expect(await classesOf(page, correct[1])).toContain('correct-option');

    const cls2 = await classesOf(page, correct[2]);
    expect(cls2, 'the third, unpicked correct option must stay neutral').not.toContain('correct-option');
  });

  test('completing all 3 correct picks reveals the full set and the FET', async ({ page }) => {
    const correct = await openDiMulti(page);

    for (const i of correct) {
      await page.locator('.option-row').nth(i).click({ timeout: 15_000 });
      await page.waitForTimeout(400);
    }

    for (const i of correct) {
      expect(await classesOf(page, i)).toContain('correct-option');
    }
  });

  test('an INCORRECT pick never reveals the other correct options', async ({ page }) => {
    const correct = await openDiMulti(page);
    const wrong = [0, 1, 2, 3].find((i) => !correct.includes(i))!;

    await page.locator('.option-row').nth(wrong).click({ timeout: 15_000 });
    await page.waitForTimeout(800);

    for (const i of correct) {
      const cls = await classesOf(page, i);
      expect(cls, `correct option ${i} must not leak from an incorrect pick`).not.toContain('correct-option');
    }
  });

  test('a genuine revisit of a PARTIAL multi-answer question still shows only the picked option, never the full set', async ({ page }) => {
    const correct = await openDiMulti(page);

    await page.locator('.option-row').nth(correct[0]).click({ timeout: 15_000 });
    await page.waitForTimeout(800);

    await page.locator(PREV_BTN).click({ timeout: 15_000 });
    await page.waitForTimeout(800);
    await page.locator('.option-row').first().click({ timeout: 15_000 }); // answer Q2 so Next unlocks
    await page.waitForTimeout(800);
    await page.locator(NEXT_BTN).click({ timeout: 15_000 });
    await page.waitForTimeout(1200);

    expect(await classesOf(page, correct[0])).toContain('correct-option');
    for (const i of [correct[1], correct[2]]) {
      expect(await classesOf(page, i)).not.toContain('correct-option');
    }
  });
});
