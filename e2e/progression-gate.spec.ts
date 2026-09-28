import { test, expect, Page } from '@playwright/test';

import { HEADING, NEXT_BTN, quizData, correctIndicesForHeading } from './helpers';

/**
 * DIRECT-ROUTE PROGRESSION BYPASS — closed by QuizGuard + QuizProgressionService.
 *
 * Before this fix, `QuizGuard` validated only that a requested question index
 * was IN RANGE (1..N), never whether the current attempt had actually earned
 * it — so typing, pasting, or replaying a future question's URL skipped
 * straight to it, no matter how far the user had really progressed.
 *
 * These specs drive the real app end-to-end (real backend, real router,
 * real sessionStorage) and assert on the actual resulting URL/heading, never
 * an internal signal — the same discipline `restart-quiz-lifecycle.spec.ts`
 * uses for the sibling Restart regression.
 *
 * Unit/integration coverage for the pieces themselves lives in
 * `quiz-progression.service.spec.ts` (the service's own persistence and
 * fail-closed behavior) and `quiz-guard.spec.ts` (the guard's redirect
 * logic) — this file only proves the whole stack agrees through a real
 * browser.
 */

test.describe.configure({ timeout: 420_000 });

const ROW = '.option-row';
const RESTART_BTN = '.restart-btn';
const CONFIRM_RESTART_BTN = '.confirm-actions button:has-text("Restart")';
const TILE = '.quiz-tile';

const widgetsQuiz = (quizData as any[]).find((q) => (q.quizId || q.id) === 'fixture-widgets');
const gadgetsQuiz = (quizData as any[]).find((q) => (q.quizId || q.id) === 'fixture-gadgets');

function quizIdFromUrl(page: Page): string {
  const m = page.url().match(/\/quiz\/question\/([^/]+)\//);
  if (!m) throw new Error(`no quizId in URL: ${page.url()}`);
  return m[1];
}

function questionIndexFromUrl(page: Page): number {
  const m = page.url().match(/\/quiz\/question\/[^/]+\/(\d+)/);
  return m ? Number(m[1]) : -1;
}

/** Types/pastes a question URL directly — a fresh navigation, not an SPA route change. */
async function gotoQuestionDirect(page: Page, quizId: string, index: number): Promise<void> {
  await page.goto(`/quiz/question/${quizId}/${index}`);
  await page.locator(ROW).first().waitFor({ state: 'visible', timeout: 15_000 });
}

/** Start a quiz the way a user does: tile → intro → "Start the Quiz!". */
async function startViaUi(page: Page, needle: RegExp): Promise<void> {
  await page.goto('/quiz');
  await page.locator(TILE).first().waitFor({ state: 'visible', timeout: 30_000 });
  const tile = page.locator(TILE).filter({ hasText: needle }).first();
  await tile.scrollIntoViewIfNeeded();
  await tile.click();
  await page.waitForTimeout(1200);
  const start = page.locator('.start-btn').first();
  if ((await start.count()) > 0) await start.click().catch(() => {});
  await page.locator(ROW).first().waitFor({ state: 'visible', timeout: 30_000 });
}

/** Answers the CURRENT (single-answer) question correctly and clicks Next. */
async function answerCorrectlyAndAdvance(page: Page, quiz: any): Promise<void> {
  await page.locator(ROW).first().waitFor({ state: 'visible', timeout: 15_000 });
  const heading = (await page.locator(HEADING).first().textContent()) ?? '';
  const correct = correctIndicesForHeading(quiz, heading);
  const pick = correct.length ? correct[0] : 0;

  await page.locator(ROW).nth(pick).click({ timeout: 5000 });
  // Wait for the real backend verdict, not a fixed delay — proves Next only
  // became clickable once the check actually resolved correct.
  await expect(page.locator(ROW).nth(pick)).toHaveClass(/correct-option/, { timeout: 15_000 });

  await page.locator(NEXT_BTN).first().click({ timeout: 5000 });
  await page.locator(ROW).first().waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForTimeout(400);
}

test.describe('Direct-route progression bypass — fresh direct URL', () => {
  test('a brand-new attempt: typing a future question URL redirects to question 1, and question 1 is what actually renders', async ({ page }) => {
    await gotoQuestionDirect(page, 'fixture-widgets', 5);

    expect(questionIndexFromUrl(page), 'redirected back to question 1').toBe(1);
    const heading = (await page.locator(HEADING).first().textContent()) ?? '';
    expect(heading.toLowerCase()).toContain(widgetsQuiz.questions[0].questionText.split('?')[0].slice(0, 15).toLowerCase());
  });

  test('a brand-new attempt: question 1 itself is allowed directly, with no redirect', async ({ page }) => {
    await gotoQuestionDirect(page, 'fixture-widgets', 1);
    expect(questionIndexFromUrl(page)).toBe(1);
  });
});

test.describe('Direct-route progression bypass — progressive unlock', () => {
  test('completing question 1 unlocks exactly question 2 — question 3 stays locked', async ({ page }) => {
    await startViaUi(page, /fixture widgets/i);
    await answerCorrectlyAndAdvance(page, widgetsQuiz);
    expect(questionIndexFromUrl(page), 'Next legitimately landed on question 2').toBe(2);

    const quizId = quizIdFromUrl(page);
    await gotoQuestionDirect(page, quizId, 3);
    expect(questionIndexFromUrl(page), 'question 3 is not yet earned — redirected to the furthest unlocked (2)').toBe(2);
  });

  test('completing question 2 pushes the furthest-unlocked marker to 3', async ({ page }) => {
    await startViaUi(page, /fixture widgets/i);
    await answerCorrectlyAndAdvance(page, widgetsQuiz); // -> q2
    await answerCorrectlyAndAdvance(page, widgetsQuiz); // -> q3
    expect(questionIndexFromUrl(page)).toBe(3);

    const quizId = quizIdFromUrl(page);
    await gotoQuestionDirect(page, quizId, 4);
    expect(questionIndexFromUrl(page), 'question 4 still not earned — redirected to 3').toBe(3);

    // The now-unlocked question 3 itself, and every question behind it, are
    // both directly reachable — the gate only ever blocks what is AHEAD.
    await gotoQuestionDirect(page, quizId, 3);
    expect(questionIndexFromUrl(page)).toBe(3);
    await gotoQuestionDirect(page, quizId, 1);
    expect(questionIndexFromUrl(page)).toBe(1);
  });
});

test.describe('Direct-route progression bypass — refresh and history', () => {
  test('a refresh on the furthest-unlocked question keeps it unlocked (sessionStorage survives an in-tab reload)', async ({ page }) => {
    await startViaUi(page, /fixture widgets/i);
    await answerCorrectlyAndAdvance(page, widgetsQuiz); // -> q2
    expect(questionIndexFromUrl(page)).toBe(2);

    await page.reload();
    await page.locator(ROW).first().waitFor({ state: 'visible', timeout: 15_000 });
    expect(questionIndexFromUrl(page), 'refresh did not relock the furthest question').toBe(2);
  });

  test('after a refresh, the marker still blocks a not-yet-earned question ahead of it', async ({ page }) => {
    await startViaUi(page, /fixture widgets/i);
    await answerCorrectlyAndAdvance(page, widgetsQuiz); // -> q2
    await page.reload();
    await page.locator(ROW).first().waitFor({ state: 'visible', timeout: 15_000 });

    const quizId = quizIdFromUrl(page);
    await gotoQuestionDirect(page, quizId, 6);
    expect(questionIndexFromUrl(page), 'still redirected to the furthest unlocked (2), not the requested 6').toBe(2);
  });

  test('browser Back to an already-visited earlier question is never redirected', async ({ page }) => {
    await startViaUi(page, /fixture widgets/i);
    await answerCorrectlyAndAdvance(page, widgetsQuiz); // -> q2
    await answerCorrectlyAndAdvance(page, widgetsQuiz); // -> q3
    expect(questionIndexFromUrl(page)).toBe(3);

    await page.goBack();
    await page.locator(ROW).first().waitFor({ state: 'visible', timeout: 15_000 });
    expect(questionIndexFromUrl(page), 'Back revisits question 2 — behind the furthest marker, always allowed').toBe(2);
  });
});

test.describe('Direct-route progression bypass — restart isolation', () => {
  test('confirming Restart relocks every question past 1 — a direct request for the old furthest question redirects to 1', async ({ page }) => {
    await startViaUi(page, /fixture widgets/i);
    await answerCorrectlyAndAdvance(page, widgetsQuiz); // -> q2
    await answerCorrectlyAndAdvance(page, widgetsQuiz); // -> q3
    expect(questionIndexFromUrl(page)).toBe(3);

    const quizId = quizIdFromUrl(page);

    await page.locator(RESTART_BTN).click();
    await page.locator(CONFIRM_RESTART_BTN).click();
    // restartQuiz() mutates the SAME QuizComponent instance in place (no
    // remount), so waiting on `.option-row` visibility alone proves nothing —
    // question 3's own rows are already visible before the reset's async
    // router.navigate() resolves. Wait for the URL itself to actually land on
    // question 1 before reading it.
    await page.waitForURL(new RegExp(`/quiz/question/${quizId}/1$`), { timeout: 15_000 });
    await page.locator(ROW).first().waitFor({ state: 'visible', timeout: 15_000 });
    expect(questionIndexFromUrl(page), 'Restart itself lands back on question 1').toBe(1);

    await gotoQuestionDirect(page, quizId, 3);
    expect(questionIndexFromUrl(page), 'the pre-restart unlock (question 3) no longer applies — relocked to 1').toBe(1);
  });

  test('cancelling the Restart dialog leaves the furthest-unlocked marker intact', async ({ page }) => {
    await startViaUi(page, /fixture widgets/i);
    await answerCorrectlyAndAdvance(page, widgetsQuiz); // -> q2
    expect(questionIndexFromUrl(page)).toBe(2);

    const quizId = quizIdFromUrl(page);

    await page.locator(RESTART_BTN).click();
    await page.locator('.confirm-actions button:has-text("Cancel")').click();
    await page.waitForTimeout(400);

    // Nothing was reset — question 2 (the furthest already reached) is still
    // directly reachable exactly as before the (cancelled) restart attempt.
    await gotoQuestionDirect(page, quizId, 2);
    expect(questionIndexFromUrl(page)).toBe(2);
  });
});

test.describe('Direct-route progression bypass — quiz isolation', () => {
  test('progress in one quiz does not carry over to a different quiz started afterward', async ({ page }) => {
    await startViaUi(page, /fixture widgets/i);
    await answerCorrectlyAndAdvance(page, widgetsQuiz); // -> q2
    await answerCorrectlyAndAdvance(page, widgetsQuiz); // -> q3
    expect(questionIndexFromUrl(page)).toBe(3);

    // Leave via the header logo (an in-SPA route change, not a full reload —
    // a `page.goto` here would tear down state the real user flow never
    // touches and prove nothing about the actual regression).
    const backLink = page.locator('mat-card-header a[href="/select"]').first();
    await backLink.waitFor({ state: 'visible', timeout: 15_000 });
    await backLink.click();
    await page.locator(TILE).first().waitFor({ state: 'visible', timeout: 30_000 });

    await startViaUi(page, /fixture gadgets/i);
    expect(questionIndexFromUrl(page), 'the new quiz starts on its own question 1').toBe(1);

    // A brand-new attempt was minted for the new quiz — the old quiz's
    // furthest-unlocked record (bound to its own quizId+attemptId) cannot
    // authorize anything here.
    await gotoQuestionDirect(page, 'fixture-gadgets', 3);
    expect(questionIndexFromUrl(page), 'the new quiz has earned nothing yet — redirected to 1').toBe(1);
  });
});
