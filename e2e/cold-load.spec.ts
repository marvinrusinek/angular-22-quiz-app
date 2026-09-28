import { test, expect, Page } from '@playwright/test';
import { tsQuiz, diQuiz, HEADING, findQuestionIn, startQuizViaUi, advanceToQuestion } from './helpers';

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

  /**
   * UPDATED for the direct-route progression-bypass fix (2026-09-28): a
   * mid-quiz index with NO earned progress is no longer "a question the app
   * renders on cold load" — it is exactly the bypass QuizGuard now closes.
   * This used to assert the requested question rendered; it now asserts the
   * guard's actual, intended policy instead — the unearned request is
   * corrected back to question 1, and merely REQUESTING that URL (a guard
   * READ) creates or advances nothing. Not preserving the old "renders the
   * requested mid-quiz question with zero progress" behavior — that was the
   * bug, not a feature to keep working.
   */
  test('an unearned direct request for a mid-quiz question redirects to question 1, and the guard read alone creates or advances no attempt', async ({ page }) => {
    const idx = Math.min(4, tsQuiz.questions.length);
    await page.goto(`/quiz/question/fixture-widgets/${idx}`);

    // The URL itself is corrected — not merely "some content rendered".
    await expect(page).toHaveURL(new RegExp(`/quiz/question/fixture-widgets/1$`), { timeout: 15_000 });
    await assertOptionsRender(page, 'fixture-widgets', 1, tsQuiz);

    // A pure guard READ (this request never answered anything, never
    // clicked Next) must never mint an attempt or persist any unlock —
    // QuizProgressionService.unlockThrough() is the ONLY place that may do
    // either, and it is reached only through an approved forward-progression
    // call, never through the guard's own evaluation. See its doc comment.
    const state = await page.evaluate(() => ({
      attemptId: sessionStorage.getItem('currentAttemptId'),
      furthestUnlocked: sessionStorage.getItem('furthestUnlockedQuestion:v1'),
    }));
    expect(state.attemptId, 'a guard read alone must never mint an attempt').toBeNull();
    expect(state.furthestUnlocked, 'a guard read alone must never persist an unlock').toBeNull();
  });

  test('fixture-gadgets Q1 (from the multi-answer bank) renders options on a fresh deep-link', async ({ page }) => {
    await page.goto('/quiz/question/fixture-gadgets/1');
    await assertOptionsRender(page, 'fixture-gadgets', 1, diQuiz);
  });

  /**
   * UPDATED: a reload only legitimately reaches question 3 by first EARNING
   * it — start through the public UI and progress there for real, THEN
   * reload the resulting URL. A direct goto straight to question 3 with no
   * progress is the same bypass the test above now covers; this one instead
   * pins the thing that must still work — a reload of an ALREADY-unlocked
   * question keeps rendering it, not just after a cold direct load of it.
   */
  test('a reload of a LEGITIMATELY-reached question keeps rendering it (earned location/state survives)', async ({ page }) => {
    const idx = Math.min(3, tsQuiz.questions.length);
    await startQuizViaUi(page, 'fixture-widgets', /fixture widgets/i);
    await advanceToQuestion(page, tsQuiz, idx);
    await assertOptionsRender(page, 'fixture-widgets', idx, tsQuiz);

    await page.reload();

    // The reload must NOT relock — sessionStorage (attemptId + the
    // furthest-unlocked marker) survives an in-tab reload by design.
    await expect(page).toHaveURL(new RegExp(`/quiz/question/fixture-widgets/${idx}$`), { timeout: 15_000 });
    await assertOptionsRender(page, 'fixture-widgets', idx, tsQuiz);
  });
});
