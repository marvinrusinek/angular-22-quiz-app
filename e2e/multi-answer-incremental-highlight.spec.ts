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
  await page.goto('/quiz/question/fixture-gadgets/3');
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

  /**
   * THE REGRESSION (live report): correct -> WRONG -> correct -> correct.
   * clicking correct #2 and #3 after an earlier wrong pick both rendered
   * "Not this one, try again!" — the wrong click's verdict, stuck in the
   * question's selectedVerdicts map, was read as "any wrong ever selected"
   * instead of "was THIS click's own option wrong". Same mistake on
   * completion: an earlier wrong pick also blocked the final win message
   * even once the server's own SUPERSET rule resolved the question correct.
   * Fixed in feedback.service.ts (see its own comments for the exact trace).
   */
  test('a wrong pick does NOT poison later correct clicks\' messages (correct -> wrong -> correct -> correct)', async ({ page }) => {
    const correct = await openDiMulti(page);
    const wrong = [0, 1, 2, 3].find((i) => !correct.includes(i))!;
    const FEEDBACK = 'codelab-quiz-feedback';

    // Click 1: correct.
    await page.locator('.option-row').nth(correct[0]).click({ timeout: 15_000 });
    await page.waitForTimeout(800);
    let msg = (await page.locator(FEEDBACK).textContent()) ?? '';
    expect(msg).toContain("That's correct");
    expect(msg).not.toContain('Not this one');

    // Click 2: the genuinely wrong option — SHOULD say "Not this one".
    await page.locator('.option-row').nth(wrong).click({ timeout: 15_000 });
    await page.waitForTimeout(800);
    msg = (await page.locator(FEEDBACK).textContent()) ?? '';
    expect(msg).toContain('Not this one, try again!');

    // Click 3: correct again — must NOT still say "Not this one" (the bug).
    await page.locator('.option-row').nth(correct[1]).click({ timeout: 15_000 });
    await page.waitForTimeout(800);
    msg = (await page.locator(FEEDBACK).textContent()) ?? '';
    expect(msg, 'click 3 (correct) must not repeat click 2\'s wrong message').not.toContain('Not this one');
    expect(msg).toContain("That's correct");

    // Click 4: final correct pick — completes the question; must show the WIN
    // message, not the leftover wrong message, despite the earlier wrong pick.
    await page.locator('.option-row').nth(correct[2]).click({ timeout: 15_000 });
    await page.waitForTimeout(800);
    msg = (await page.locator(FEEDBACK).textContent()) ?? '';
    expect(msg, 'completion must not repeat the earlier wrong message').not.toContain('Not this one');
    expect(msg).toContain("You're right");

    // Highlighting stays correct throughout: all 3 correct options green,
    // the wrong one never shown as correct. Word-boundary match — a plain
    // substring check would false-positive on "incorrect-option".
    for (const i of correct) {
      expect(await classesOf(page, i)).toMatch(/\bcorrect-option\b/);
    }
    expect(await classesOf(page, wrong)).not.toMatch(/\bcorrect-option\b/);
    expect(await classesOf(page, wrong)).toContain('incorrect-option');
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

/**
 * ROUND 2 OF THE SAME REGRESSION: fully complete a 3-correct question once,
 * leave to QuizSelection (no explicit Restart), re-enter the SAME quiz, and
 * pick only ONE correct option this time — the OLD completion painted the
 * full set green on the very first click of the NEW attempt.
 *
 * ── Root cause ──────────────────────────────────────────────────────
 *
 * The Round 1 fix (`isMultiAnswerPerfect`, above) stayed correct and intact.
 * This was a DIFFERENT gap in the same family: `resetUIAndNavigate`'s "fresh
 * start guard" (entering Q1 from Intro's "Start the Quiz!") already resets
 * score and selections unconditionally on every entry, but never cleared the
 * PARALLEL per-question completion authorities —
 * `_questionResolved` / `_multiAnswerCompletion` / `_multiAnswerPerfect`
 * (QuizService) and the durable verdict store (QuestionVerdictService, which
 * also backs `authorizedCorrectTexts`'s revealed-correct-set). A question
 * completed in an EARLIER visit this tab session survived, fully intact,
 * into a brand new attempt — `getRevisitOptionClasses` (unconditional) then
 * read the leftover `isMultiAnswerPerfect === true` / revealed-set-populated
 * state and painted it onto the new attempt's very first click.
 *
 * ── Why the existing coverage didn't catch this ──────────────────────
 *
 * Every prior multi-answer highlighting test opened the question via a fresh
 * Playwright browser context (`page.goto` cold, or a single continuous
 * session) — none of them modeled "this exact question was already fully
 * completed earlier in the SAME tab session, then the user left and came
 * back." That sequence is exactly what real manual use (and this test) now
 * exercises.
 *
 * Fixed by clearing `clearAllAnswerState()` + `questionVerdictService
 * .clearAll()` + `.clearEarnedVerdicts(quizId)` in the SAME fresh-start guard
 * that already clears score/selections — re-entry is, and always was
 * (per that guard's pre-existing score/selection reset), a genuinely fresh
 * attempt, not a revisit of the earlier one.
 */
test.describe('multi-answer highlighting survives a completed-then-re-entered quiz', () => {
  test('completing a 3-correct question once, then re-entering the SAME quiz, does not leak the old completion onto a fresh partial pick', async ({ page }) => {
    await page.goto('/select');
    await page.locator('.quiz-tile:not(.interview-tile)').first().waitFor({ state: 'visible', timeout: 30_000 });

    const enterDiQuiz = async () => {
      await page.locator('.quiz-tile:not(.interview-tile)', { hasText: 'Fixture Gadgets' }).first()
        .click({ timeout: 15_000 });
      await page.locator('.start-btn').click({ timeout: 15_000 });
      await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 30_000 });
    };
    const answerToUnlockNext = async () => {
      const rows = page.locator('.option-row');
      const n = await rows.count();
      for (let i = 0; i < n; i++) {
        await rows.nth(i).click({ timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(700);
        if (await page.locator(NEXT_BTN).isEnabled().catch(() => false)) return;
      }
    };
    const goToQ3 = async () => {
      await answerToUnlockNext();
      await page.locator(NEXT_BTN).click({ timeout: 15_000 });
      await page.waitForTimeout(800);
      await answerToUnlockNext();
      await page.locator(NEXT_BTN).click({ timeout: 15_000 });
      await page.waitForTimeout(800);
    };

    await enterDiQuiz();
    await goToQ3();

    const heading = (await page.locator(HEADING).first().textContent()) ?? '';
    const correct = correctIndicesForHeading(diQuiz, heading);
    expect(correct.length).toBe(3);

    // Fully complete Q3 this first time.
    for (const i of correct) {
      await page.locator('.option-row').nth(i).click({ timeout: 15_000 });
      await page.waitForTimeout(600);
    }
    await page.waitForTimeout(500);

    // Leave via the header link (NOT an explicit Restart).
    await page.locator('a[matTooltip="Back to Codelab Quiz Selection"]').click({ timeout: 15_000 });
    await page.locator('.quiz-tile:not(.interview-tile)').first().waitFor({ state: 'visible', timeout: 30_000 });

    // Re-enter the SAME quiz — a genuinely fresh attempt.
    await enterDiQuiz();
    await goToQ3();

    // THE REGRESSION: selecting only ONE correct option here used to paint
    // all three green immediately.
    await page.locator('.option-row').nth(correct[0]).click({ timeout: 15_000 });
    await page.waitForTimeout(1500);

    expect(await classesOf(page, correct[0])).toContain('correct-option');
    for (const i of [correct[1], correct[2]]) {
      expect(await classesOf(page, i), `option ${i} must stay neutral — it was never picked in THIS attempt`)
        .not.toContain('correct-option');
    }
  });
});
