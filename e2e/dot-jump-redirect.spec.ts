import { test, expect } from '@playwright/test';
import { HEADING, startQuizViaUi, norm } from './helpers';

/**
 * Pagination dots open the exact question, answered or not. From an UNANSWERED Q1, dot 5 opens Q5; from the unanswered Q5, dot 4
 * opens Q4. Skipped questions stay unanswered: nothing is sent to /check for them, no verification notice appears, answering Q4
 * verifies Q4's own text and options with exactly one request, and revisiting Q5, Q4 and Q1 by dot keeps working.
 */
test.describe('pagination dots open the exact question', () => {
  test('unanswered Q1 -> dot 5 -> unanswered Q5 -> dot 4, then answer and revisit', async ({ page }) => {
    await startQuizViaUi(page, 'fixture-widgets', /fixture widgets/i);

    const checks: { questionText: string; selectedOptionTexts: string[] }[] = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && /\/quizzes\/[^/]+\/check$/.test(req.url())) checks.push(req.postDataJSON());
    });

    const rows = page.locator('.option-row');
    const dot = (n: number) => page.locator('.paging-dots .dot').nth(n - 1);
    const heading = async () => ((await page.locator(HEADING).first().textContent()) ?? '').trim();
    const onQuestion = async (n: number) => {
      await expect(page).toHaveURL(new RegExp('/quiz/question/[^/]+/' + n + '$'));
      await rows.first().waitFor({ state: 'visible', timeout: 20_000 });
    };

    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });
    const q1Heading = await heading();

    // Q1 is still unanswered: dot 5 is not gated and opens Q5 itself, not Q2.
    await expect(dot(5)).not.toHaveClass(/disabled/);
    await dot(5).click();
    await onQuestion(5);
    const q5Heading = await heading();
    expect(norm(q5Heading)).not.toBe(norm(q1Heading));

    // Q5 is unanswered too: dot 4 opens Q4.
    await dot(4).click();
    await onQuestion(4);
    const q4Heading = await heading();
    expect(norm(q4Heading)).not.toBe(norm(q5Heading));
    const optionTexts = (await rows.allTextContents()).map((t) => norm(t));

    // Skipping alone verified nothing and flagged nothing.
    expect(checks).toHaveLength(0);
    await expect(page.locator('codelab-verdict-notice')).toHaveCount(0);

    // Answer Q4: exactly one verification, for Q4's own text and options.
    const responsePromise = page.waitForResponse((r) => /\/quizzes\/[^/]+\/check$/.test(r.url()));
    await rows.first().click();
    expect((await responsePromise).status()).toBe(200);
    expect(checks).toHaveLength(1);
    expect(norm(checks[0].questionText)).toBe(norm(q4Heading));
    for (const picked of checks[0].selectedOptionTexts) {
      expect(optionTexts.some((t) => t.includes(norm(picked)))).toBe(true);
    }

    // Revisits by dot: Q5 (still unanswered), Q4 (answer kept), Q1 (still unanswered). No new checks, no notice.
    await dot(5).click();
    await onQuestion(5);
    expect(norm(await heading())).toBe(norm(q5Heading));
    await dot(4).click();
    await onQuestion(4);
    expect(norm(await heading())).toBe(norm(q4Heading));
    await dot(1).click();
    await onQuestion(1);
    expect(norm(await heading())).toBe(norm(q1Heading));

    expect(checks).toHaveLength(1);
    await expect(page.locator('codelab-verdict-notice')).toHaveCount(0);
  });
});
