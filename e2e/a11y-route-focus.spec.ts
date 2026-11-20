import { test, expect } from '@playwright/test';
import { quizData, startQuizViaUi, advanceToQuestion, HEADING, NEXT_BTN, PREV_BTN } from './helpers';

/**
 * Each ready question starts at the existing top-left logo link, including
 * initial entry, reload, Next and Previous. Same-question answer, feedback
 * and timer updates must not reclaim focus. These are browser-focus checks;
 * Narrator speech and highlight rectangles require a manual test.
 * Existing Next/Previous live announcements are covered separately.
 */

const doohickeys = quizData.find((q: any) => (q.quizId || q.id) === 'fixture-doohickeys');
const LOGO = 'codelab-quiz-header a:has(img.header-image)';
const HEADING_H3 = `${HEADING}[tabindex="-1"]`;

async function headingState(page: import('@playwright/test').Page) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return { found: false as const };
    return {
      found: true as const,
      isFocused: document.activeElement === el,
      text: (el.textContent || '').trim(),
    };
  }, HEADING_H3);
}

test.describe('Topic Quiz route focus — every question change, never on answer/feedback/timer updates (fix regression)', () => {
  test('arriving at Q1 from Introduction focuses the logo with matching question content', async ({ page }) => {
    await startQuizViaUi(page, 'fixture-doohickeys', /fixture doohickeys/i);

    const state = await headingState(page);
    if (!state.found) throw new Error('heading element not found');
    await expect(page.locator(LOGO)).toBeFocused();
    expect(state.text.length).toBeGreaterThan(0);
    expect(state.text).toContain(doohickeys.questions[0].questionText.slice(0, 20));
  });

  test('reloading the first question returns focus to the logo', async ({ page }) => {
    await startQuizViaUi(page, 'fixture-doohickeys', /fixture doohickeys/i);
    await page.reload();
    await expect(page.locator(LOGO)).toBeFocused();
  });

  test('cold entry keeps focus at the logo after the page settles', async ({ page }) => {
    await startQuizViaUi(page, 'fixture-doohickeys', /fixture doohickeys/i);

    const first = await headingState(page);
    if (!first.found) throw new Error('heading element not found');
    await expect(page.locator(LOGO)).toBeFocused();

    // Give any later-settling work (the cold-start overlay's own minimum
    // display floor, any trailing async option-binding work) a full window
    // to finish, then confirm focus is still exactly where it was.
    await page.waitForTimeout(1800);

    const second = await headingState(page);
    expect(second.found).toBe(true);
    await expect(page.locator(LOGO)).toBeFocused();
    expect(second.text).toBe(first.text);
  });

  test('Next and Previous return focus to the logo with current question content', async ({ page }) => {
    await startQuizViaUi(page, 'fixture-doohickeys', /fixture doohickeys/i);

    const correctIdx = doohickeys.questions[0].options.findIndex(
      (o: any) => o.correct === true || o.correct === 'true'
    );
    await page.locator('.option-row').nth(correctIdx).click();
    await page.waitForTimeout(600);

    const nextBtn = page.locator(NEXT_BTN);
    await expect(nextBtn).toBeEnabled({ timeout: 10_000 });
    await nextBtn.click();
    await advanceToQuestion(page, doohickeys, 2);
    await page.waitForTimeout(300);

    const state = await headingState(page);
    if (!state.found) throw new Error('heading element not found');
    await expect(page.locator(LOGO)).toBeFocused();
    expect(state.text).toContain(doohickeys.questions[1].questionText.slice(0, 20));
    // Genuinely a different question's text, not a stale re-focus of Q1's.
    expect(state.text).not.toContain(doohickeys.questions[0].questionText.slice(0, 20));

    await page.locator(PREV_BTN).click();
    await expect(page.locator(LOGO)).toBeFocused();
    await expect(page.locator(HEADING).first()).toContainText(
      doohickeys.questions[0].questionText.slice(0, 20)
    );
  });

  test('answer and timer updates do not reclaim focus for the logo', async ({ page }) => {
    await startQuizViaUi(page, 'fixture-doohickeys', /fixture doohickeys/i);

    // Initial arrival focused the logo — move focus elsewhere
    // (onto the option itself, as a real click does) before triggering the
    // answer/feedback update under test.
    const correctIdx = doohickeys.questions[0].options.findIndex(
      (o: any) => o.correct === true || o.correct === 'true'
    );
    const row = page.locator('.option-row').nth(correctIdx);
    await row.click();
    await page.waitForTimeout(900); // past the feedback announcer's 400ms stagger too

    const state = await headingState(page);
    if (!state.found) throw new Error('heading element not found');
    // Verdict/feedback effects fired for the same question.
    // Neither the logo nor the heading may reclaim focus during answering.
    expect(state.isFocused).toBe(false);
    await expect(page.locator(LOGO)).not.toBeFocused();
    await page.waitForTimeout(1500);
    await expect(page.locator(LOGO)).not.toBeFocused();
  });

  test('rapid navigation keeps current content and logo focus; leaving destroys pending callbacks safely', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      // NG02955 (NgOptimizedImage LCP-priority advisory on QuizSelection's
      // tile images) is a pre-existing Angular dev-mode diagnostic, unrelated
      // to focus management — it fires whenever /quiz loads, regardless of
      // this fix. Everything else still fails the test.
      if (msg.text().includes('NG02955')) return;
      errors.push(msg.text());
    });

    await startQuizViaUi(page, 'fixture-doohickeys', /fixture doohickeys/i);

    for (let q = 0; q < 2; q++) {
      const correctIdxs: number[] = doohickeys.questions[q].options
        .map((o: any, i: number) => ((o.correct === true || o.correct === 'true') ? i : -1))
        .filter((i: number) => i >= 0);
      for (const idx of correctIdxs) {
        await page.locator('.option-row').nth(idx).click();
      }
      const nextBtn = page.locator(NEXT_BTN);
      await expect(nextBtn).toBeEnabled({ timeout: 10_000 });
      // Click Next immediately — deliberately inside the feedback
      // announcer's stagger window, and before any afterNextRender focus
      // callback from THIS click has necessarily run yet.
      await nextBtn.click();
    }
    await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForTimeout(500);

    // The final question is current and the logo holds focus.
    const afterRapidNav = await headingState(page);
    if (!afterRapidNav.found) throw new Error('heading element not found');
    await expect(page.locator(LOGO)).toBeFocused();
    expect(afterRapidNav.text).toContain(doohickeys.questions[2].questionText.slice(0, 20));
    expect(afterRapidNav.text).not.toContain(doohickeys.questions[0].questionText.slice(0, 20));
    expect(afterRapidNav.text).not.toContain(doohickeys.questions[1].questionText.slice(0, 20));

    // Navigate away entirely while a focus effect could still be pending —
    // this component (and its injector) is destroyed mid-flight.
    await page.goto('/quiz');
    await page.locator('.quiz-tile').first().waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForTimeout(300);

    expect(errors).toEqual([]);
  });
});
