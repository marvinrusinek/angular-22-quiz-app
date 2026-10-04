import { test, expect, Page } from '@playwright/test';
import { quizData, startQuizViaUi, advanceToQuestion } from './helpers';

/**
 * Regression coverage for the feedback-announcer fix
 * (feedback.component.ts/.html + shared-option.component.ts/.html/.scss +
 * option-interaction-effects.service.ts).
 *
 * ── The defect ──────────────────────────────────────────────────────────
 * Topic Quiz's per-click feedback ("That's correct!", "Not this one, try
 * again!", "You're right! The correct answers are...") rendered inside
 * <codelab-quiz-feedback>, which shared-option.component.html only ever
 * instantiates via `@if (shouldShowFeedbackAfter(b, i))` — correct for
 * VISUAL positioning (the box sits below whichever option earned it,
 * preserved exactly as-is by this fix), but it means the element carrying
 * `role="status" aria-live="polite"` is destroyed and a brand-new one
 * created, already containing its final text, every time the anchor option
 * changes. A screen reader detects a live-region update by observing a
 * MUTATION on an element it has already registered — a freshly-inserted,
 * pre-populated subtree is a different signal most screen readers do not
 * announce. Confirmed live with Windows Narrator: this feedback was read
 * only when the user manually navigated onto it, never automatically.
 *
 * ── The fix ─────────────────────────────────────────────────────────────
 * FeedbackComponent now also emits its computed message via a
 * `messageAnnounced` output. SharedOptionComponent listens on every
 * per-option feedback-block instantiation and writes the value into
 * `announcedFeedback`, a signal read by ONE single, persistent,
 * visually-hidden `role="status"` region that is NEVER conditionally
 * removed — so every update is a genuine mutation on an already-registered
 * live region. The existing `aria-live`/`role="status"` were removed from
 * the VISIBLE feedback box itself (feedback.component.html) so there is
 * exactly one announcing channel, not two saying the same thing.
 * `announcedFeedback` is cleared on every real question-index transition
 * (option-interaction-effects.service.ts's existing resetBindingsAndState,
 * the established place per-question UI state already resets) so a verdict
 * from the question just left is never read back on the next one.
 *
 * ── What this suite does NOT and cannot prove ──────────────────────────
 * These are DOM/accessibility-tree assertions in a real browser (persistent
 * node identity, correct `role`/`aria-live` attributes, correct text at
 * each step). They prove the MARKUP is structurally correct for a screen
 * reader to announce reliably — they cannot prove any assistive technology
 * actually SPEAKS it, which depends on the AT/browser combination. See the
 * manual verification checklist in this fix's commit description.
 *
 * Navigation uses startQuizViaUi + advanceToQuestion (real progression),
 * never a direct page.goto to a non-first question — QuizGuard redirects
 * that back to Q1 on a fresh attempt, the same reason every other spec in
 * this repo avoids it (see e.g. a11y-deep-verification.spec.ts's own note).
 */

const ANNOUNCER_SELECTOR = '.visually-hidden[role="status"]';

const doohickeys = quizData.find((q: any) => (q.quizId || q.id) === 'fixture-doohickeys');

/** Question indices (0-based) on fixture-doohickeys, resolved from the synthetic bank — not hardcoded blind. */
const SINGLE_ANSWER_IDX = [0, 2, 3, 4].filter((i) =>
  doohickeys.questions[i].options.filter((o: any) => o.correct === true || o.correct === 'true').length === 1
);
const MULTI_ANSWER_IDX = [1, 5].filter((i) =>
  doohickeys.questions[i].options.filter((o: any) => o.correct === true || o.correct === 'true').length > 1
);

async function reachQuestion(page: Page, oneBasedIndex: number): Promise<void> {
  await startQuizViaUi(page, 'fixture-doohickeys', /fixture doohickeys/i);
  if (oneBasedIndex > 1) await advanceToQuestion(page, doohickeys, oneBasedIndex);
  await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 20_000 });
}

test.describe('Topic Quiz feedback announcer — persistent live region (fix regression)', () => {
  test('single-answer correct pick: the persistent announcer receives the feedback text, the visible box is not itself a live region', async ({ page }) => {
    await reachQuestion(page, SINGLE_ANSWER_IDX[0] + 1);

    // Baseline: before any click, the announcer exists (persistent) and is empty.
    await expect(page.locator(ANNOUNCER_SELECTOR)).toHaveCount(1);
    await expect(page.locator(ANNOUNCER_SELECTOR)).toHaveText('');

    const correctIdx = doohickeys.questions[SINGLE_ANSWER_IDX[0]].options.findIndex(
      (o: any) => o.correct === true || o.correct === 'true'
    );
    await page.locator('.option-row').nth(correctIdx).click();
    await page.waitForTimeout(400);

    const announced = await page.locator(ANNOUNCER_SELECTOR).textContent();
    expect(announced?.trim().length).toBeGreaterThan(0);

    // The visible feedback box itself must NOT carry aria-live/role="status"
    // — exactly one channel announces, not two saying the same thing.
    const visibleBoxLive = await page.evaluate(() => {
      const box = document.querySelector('.feedback-below-option .message');
      if (!box) return { found: false };
      return {
        found: true,
        role: box.getAttribute('role'),
        ariaLive: box.getAttribute('aria-live'),
        text: (box.textContent || '').trim(),
      };
    });
    expect(visibleBoxLive.found).toBe(true);
    expect(visibleBoxLive.role).toBeNull();
    expect(visibleBoxLive.ariaLive).toBeNull();
    // Same information still shown visually — just not as a live region.
    expect(visibleBoxLive.text!.length).toBeGreaterThan(0);
  });

  test('single-answer incorrect pick: the persistent announcer receives the wrong-answer feedback text', async ({ page }) => {
    const qIdx = SINGLE_ANSWER_IDX[1];
    await reachQuestion(page, qIdx + 1);

    const wrongIdx = doohickeys.questions[qIdx].options.findIndex(
      (o: any) => !(o.correct === true || o.correct === 'true')
    );
    expect(wrongIdx).toBeGreaterThanOrEqual(0);

    await page.locator('.option-row').nth(wrongIdx).click();
    await page.waitForTimeout(400);

    const announced = (await page.locator(ANNOUNCER_SELECTOR).textContent())?.trim() ?? '';
    expect(announced.length).toBeGreaterThan(0);
    expect(/wrong|not this one|incorrect|try again/i.test(announced)).toBe(true);
  });

  test('multi-answer: the announcer is the SAME persistent DOM node across a correct pick, a wrong pick, and completion — never recreated', async ({ page }) => {
    const qIdx = MULTI_ANSWER_IDX[0];
    await reachQuestion(page, qIdx + 1);

    const opts = doohickeys.questions[qIdx].options;
    const correctIdxs: number[] = opts
      .map((o: any, i: number) => ((o.correct === true || o.correct === 'true') ? i : -1))
      .filter((i: number) => i >= 0);
    const wrongIdx = opts.findIndex((o: any) => !(o.correct === true || o.correct === 'true'));
    expect(correctIdxs.length).toBeGreaterThanOrEqual(2);
    expect(wrongIdx).toBeGreaterThanOrEqual(0);

    await expect(page.locator(ANNOUNCER_SELECTOR)).toHaveCount(1);
    await page.evaluate((sel) => {
      document.querySelector(sel)?.setAttribute('data-identity-check', 'stable');
    }, ANNOUNCER_SELECTOR);

    const rows = page.locator('.option-row');

    // 1) First correct pick.
    await rows.nth(correctIdxs[0]).click();
    await page.waitForTimeout(400);
    const afterCorrect = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return { identity: el?.getAttribute('data-identity-check'), text: (el?.textContent || '').trim() };
    }, ANNOUNCER_SELECTOR);
    expect(afterCorrect.identity).toBe('stable'); // same node — not recreated
    expect(afterCorrect.text.length).toBeGreaterThan(0);

    // 2) A wrong pick.
    await rows.nth(wrongIdx).click();
    await page.waitForTimeout(400);
    const afterWrong = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return { identity: el?.getAttribute('data-identity-check'), text: (el?.textContent || '').trim() };
    }, ANNOUNCER_SELECTOR);
    expect(afterWrong.identity).toBe('stable');
    expect(afterWrong.text).not.toBe(afterCorrect.text); // content genuinely changed
    expect(afterWrong.text.length).toBeGreaterThan(0);

    // 3) Completing pick (remaining correct option(s)).
    for (const idx of correctIdxs.slice(1)) {
      await rows.nth(idx).click();
      await page.waitForTimeout(400);
    }
    const afterComplete = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return { identity: el?.getAttribute('data-identity-check'), text: (el?.textContent || '').trim() };
    }, ANNOUNCER_SELECTOR);
    expect(afterComplete.identity).toBe('stable');
    expect(afterComplete.text).not.toBe(afterWrong.text);
    expect(afterComplete.text.length).toBeGreaterThan(0);
  });

  test('navigating to the next question clears the announcer — no stale verdict carried over', async ({ page }) => {
    const qIdx = SINGLE_ANSWER_IDX[0];
    await reachQuestion(page, qIdx + 1);

    const correctIdx = doohickeys.questions[qIdx].options.findIndex(
      (o: any) => o.correct === true || o.correct === 'true'
    );
    await page.locator('.option-row').nth(correctIdx).click();
    await page.waitForTimeout(400);
    const before = (await page.locator(ANNOUNCER_SELECTOR).textContent())?.trim() ?? '';
    expect(before.length).toBeGreaterThan(0);

    await page.locator('[aria-label="Next Question"]').click();
    await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForTimeout(300);

    await expect(page.locator(ANNOUNCER_SELECTOR)).toHaveText('');
  });

  test('"Select N more..." / progress prompts remain their own correctly-scoped persistent live region, unaffected by this fix', async ({ page }) => {
    const qIdx = MULTI_ANSWER_IDX[0];
    await reachQuestion(page, qIdx + 1);

    const messageArea = page.locator('.message-area[role="status"]');
    await expect(messageArea).toHaveCount(1);
    await expect(messageArea).toContainText('Select all that apply');

    const correctIdx = doohickeys.questions[qIdx].options.findIndex(
      (o: any) => o.correct === true || o.correct === 'true'
    );
    await page.locator('.option-row').nth(correctIdx).click();
    await page.waitForTimeout(400);
    await expect(messageArea).toContainText(/select.*more/i);
  });

  test('the timer carries no aria-live/role — it never forces a repeated per-second announcement', async ({ page }) => {
    await reachQuestion(page, 1);

    const timerLive = await page.evaluate(() => {
      const timer = document.querySelector('.scoreboard-timer, .scoreboard__timer, [class*="timer"]');
      if (!timer) return { found: false };
      const liveDescendant = timer.matches('[aria-live],[role="status"]')
        ? timer
        : timer.querySelector('[aria-live],[role="status"]');
      return { found: true, hasLiveRegion: !!liveDescendant };
    });
    expect(timerLive.found).toBe(true);
    expect(timerLive.hasLiveRegion).toBe(false);
  });

  test('exactly one feedback announcer exists at a time — no duplicate/competing status regions stamped per option', async ({ page }) => {
    const qIdx = MULTI_ANSWER_IDX[0];
    await reachQuestion(page, qIdx + 1);

    const correctIdx = doohickeys.questions[qIdx].options.findIndex(
      (o: any) => o.correct === true || o.correct === 'true'
    );
    await page.locator('.option-row').nth(correctIdx).click();
    await page.waitForTimeout(400);

    // Only the ONE persistent announcer should carry aria-live — no
    // per-option duplicate live regions, and the visible feedback box's own
    // section does not (confirmed by the architectural change above).
    // Exact class-token match (not substring): Angular CDK injects its own
    // global live-announcer element (class "cdk-visually-hidden", id
    // "cdk-live-announcer-0") on any page using CDK a11y utilities — a
    // SUBSTRING match on "visually-hidden" incorrectly also caught that
    // unrelated, framework-provided element (confirmed live, not assumed).
    const liveRegions = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[aria-live]')).map((el) => ({
        classList: Array.from(el.classList),
        text: (el.textContent || '').trim().slice(0, 60),
      }));
    });
    const feedbackAnnouncers = liveRegions.filter((r) => r.classList.includes('visually-hidden'));
    expect(feedbackAnnouncers.length).toBe(1);
  });
});
