import { test, expect, Page } from '@playwright/test';
import { diQuiz, correctIndicesForHeading, HEADING } from './helpers';

/**
 * THE REGRESSION: Topic Quiz displayed the literal text "Checking…" for
 * however long `/check` took to resolve — exposing backend request mechanics
 * to the user, which is explicitly forbidden for Topic Quiz (Interview Mode's
 * own persistence UI is a separate, unrelated surface and is untouched here).
 *
 * `selection-message.service.ts#computeFinalMessage` returned a literal
 * "Checking…" string, synchronously, the instant a pick was made and before
 * its `/check` verdict existed. On a slow backend this was visible long
 * enough to read.
 *
 * Fixed by preserving whatever NEUTRAL message was already on screen before
 * the click (`_lastMessageByIndex`, falling back to the fresh-question
 * prompt) while /check is in flight, and letting the existing
 * `recomputeWhenVerdictArrives` one-shot subscription push the REAL message
 * the moment the verdict lands — no intermediate request-status text ever
 * renders.
 */
async function holdCheckPending(page: Page): Promise<() => void> {
  let released: () => void;
  const gate = new Promise<void>((res) => { released = res; });
  await page.route('**/api/quizzes/*/check', async (route) => {
    await gate;
    await route.continue();
  });
  return () => released!();
}

async function assertNoRequestStatusText(page: Page): Promise<void> {
  const msg = (await page.locator('.instructions-message').textContent()) ?? '';
  for (const bad of ['Checking', 'Saving', 'Loading', 'Submitting']) {
    expect(msg, `must not display request-status text "${bad}"`).not.toContain(bad);
  }
}

test.describe('Topic Quiz shows no request-status text while /check is pending', () => {
  test('single-answer: neutral pending, no red/green until the verdict lands', async ({ page }) => {
    const release = await holdCheckPending(page);

    await page.goto('/quiz/question/fixture-widgets/1');
    await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 30000 });
    await page.locator('.option-row').first().click({ timeout: 15000 });
    await page.waitForTimeout(1500);

    await assertNoRequestStatusText(page);

    const cls = await page.locator('.option-row').first().getAttribute('class');
    expect(cls, 'must not prematurely reveal correct/incorrect while pending').not.toMatch(
      /(^|\s)(correct-option|incorrect-option)(\s|$)/
    );

    release();
    await page.waitForTimeout(1500);
    await assertNoRequestStatusText(page);
    const msgAfter = await page.locator('.instructions-message').textContent();
    expect(msgAfter).toBe('Please click the Next button to continue.');
  });

  test('multi-answer: neutral pending on the first-ever pick, no request-status text', async ({ page }) => {
    const release = await holdCheckPending(page);

    await page.goto('/quiz/question/fixture-gadgets/3');
    await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 30000 });
    const heading = (await page.locator(HEADING).first().textContent()) ?? '';
    const correct = correctIndicesForHeading(diQuiz, heading);
    expect(correct.length).toBe(3);

    await page.locator('.option-row').nth(correct[0]).click({ timeout: 15000 });
    await page.waitForTimeout(1500);

    await assertNoRequestStatusText(page);

    release();
    await page.waitForTimeout(1500);
    await assertNoRequestStatusText(page);
  });
});
