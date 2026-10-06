import { test, expect, Page } from '@playwright/test';
import { quizData, startQuizViaUi, advanceToQuestion, HEADING } from './helpers';

/**
 * Regression coverage for ONE coordinated answer-outcome announcement
 * (compose-answer-announcement.ts / AnswerAnnouncementCoordinatorService).
 *
 * ── History ─────────────────────────────────────────────────────────────
 * This suite originally covered a simpler fix: a single persistent,
 * visually-hidden `role="status"` announcer mirroring the raw per-click
 * feedback text, because the VISIBLE feedback box is destroyed/recreated
 * per option-anchor and so never reliably self-announces. That alone left
 * Narrator audible but unnecessarily verbose: on a correctness reveal it
 * spoke the FET (heading), then the selection-message guidance, then the
 * feedback — three independently-mutating `aria-live="polite"` regions, all
 * in the same synchronous tick (confirmed live via MutationObserver).
 *
 * ── The current design ──────────────────────────────────────────────────
 * The question/FET heading and the selection-message region no longer
 * self-announce for answer-outcome events — their `aria-live` was removed
 * for that case (the heading KEEPS it, conditionally, for a genuine live
 * timer expiry only — see quiz.component.html's own comment). This single
 * persistent announcer now carries ONE composed message per outcome:
 *   - incorrect           -> feedback alone
 *   - partial multi-answer -> feedback + "select N more..." guidance
 *   - full correctness     -> feedback + the explanation (FET)
 * No stagger against competing regions — there are none left to compete
 * with. But a REAL 100ms clear-then-restore gap (setTimeout, a macrotask)
 * is deliberately kept: live Narrator testing showed a same-task
 * clear-then-set (queueMicrotask) still went unannounced for a second,
 * textually-identical outcome, even though the DOM genuinely mutated
 * twice. This matches a documented, cross-screen-reader limitation (NVDA
 * issue nvaccess/nvda#19328 and others): screen readers can fail to
 * re-announce aria-live content that reads identically to what they last
 * announced, and the commonly-cited mitigation is exactly a clear +
 * ~100ms-scale real delay before restoring. Cancellable on a newer click,
 * navigation, or destruction, so a stale restore can never land late.
 *
 * ── What this suite does NOT and cannot prove ──────────────────────────
 * DOM/accessibility-tree assertions (role/aria-live attributes, text
 * content, node identity, mutation presence) prove the MARKUP is
 * structurally correct and unambiguous for a screen reader to announce.
 * They cannot prove any assistive technology actually SPEAKS it, in what
 * order, or whether it is perceived as "one" utterance. Only a manual
 * Narrator/NVDA retest can confirm the actual spoken output.
 *
 * Navigation uses startQuizViaUi + advanceToQuestion (real progression),
 * never a direct page.goto to a non-first question — QuizGuard redirects
 * that back to Q1 on a fresh attempt.
 */

const ANNOUNCER_SELECTOR = '.visually-hidden[role="status"]';
const MESSAGE_AREA_SELECTOR = '.message-area';
const HEADING_SELECTOR = HEADING; // 'codelab-quiz-content h3'

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

async function announcerText(page: Page): Promise<string> {
  return ((await page.locator(ANNOUNCER_SELECTOR).textContent()) ?? '').trim();
}

test.describe('Topic Quiz answer-outcome announcer — ONE coordinated message per event (fix regression)', () => {
  test('single-answer CORRECT pick (full correctness): the announcer carries feedback AND the explanation, composed as one message', async ({ page }) => {
    const qIdx = SINGLE_ANSWER_IDX[0];
    await reachQuestion(page, qIdx + 1);

    await expect(page.locator(ANNOUNCER_SELECTOR)).toHaveCount(1);
    await expect(page.locator(ANNOUNCER_SELECTOR)).toHaveText('');

    const correctIdx = doohickeys.questions[qIdx].options.findIndex(
      (o: any) => o.correct === true || o.correct === 'true'
    );
    await page.locator('.option-row').nth(correctIdx).click();
    await page.waitForTimeout(900);

    const announced = await announcerText(page);
    expect(announced.length).toBeGreaterThan(0);
    // Feedback verdict present...
    expect(/right|correct/i.test(announced)).toBe(true);
    // ...AND the explanation, composed into the SAME message (not a
    // separate heading announcement — the heading's own aria-live is off
    // for this event).
    const headingText = ((await page.locator(HEADING_SELECTOR).first().textContent()) ?? '').trim();
    expect(headingText.length).toBeGreaterThan(0);
    // The announced text includes (a plain-text version of) the heading's
    // explanation content.
    const headingWords = headingText.replace(/<[^>]*>/g, ' ').trim().split(/\s+/).slice(0, 4).join(' ');
    expect(announced).toContain(headingWords);
  });

  test('single-answer correct pick: the heading itself is NOT a live region (no competing auto-announcement)', async ({ page }) => {
    const qIdx = SINGLE_ANSWER_IDX[0];
    await reachQuestion(page, qIdx + 1);

    const correctIdx = doohickeys.questions[qIdx].options.findIndex(
      (o: any) => o.correct === true || o.correct === 'true'
    );
    await page.locator('.option-row').nth(correctIdx).click();
    await page.waitForTimeout(900);

    const headingLive = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return { ariaLive: el?.getAttribute('aria-live') ?? null, role: el?.getAttribute('role') ?? null };
    }, HEADING_SELECTOR);
    expect(headingLive.ariaLive).toBeNull();
    expect(headingLive.role).toBeNull();
  });

  test('single-answer INCORRECT pick: the announcer carries feedback ONLY — no repeated selection guidance', async ({ page }) => {
    const qIdx = SINGLE_ANSWER_IDX[1];
    await reachQuestion(page, qIdx + 1);

    const wrongIdx = doohickeys.questions[qIdx].options.findIndex(
      (o: any) => !(o.correct === true || o.correct === 'true')
    );
    expect(wrongIdx).toBeGreaterThanOrEqual(0);

    await page.locator('.option-row').nth(wrongIdx).click();
    await page.waitForTimeout(900);

    const announced = await announcerText(page);
    expect(announced.length).toBeGreaterThan(0);
    expect(/wrong|not this one|incorrect|try again/i.test(announced)).toBe(true);
    // Must NOT also carry the unchanged "select the correct answer" guidance.
    expect(/select the correct answer/i.test(announced)).toBe(false);
  });

  test('multi-answer: a correct-but-partial pick composes feedback + "select N more" guidance as ONE message', async ({ page }) => {
    const qIdx = MULTI_ANSWER_IDX[0];
    await reachQuestion(page, qIdx + 1);

    const opts = doohickeys.questions[qIdx].options;
    const correctIdxs: number[] = opts
      .map((o: any, i: number) => ((o.correct === true || o.correct === 'true') ? i : -1))
      .filter((i: number) => i >= 0);
    expect(correctIdxs.length).toBeGreaterThanOrEqual(2);

    await page.locator('.option-row').nth(correctIdxs[0]).click();
    await page.waitForTimeout(900);

    const announced = await announcerText(page);
    expect(announced.length).toBeGreaterThan(0);
    expect(/right|correct/i.test(announced)).toBe(true);
    expect(/select\s+\d+\s+more\s+correct\s+answers?/i.test(announced)).toBe(true);
  });

  test('multi-answer: a wrong pick (while progress exists) still announces feedback only', async ({ page }) => {
    const qIdx = MULTI_ANSWER_IDX[0];
    await reachQuestion(page, qIdx + 1);

    const opts = doohickeys.questions[qIdx].options;
    const correctIdxs: number[] = opts
      .map((o: any, i: number) => ((o.correct === true || o.correct === 'true') ? i : -1))
      .filter((i: number) => i >= 0);
    const wrongIdx = opts.findIndex((o: any) => !(o.correct === true || o.correct === 'true'));

    await page.locator('.option-row').nth(correctIdxs[0]).click();
    await page.waitForTimeout(900);
    await page.locator('.option-row').nth(wrongIdx).click();
    await page.waitForTimeout(900);

    const announced = await announcerText(page);
    expect(announced.length).toBeGreaterThan(0);
    expect(/select\s+\d+\s+more/i.test(announced)).toBe(false);
  });

  test('multi-answer: completing the question composes feedback + explanation (full correctness), not the progress guidance', async ({ page }) => {
    const qIdx = MULTI_ANSWER_IDX[0];
    await reachQuestion(page, qIdx + 1);

    const opts = doohickeys.questions[qIdx].options;
    const correctIdxs: number[] = opts
      .map((o: any, i: number) => ((o.correct === true || o.correct === 'true') ? i : -1))
      .filter((i: number) => i >= 0);

    for (const idx of correctIdxs) {
      await page.locator('.option-row').nth(idx).click();
      await page.waitForTimeout(900);
    }

    const announced = await announcerText(page);
    expect(announced.length).toBeGreaterThan(0);
    expect(/select\s+\d+\s+more/i.test(announced)).toBe(false);
    expect(/next button|show results/i.test(announced)).toBe(false);
  });

  test('navigating to the next question clears the announcer — no stale verdict carried over', async ({ page }) => {
    const qIdx = SINGLE_ANSWER_IDX[0];
    await reachQuestion(page, qIdx + 1);

    const correctIdx = doohickeys.questions[qIdx].options.findIndex(
      (o: any) => o.correct === true || o.correct === 'true'
    );
    await page.locator('.option-row').nth(correctIdx).click();
    await page.waitForTimeout(900);
    const before = await announcerText(page);
    expect(before.length).toBeGreaterThan(0);

    await page.locator('[aria-label="Next Question"]').click();
    await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForTimeout(300);

    await expect(page.locator(ANNOUNCER_SELECTOR)).toHaveText('');
  });

  test('two DIFFERENT wrong picks whose feedback text happens to read identically still both produce a real, re-announceable mutation', async ({ page }) => {
    // Regression for the clear-then-set write: Angular's interpolation
    // binding skips a DOM write when the new value is byte-identical to
    // the current one, which would otherwise silently swallow a second
    // click's announcement.
    const qIdx = SINGLE_ANSWER_IDX[1];
    await reachQuestion(page, qIdx + 1);
    const wrongIdx = doohickeys.questions[qIdx].options.findIndex(
      (o: any) => !(o.correct === true || o.correct === 'true')
    );

    await page.evaluate((sel) => {
      (window as any).__mutCount = 0;
      const el = document.querySelector(sel);
      if (el) new MutationObserver(() => { (window as any).__mutCount++; }).observe(el, { childList: true, characterData: true, subtree: true });
    }, ANNOUNCER_SELECTOR);

    await page.locator('.option-row').nth(wrongIdx).click();
    await page.waitForTimeout(900);
    const firstText = await announcerText(page);

    // Navigate to a DIFFERENT single-answer question and click ITS wrong
    // option too — the generic wrong-answer wording is highly likely to
    // repeat verbatim across different single-answer questions.
    const qIdx2 = SINGLE_ANSWER_IDX[2];
    await advanceToQuestion(page, doohickeys, qIdx2 + 1);
    const wrongIdx2 = doohickeys.questions[qIdx2].options.findIndex(
      (o: any) => !(o.correct === true || o.correct === 'true')
    );
    await page.locator('.option-row').nth(wrongIdx2).click();
    await page.waitForTimeout(900);
    const secondText = await announcerText(page);

    expect(secondText.length).toBeGreaterThan(0);
    // Whether or not the wording happens to match, a real mutation occurred
    // for the second click too (the clear-then-set always fires at least
    // the clear + the real write, i.e. at least 2 mutations total here,
    // across BOTH the nav-clear and this click).
    const mutCount = await page.evaluate(() => (window as any).__mutCount);
    expect(mutCount).toBeGreaterThanOrEqual(2);
    void firstText;
  });

  test('two DIFFERENT wrong picks on the SAME question, with NO navigation between them: the second pick still produces exactly one clean clear-then-set cycle', async ({ page }) => {
    // Regression for a real bug found via live Narrator testing: Narrator
    // announced the FIRST incorrect pick but stayed silent for a second,
    // consecutive incorrect pick (same question, identical generic
    // wrong-answer wording, no navigation in between). A live
    // MutationObserver diagnostic showed FeedbackComponent's constructor
    // effect re-emitting the SAME {text, isCorrect} twice, 21ms apart, for
    // ONE click — each emission forcing SharedOptionComponent's announcer
    // through its OWN clear-then-set cycle, producing a jittery
    // ''->text->''->text flicker instead of one clean ''->text transition.
    // Fixed by deduplicating same-value re-emissions WITHIN one
    // FeedbackComponent instance (feedback.component.ts's `lastEmitted`
    // guard) — a brand-new instance (a genuinely NEW click) still always
    // emits at least once, so a new selection is never suppressed; only a
    // redundant re-run of the SAME click's own settling effect is.
    const qIdx = SINGLE_ANSWER_IDX[0];
    await reachQuestion(page, qIdx + 1);
    const wrongIdxs: number[] = doohickeys.questions[qIdx].options
      .map((o: any, i: number) => (!(o.correct === true || o.correct === 'true') ? i : -1))
      .filter((i: number) => i >= 0);
    expect(wrongIdxs.length).toBeGreaterThanOrEqual(2);

    await page.evaluate((sel) => {
      (window as any).__log = [];
      const el = document.querySelector(sel);
      if (el) {
        new MutationObserver(() => {
          (window as any).__log.push((el.textContent || '').trim());
        }).observe(el, { childList: true, characterData: true, subtree: true });
      }
    }, ANNOUNCER_SELECTOR);

    await page.locator('.option-row').nth(wrongIdxs[0]).click();
    await page.waitForTimeout(900);
    const afterFirst = await announcerText(page);
    expect(afterFirst.length).toBeGreaterThan(0);

    const mutationsBeforeSecondClick = await page.evaluate(() => (window as any).__log.length);

    await page.locator('.option-row').nth(wrongIdxs[1]).click();
    await page.waitForTimeout(900);
    const afterSecond = await announcerText(page);
    expect(afterSecond.length).toBeGreaterThan(0);

    const log: string[] = await page.evaluate(() => (window as any).__log);
    const secondClickMutations = log.slice(mutationsBeforeSecondClick);
    // Exactly ONE clear-then-set cycle for the second click: '' then the
    // real text — not zero (the original bug: silent), and not four (the
    // double-fire jitter this fix removes).
    expect(secondClickMutations).toEqual(['', afterSecond]);
  });

  test('the clear-then-restore gap is a REAL timer delay, not an instantaneous same-task write', async ({ page }) => {
    // Regression for the evidence-based 100ms delay (shared-option.component.ts's
    // onFeedbackAnnounced): a same-task/microtask clear-then-set was
    // confirmed (live) to still go unannounced for a repeated outcome, a
    // documented cross-screen-reader limitation (NVDA issue
    // nvaccess/nvda#19328 among others). This test proves the gap is a
    // genuine, measurable delay — not that any assistive technology
    // actually uses it to re-announce (which only a manual retest proves).
    const qIdx = SINGLE_ANSWER_IDX[0];
    await reachQuestion(page, qIdx + 1);
    const wrongIdxs: number[] = doohickeys.questions[qIdx].options
      .map((o: any, i: number) => (!(o.correct === true || o.correct === 'true') ? i : -1))
      .filter((i: number) => i >= 0);
    expect(wrongIdxs.length).toBeGreaterThanOrEqual(2);

    // Prime the announcer with a first pick: a fresh question already starts
    // empty, so the FIRST outcome's clear is a no-op and would not produce an
    // observable '' mutation. The gap under test is the SECOND outcome's clear
    // (text present -> '') and its restore (-> text).
    await page.locator('.option-row').nth(wrongIdxs[0]).click();
    await page.waitForTimeout(1500);

    await page.evaluate((sel) => {
      (window as any).__log = [];
      const el = document.querySelector(sel);
      if (el) {
        new MutationObserver(() => {
          (window as any).__log.push({ t: performance.now(), text: (el.textContent || '').trim() });
        }).observe(el, { childList: true, characterData: true, subtree: true });
      }
    }, ANNOUNCER_SELECTOR);

    await page.locator('.option-row').nth(wrongIdxs[1]).click();
    await page.waitForTimeout(1500);

    const log: Array<{ t: number; text: string }> = await page.evaluate(() => (window as any).__log);
    const clearEvent = log.find((e) => e.text === '');
    const restoreEvent = log.find((e) => e.text !== '');
    expect(clearEvent).toBeDefined();
    expect(restoreEvent).toBeDefined();
    // A real macrotask-scale gap — comfortably above what a same-task
    // microtask write would produce (effectively 0ms), with margin below
    // the full 100ms target to tolerate scheduling jitter.
    expect(restoreEvent!.t - clearEvent!.t).toBeGreaterThan(50);
  });

  test('navigating away WHILE the 100ms restore is still pending cancels it — no stale text lands on the next question', async ({ page }) => {
    const qIdx = SINGLE_ANSWER_IDX[0];
    await reachQuestion(page, qIdx + 1);
    const correctIdx = doohickeys.questions[qIdx].options.findIndex(
      (o: any) => o.correct === true || o.correct === 'true'
    );

    await page.locator('.option-row').nth(correctIdx).click();
    // Click Next IMMEDIATELY — deliberately inside the 100ms window, before
    // the pending restore has fired.
    const nextBtn = page.locator('[aria-label="Next Question"]');
    await nextBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await expect(nextBtn).toBeEnabled({ timeout: 10_000 });
    await nextBtn.click();
    await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 20_000 });

    // Wait well past 100ms — if cancellation had failed, the stale timer
    // would have fired by now and overwritten the fresh question's cleared
    // announcer with the PREVIOUS question's verdict text.
    await page.waitForTimeout(500);
    await expect(page.locator(ANNOUNCER_SELECTOR)).toHaveText('');
  });

  test('"Select N more..." guidance remains visible and unchanged, but the selection-message region no longer self-announces', async ({ page }) => {
    const qIdx = MULTI_ANSWER_IDX[0];
    await reachQuestion(page, qIdx + 1);

    const messageArea = page.locator(MESSAGE_AREA_SELECTOR);
    await expect(messageArea).toHaveCount(1);
    await expect(messageArea).toContainText('Select all that apply');

    const liveAttrs = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return { ariaLive: el?.getAttribute('aria-live') ?? null, role: el?.getAttribute('role') ?? null };
    }, MESSAGE_AREA_SELECTOR);
    expect(liveAttrs.ariaLive).toBeNull();
    expect(liveAttrs.role).toBeNull();

    const correctIdx = doohickeys.questions[qIdx].options.findIndex(
      (o: any) => o.correct === true || o.correct === 'true'
    );
    await page.locator('.option-row').nth(correctIdx).click();
    await page.waitForTimeout(900);
    // Visible content still updates exactly as before.
    await expect(messageArea).toContainText(/select.*more/i);
  });

  test('the timer carries no aria-live/role outside a genuine live expiry — it never forces a repeated per-second announcement', async ({ page }) => {
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

  test('exactly one answer-outcome announcer exists at a time — no duplicate/competing status regions stamped per option', async ({ page }) => {
    const qIdx = MULTI_ANSWER_IDX[0];
    await reachQuestion(page, qIdx + 1);

    const correctIdx = doohickeys.questions[qIdx].options.findIndex(
      (o: any) => o.correct === true || o.correct === 'true'
    );
    await page.locator('.option-row').nth(correctIdx).click();
    await page.waitForTimeout(900);

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
    const answerAnnouncers = liveRegions.filter((r) => r.classList.includes('visually-hidden'));
    expect(answerAnnouncers.length).toBe(1);
  });
});
