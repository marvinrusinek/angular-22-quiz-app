import { test, expect, Page } from '@playwright/test';

import { diQuiz, correctIndicesForHeading, correctIndexForHeading, HEADING, NEXT_BTN, PREV_BTN, startQuizViaUi, advanceToQuestion } from './helpers';

/**
 * "Answered ✓" MEANS COMPLETED, NOT MERELY ATTEMPTED.
 *
 * ── The regression this pins ──────────────────────────────────────
 *
 * One click on a three-correct multi-answer question made it report
 * "Answered ✓ Click Next to continue..." on every later revisit, for the rest
 * of the session.
 *
 * The message branch read
 *
 *     remainingCorrectFromVerdict(index) ?? (totalCorrect - selectedCorrect)
 *
 * The verdict answers null while `/check` is in flight — always the case at
 * click time under the API adapter — so the fallback decided it. API-sourced
 * options carry no `correct` flag, so `totalCorrect` and `selectedCorrect` were
 * both 0, and `0 - 0 === 0` satisfied "all correct answers selected".
 *
 * That emitted the Next-button message, and `pushMessage` records ANY
 * Next/Show-Results message into `_completedIdxSet` — the set the revisit
 * derivation reads. A transient wrong message therefore became a permanent
 * false claim of completion.
 *
 * ── Why these assert the MESSAGE and not internal state ───────────
 *
 * The defect was invisible live: the verdict landed a moment later and
 * corrected the displayed text, so only the REVISIT exposed it. Every case
 * below therefore navigates away and back, which is the only place the
 * completion record is observable.
 */

const MSG = '.instructions-message';
const ANSWERED = 'Answered ✓ Click Next to continue...';

/**
 * Away and back — the only view that reads the completion record. ONLY
 * legitimate for a question that is already resolved-correct (or expired):
 * `progression-gate.ts`'s mandatory-progression rule (introduced in the same
 * commit as this repo's current HEAD, 11c275ec) blocks Next on anything
 * else, so a Next-then-Previous round trip on a WRONG or PARTIAL question
 * would hang on a permanently-disabled Next button — see
 * `revisitUnresolvedViaBackward` below for that case instead.
 */
async function roundTrip(page: Page): Promise<void> {
  await page.locator(NEXT_BTN).click();
  await page.locator('.option-row').first().waitFor({ state: 'visible' });
  await page.waitForTimeout(500);
  await page.locator(PREV_BTN).click();
  await page.locator('.option-row').first().waitFor({ state: 'visible' });
}

/**
 * Revisits the CURRENT question — which is NOT resolved-correct, so it
 * cannot be left forward — the only way that remains legitimate: backward
 * first (always allowed, regardless of verdict state), then forward again
 * into this same, already-unlocked question. This is the identical pattern
 * `ma-revisit-completion.spec.ts` and `multi-answer-score.spec.ts` already
 * use for a partial multi-answer question, for the same underlying reason.
 * Requires the current question to be > 1 (so a Previous target exists) and
 * already unlocked (i.e. reached via legitimate forward progress already).
 */
async function revisitUnresolvedViaBackward(page: Page): Promise<void> {
  const before = page.url();
  await page.locator(PREV_BTN).click();
  await page.locator('.option-row').first().waitFor({ state: 'visible' });
  await page.waitForTimeout(500);
  await page.locator(NEXT_BTN).click();
  await page.locator('.option-row').first().waitFor({ state: 'visible' });
  await expect(page).toHaveURL(new RegExp(before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'));
}

/**
 * Reaches the shared 3-correct multi-answer question (fixture-gadgets Q3)
 * legitimately — Start + progress through Q1-Q2 — rather than a direct
 * `page.goto` straight to it, which QuizGuard now correctly redirects on a
 * fresh attempt (Root Cause B, direct-route P1; see helpers.ts).
 */
async function openDiMulti(page: Page): Promise<number[]> {
  await startQuizViaUi(page, 'fixture-gadgets', /fixture gadgets/i);
  await advanceToQuestion(page, diQuiz, 3);
  await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 30_000 });
  const heading = (await page.locator(HEADING).first().textContent()) ?? '';
  const correct = correctIndicesForHeading(diQuiz, heading);
  expect(correct.length, 'fixture must be a 3-correct question').toBe(3);
  return correct;
}

test.describe('revisit reports completion, not attempts', () => {
  test('single-answer answered CORRECTLY reports Answered', async ({ page }) => {
    // Public UI, not a direct goto — this test's own roundTrip() (Next then
    // Previous) needs a real attempt to persist its unlock (Root Cause A,
    // direct-route P1).
    await startQuizViaUi(page, 'fixture-widgets', /fixture widgets/i);

    await page.locator('.option-row').nth(0).click();   // ':' is correct
    await expect(page.locator(MSG)).toHaveText(
      'Please click the Next button to continue.', { timeout: 15_000 }
    );

    await roundTrip(page);
    await expect(page.locator(MSG)).toHaveText(ANSWERED, { timeout: 15_000 });
  });

  test('single-answer answered WRONGLY does NOT report Answered', async ({ page }) => {
    // DIAGNOSED (not a harmless pre-existing gap): `progression-gate.ts`'s
    // mandatory-progression rule landed in this repo's current HEAD commit
    // (11c275ec) and blocks Next on anything short of resolved-correct/
    // expired; this test predates that commit (last touched in 8c0cdfdc) and
    // was never re-verified against it. Question 1 itself can never be the
    // WRONGLY-answered question under test here — it has no Previous to
    // leave-and-return through — so Q2 is the actual subject: Q1 is
    // answered CORRECTLY to legitimately reach it (forward movement
    // required, so it must be a correct pick), then Q2 is answered wrong and
    // revisited the only way a not-resolved-correct question can be:
    // backward first, then forward again (see revisitUnresolvedViaBackward).
    // The assertion itself — a wrongly-answered question must not read as
    // completed — is unchanged.
    await startQuizViaUi(page, 'fixture-widgets', /fixture widgets/i);

    const h1 = (await page.locator(HEADING).textContent()) ?? '';
    await page.locator('.option-row').nth(correctIndexForHeading(h1)).click();
    await expect(page.locator(NEXT_BTN)).toBeEnabled({ timeout: 15_000 });
    await page.locator(NEXT_BTN).click();
    await expect(page).toHaveURL(/\/2$/);
    await page.locator('.option-row').first().waitFor({ state: 'visible' });

    const h2 = (await page.locator(HEADING).textContent()) ?? '';
    const wrongIdx = correctIndexForHeading(h2) === 0 ? 1 : 0;
    await page.locator('.option-row').nth(wrongIdx).click();
    await expect(page.locator(MSG)).toHaveText(
      'Please select the correct answer to continue.', { timeout: 15_000 }
    );

    await revisitUnresolvedViaBackward(page);
    await expect(page.locator(MSG)).not.toHaveText(ANSWERED, { timeout: 15_000 });
  });

  test('multi-answer PARTIALLY answered does NOT report Answered', async ({ page }) => {
    // DIAGNOSED (see the single-answer WRONGLY test's comment above for the
    // full root cause: the mandatory-progression rule in this repo's current
    // HEAD, 11c275ec, blocks Next on anything short of resolved-correct/
    // expired). Q3 (openDiMulti) already has Q2 as a legitimate Previous
    // target, so — unlike Q1 in the single-answer case — the fix here is
    // only to revisit the correct DIRECTION: backward then forward, never
    // forward then backward, for a question that is not resolved-correct.
    const correct = await openDiMulti(page);

    // ONE of three. This is the exact regression: before the fix, this single
    // click recorded the question as completed for the rest of the session.
    await page.locator('.option-row').nth(correct[0]).click();
    await expect(page.locator(MSG)).toContainText(/Select \d+ more correct answer/, { timeout: 15_000 });

    await revisitUnresolvedViaBackward(page);
    await expect(page.locator(MSG)).not.toHaveText(ANSWERED, { timeout: 15_000 });
  });

  test('multi-answer FULLY answered reports Answered', async ({ page }) => {
    const correct = await openDiMulti(page);

    for (const ci of correct) {
      await page.locator('.option-row').nth(ci).click({ timeout: 10_000 });
      await page.waitForTimeout(700);
    }
    // Proves every correct option actually registered — without this the test
    // can pass while still partial, which is how the original diagnosis nearly
    // recorded a false negative.
    await expect(page.locator(MSG)).toHaveText(
      'Please click the Next button to continue.', { timeout: 15_000 }
    );

    await roundTrip(page);
    await expect(page.locator(MSG)).toHaveText(ANSWERED, { timeout: 15_000 });
  });

  test('WRONG first, then completed correctly, still reports Answered', async ({ page }) => {
    const correct = await openDiMulti(page);
    const wrong = [0, 1, 2, 3].filter((i) => !correct.includes(i));

    await page.locator('.option-row').nth(wrong[0]).click();
    await page.waitForTimeout(700);
    for (const ci of correct) {
      await page.locator('.option-row').nth(ci).click({ timeout: 10_000 }).catch(() => {
        // a completed question may lock remaining options; the assertion below
        // is what decides the outcome.
      });
      await page.waitForTimeout(700);
    }

    await roundTrip(page);
    // A wrong pick along the way must not deny credit for finishing.
    await expect(page.locator(MSG)).toHaveText(ANSWERED, { timeout: 15_000 });
  });
});

test.describe('multi-answer selection painting', () => {
  /**
   * correct → incorrect → correct on a 3-correct question.
   *
   * The unselected third correct option must stay NEUTRAL: revealing it early
   * would hand the user an answer they have not earned, which is the disclosure
   * the whole verdict migration exists to prevent.
   */
  test('selected correct stay green, wrong is red, unselected correct stays neutral', async ({ page }) => {
    const correct = await openDiMulti(page);
    const wrong = [0, 1, 2, 3].filter((i) => !correct.includes(i));
    const rows = page.locator('.option-row');

    await rows.nth(correct[0]).click();
    await expect(rows.nth(correct[0])).toHaveClass(/correct-option/, { timeout: 15_000 });

    await rows.nth(wrong[0]).click();
    await expect(rows.nth(wrong[0])).toHaveClass(/incorrect-option/, { timeout: 15_000 });
    // The first correct pick keeps its green through the wrong click.
    await expect(rows.nth(correct[0])).toHaveClass(/correct-option/);

    await rows.nth(correct[1]).click();
    await expect(rows.nth(correct[1])).toHaveClass(/correct-option/, { timeout: 15_000 });
    await expect(rows.nth(correct[0])).toHaveClass(/correct-option/);

    // The correct option the user has NOT selected is still unrevealed.
    await expect(rows.nth(correct[2])).not.toHaveClass(/correct-option/);
    await expect(rows.nth(correct[2])).not.toHaveClass(/incorrect-option/);
  });
});
