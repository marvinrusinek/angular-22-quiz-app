import { test, expect } from '@playwright/test';
import { quizData, HEADING, NEXT_BTN, PREV_BTN } from './helpers';

const cdQuiz = (quizData as any[]).find((q) => (q.quizId || q.id) === 'fixture-doohickeys');

/**
 * Stage 14 regression repair — expired-question revisit must show the USER'S
 * OWN selection state, never the timeout's temporary correctness reveal.
 *
 * ── The regression ────────────────────────────────────────────────
 *
 * The immediate genuine-timeout presentation was already correct: FET,
 * the authorized correct option(s) revealed green, every option locked. The
 * bug was what happened on Next -> Previous back to that same question:
 *
 *   1. `OptionItemTimerStateService#isStamped` (option-item-timer-state
 *      .service.ts) trusted `binding._timerExpiredStamped` /
 *      `_timerExpiredStampedForIndex` with no live/revisit distinction — a
 *      binding stamped once by the live reveal read as "still revealing"
 *      forever, so `option-item.component.ts#getOptionClasses()`'s
 *      `isTimerStamped()` branch kept returning the ORIGINAL `cssClasses`
 *      (still carrying `correct-option: true`) on every later revisit,
 *      manufacturing a "you got this right" reveal the user never earned.
 *
 *   2. Once that stamp check was correctly scoped to the LIVE moment only
 *      (matching `heading-inputs.ts`'s existing `isTimedOut` pattern via
 *      `expiredOnArrivalSig`), the options were ALSO no longer locked on
 *      revisit — nothing had ever durably recorded "this question is over"
 *      outside the one-shot binding stamp, so a plain nav-triggered binding
 *      rebuild (no click involved) recomputed `disabled` from scratch and
 *      got `false`. That let a revisit CLICK submit a fresh, late pick
 *      against an already-expired question and re-open its FET.
 *
 * ── The fix ────────────────────────────────────────────────────────
 *
 * `OptionItemTimerStateService.isStamped()`/`isExpiredForQuestion()` now
 * exclude the arrival case (own `isLiveExpiryForQuestion`), so the REVEAL
 * only ever shows during the live moment. A new
 * `hasQuestionEverExpired(qIdx)` — live OR the durable
 * `QuizDotStatusService#timedOutFetForced` marker (already the established
 * "this question's timeout already happened this session" signal used
 * elsewhere to guard the reveal pipeline against re-firing) — is wired into
 * `option-item.component.ts#isDisabled()` so the LOCK, unlike the reveal,
 * survives the revisit.
 */

test.describe.configure({ timeout: 300_000 });

const ROW = '.option-row';

async function letQ1Expire(page: any) {
  await page.goto('quiz/question/fixture-doohickeys/1');
  const rows = page.locator(ROW);
  await rows.first().waitFor({ state: 'visible', timeout: 20_000 });
  await expect(page.locator(HEADING)).toContainText(/correct because/i, { timeout: 60_000 });
  return rows;
}

test('CASE A: unanswered timeout -> Next -> Previous: no manufactured reveal, stays locked', async ({ page }) => {
  const rows = await letQ1Expire(page);

  await page.locator(NEXT_BTN).click();
  await page.waitForURL(/\/2$/);
  await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

  await page.locator(PREV_BTN).click();
  await page.waitForURL(/\/1$/);
  await rows.first().waitFor({ state: 'visible', timeout: 20_000 });
  await page.waitForTimeout(300);

  // The established revisit contract: question text, not the FET.
  await expect(page.locator(HEADING)).toHaveText(cdQuiz.questions[0].questionText, { timeout: 10_000 });

  const classes = await rows.evaluateAll((els: Element[]) => els.map((el) => el.className));
  for (const cls of classes) {
    // No manufactured selection or reveal — the user picked nothing.
    expect(cls).not.toMatch(/\bselected\b/);
    expect(cls).not.toMatch(/\bcorrect-option\b/);
    expect(cls).not.toMatch(/\bincorrect-option\b/);
    // The question is over: every option stays locked, not just visually.
    expect(cls).toMatch(/mat-mdc-radio-disabled/);
  }

  // A click on a genuinely disabled Material option cannot register at all —
  // Playwright's own actionability check refuses to force it through
  // (mat-mdc-radio-disabled blocks pointer events), which is the point: the
  // question must not accept a late pick after it expired. `.toBeDisabled()`
  // doesn't reliably read MatRadioButton's host-level disabled state, so this
  // asserts on the actual interaction outcome instead: heading/message must
  // still read exactly as they did before attempting the click.
  const headingBeforeClickAttempt = await page.locator(HEADING).innerText();
  await rows.nth(1).click({ timeout: 3_000, force: false }).catch(() => undefined);
  await expect(page.locator(HEADING)).toHaveText(headingBeforeClickAttempt, { timeout: 2_000 });

  // The timer must not restart for an already-expired question.
  await expect(page.locator('.scoreboard-timer .scoreboard')).toHaveText('0:00', { timeout: 5_000 });
});

test('CASE B: partial selection before timeout -> Next -> Previous: restores exactly the pre-timeout pick, stays locked', async ({ page }) => {
  await page.goto('quiz/question/fixture-gadgets/1');
  const rows = page.locator(ROW);
  await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

  // Q3 is multi-answer (per timeout-fet-revisit.spec.ts's established setup) —
  // answer Q1/Q2 (single-answer) to reach it.
  for (let i = 1; i <= 2; i++) {
    await rows.first().click();
    await page.waitForTimeout(1200);
    await page.locator(NEXT_BTN).click();
    await page.waitForURL(new RegExp(`/${i + 1}$`));
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });
  }

  // Pick exactly ONE option on the multi-answer question, then let it expire
  // without completing the rest.
  await rows.first().click();
  await page.waitForTimeout(800);
  const preTimeoutClasses = await rows.evaluateAll((els: Element[]) => els.map((el) => el.className));
  const pickedIdx = preTimeoutClasses.findIndex((c) => /\bselected\b/.test(c));
  expect(pickedIdx, 'a pre-timeout pick must be selected').toBeGreaterThanOrEqual(0);

  await expect(page.locator(HEADING)).toContainText(/correct because/i, { timeout: 60_000 });

  await page.locator(NEXT_BTN).click();
  await page.waitForURL(/\/4$/);
  await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

  await page.locator(PREV_BTN).click();
  await page.waitForURL(/\/3$/);
  await rows.first().waitFor({ state: 'visible', timeout: 20_000 });
  await page.waitForTimeout(300);

  await expect(page.locator(HEADING)).not.toContainText(/correct because/i);

  const revisitClasses = await rows.evaluateAll((els: Element[]) => els.map((el) => el.className));

  // EXACTLY the pre-timeout pick is restored as selected — nothing more.
  const selectedNow = revisitClasses
    .map((c, i) => (/\bselected\b/.test(c) ? i : -1))
    .filter((i) => i >= 0);
  expect(selectedNow).toEqual([pickedIdx]);

  // No UNSELECTED option is painted as an authorized-correct reveal — that
  // would be the timeout's temporary presentation leaking in, not the user's
  // own earned state. The user's OWN pick may legitimately still show
  // correct-option (it colors green the moment a correct option is picked,
  // independent of timeout — same as any live multi-answer interaction);
  // what must NOT happen is an option the user never touched being painted
  // as if it were also picked/correct.
  revisitClasses.forEach((cls, i) => {
    if (i !== pickedIdx) {
      expect(cls).not.toMatch(/\bcorrect-option\b/);
      expect(cls).not.toMatch(/\bselected\b/);
    }
    expect(cls).toMatch(/mat-mdc-(radio|checkbox)-disabled/);
  });

  // The timer must not restart for this expired multi-answer question either
  // — see TimerService#hasRecordedCorrectCompletion / #restartForQuestion.
  await expect(page.locator('.scoreboard-timer .scoreboard')).toHaveText('0:00', { timeout: 5_000 });
});

test('CASE C: normal completed question -> Next -> Previous: established revisit behavior unaffected', async ({ page }) => {
  const rows = await (async () => {
    await page.goto('quiz/question/fixture-doohickeys/1');
    const r = page.locator(ROW);
    await r.first().waitFor({ state: 'visible', timeout: 20_000 });
    return r;
  })();

  const q1 = cdQuiz.questions[0];
  const correctIdx = q1.options.findIndex((o: any) => o.correct === true);
  await rows.nth(correctIdx).click();
  await expect(page.locator(HEADING)).toContainText(/correct because/i, { timeout: 15_000 });

  await page.locator(NEXT_BTN).click();
  await page.waitForURL(/\/2$/);
  await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

  await page.locator(PREV_BTN).click();
  await page.waitForURL(/\/1$/);
  await rows.first().waitFor({ state: 'visible', timeout: 20_000 });
  await page.waitForTimeout(300);

  await expect(page.locator(HEADING)).toHaveText(q1.questionText, { timeout: 10_000 });

  const classes = await rows.evaluateAll((els: Element[]) => els.map((el) => el.className));
  expect(classes[correctIdx]).toMatch(/\bselected\b/);
  expect(classes[correctIdx]).toMatch(/\bcorrect-option\b/);
});
