import { test, expect, Page } from '@playwright/test';
import { quizData, startQuizViaUi, advanceToQuestion, HEADING } from './helpers';

/**
 * Regression coverage for the feedback-announcer STAGGER fix
 * (shared-option.component.ts's announceFeedbackStaggered /
 * cancelPendingFeedbackAnnouncement + option-interaction-effects.service.ts).
 *
 * ── The defect this addresses ──────────────────────────────────────────
 * The persistent feedback announcer added by the prior fix (see
 * a11y-topic-quiz-live-regions.spec.ts) is structurally correct — a real
 * mutation on an already-registered live region — but a live
 * MutationObserver diagnostic against the real app (not assumed) showed
 * that on verdict arrival, THREE separate `aria-live="polite"` regions
 * mutate within the SAME synchronous tick (observed within 0.1ms of each
 * other): this announcer, the question heading (`#qText`, which reveals
 * the explanation at the same moment), and the progress message-area.
 * Multiple simultaneously-mutating polite regions are not reliably queued
 * by every assistive technology — this is the confirmed, measured
 * mechanism behind a real-world report that Narrator spoke the heading's
 * explanation but never the feedback announcer's verdict text.
 *
 * ── The fix ─────────────────────────────────────────────────────────────
 * The announcer's OWN write is deferred by 400ms (announceFeedbackStaggered),
 * moving its mutation into a separate browser task/accessibility-tree
 * update batch from its two siblings — confirmed by re-running the same
 * diagnostic (heading/message-area mutated together; the announcer
 * mutated ~400ms later, in its own batch). No new live region was added,
 * and the heading/message-area producers are untouched. A pending
 * staggered write is cancelled (cancelPendingFeedbackAnnouncement) before
 * every Q→Q clear, so a late timer from the question just left can never
 * overwrite the fresh question's cleared announcer with stale text.
 *
 * ── What this suite does NOT and cannot prove ──────────────────────────
 * That Narrator (or any AT) actually announces the now-separated mutation
 * reliably — only a manual Narrator retest can confirm that. This proves
 * the mutations are no longer simultaneous in the DOM/task-queue sense.
 */

const ANNOUNCER_SELECTOR = '.visually-hidden[role="status"]';
const doohickeys = quizData.find((q: any) => (q.quizId || q.id) === 'fixture-doohickeys');

const SINGLE_ANSWER_IDX = [0, 2, 3, 4].filter((i) =>
  doohickeys.questions[i].options.filter((o: any) => o.correct === true || o.correct === 'true').length === 1
);

async function reachQuestion(page: Page, oneBasedIndex: number): Promise<void> {
  await startQuizViaUi(page, 'fixture-doohickeys', /fixture doohickeys/i);
  if (oneBasedIndex > 1) await advanceToQuestion(page, doohickeys, oneBasedIndex);
  await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 20_000 });
}

test.describe('Feedback announcer stagger (fix regression)', () => {
  test('the announcer mutates in a LATER, separate task from the heading and message-area, not the same tick', async ({ page }) => {
    const qIdx = SINGLE_ANSWER_IDX[0];
    await reachQuestion(page, qIdx + 1);

    await page.evaluate(
      ({ announcerSel, headingSel }) => {
        (window as any).__mutLog = [];
        const record = (label: string) => () => {
          (window as any).__mutLog.push({ label, t: performance.now() });
        };
        for (const [label, sel] of [
          ['announcer', announcerSel],
          ['heading', headingSel],
        ] as const) {
          const el = document.querySelector(sel);
          if (!el) continue;
          new MutationObserver(record(label)).observe(el, { childList: true, characterData: true, subtree: true });
        }
      },
      { announcerSel: ANNOUNCER_SELECTOR, headingSel: HEADING }
    );

    const correctIdx = doohickeys.questions[qIdx].options.findIndex(
      (o: any) => o.correct === true || o.correct === 'true'
    );
    await page.locator('.option-row').nth(correctIdx).click();
    await page.waitForTimeout(1500);

    const log = await page.evaluate(() => (window as any).__mutLog as Array<{ label: string; t: number }>);
    const headingT = log.find((e) => e.label === 'heading')?.t;
    const announcerT = log.find((e) => e.label === 'announcer')?.t;

    expect(headingT).toBeDefined();
    expect(announcerT).toBeDefined();
    // The stagger targets 400ms; require a comfortable margin (>150ms) so
    // this assertion is robust to minor scheduling jitter while still
    // clearly distinguishing "separate task" from "same tick" (<1ms, as
    // measured before this fix).
    expect(announcerT! - headingT!).toBeGreaterThan(150);
  });

  test('clicking Next before the 400ms stagger elapses cancels the pending announcement — no stale text leaks onto the next question', async ({ page }) => {
    const qIdx = SINGLE_ANSWER_IDX[0];
    await reachQuestion(page, qIdx + 1);

    const correctIdx = doohickeys.questions[qIdx].options.findIndex(
      (o: any) => o.correct === true || o.correct === 'true'
    );
    await page.locator('.option-row').nth(correctIdx).click();

    // Navigate away IMMEDIATELY — well inside the 400ms stagger window —
    // so the pending timeout from THIS question is still live when the
    // Q→Q cleanup runs.
    const nextBtn = page.locator('[aria-label="Next Question"]');
    await nextBtn.waitFor({ state: 'visible', timeout: 5_000 });
    await nextBtn.click();
    await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 20_000 });

    // Wait well past the original 400ms — if cancellation had failed, the
    // stale timeout would have fired by now and overwritten the fresh
    // question's cleared announcer with the PREVIOUS question's verdict text.
    await page.waitForTimeout(900);

    await expect(page.locator(ANNOUNCER_SELECTOR)).toHaveText('');
  });
});
