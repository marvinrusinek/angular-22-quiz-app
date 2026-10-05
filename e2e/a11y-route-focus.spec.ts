import { test, expect } from '@playwright/test';
import { quizData, startQuizViaUi, advanceToQuestion, HEADING, NEXT_BTN } from './helpers';

/**
 * Regression coverage for the route-focus fix (quiz.component.ts/.html).
 *
 * ── Root cause ──────────────────────────────────────────────────────────
 * An Angular SPA route change (QuizSelection -> Introduction -> this
 * component, or Next/Previous BETWEEN questions) is a client-side DOM
 * swap, never a real browser navigation — so it gives screen readers no
 * unload/load cue to stop speaking whatever they were on. With no focus-
 * management anywhere in the app (the app-level NavigationEnd handler was
 * found to be dead code — it toggles fields the template never reads), a
 * screen reader's own in-progress/queued speech from the page or question
 * just left can keep playing after the next one has already mounted.
 *
 * ── Scope (expanded from the initial-arrival-only version) ─────────────
 * A live diagnostic confirmed the app writes NO stale previous-question
 * text anywhere after a Next/Previous navigation (the `/check` response is
 * question-keyed, the heading/message-area are pure computeds off the live
 * index, and the staggered feedback announcer — see
 * a11y-feedback-announcer-stagger.spec.ts — is explicitly cancel-guarded on
 * transition). The reported overlap is consistent with the AT finishing
 * speech it had already started, which no DOM state can retroactively
 * un-queue. QuizComponent now moves focus to the question heading
 * (`#qText`, `tabindex="-1"`) on EVERY actual question-index change —
 * initial arrival AND every Next/Previous — gated on
 * `currentQuestionIndex()` genuinely changing, so an answer click, a
 * feedback update, or a timer tick (none of which change that index) never
 * re-trigger it. `tabindex="-1"` keeps the heading out of the normal Tab
 * sequence, so this never alters logical Tab order.
 *
 * ── What this suite proves ──────────────────────────────────────────────
 * The heading is real, present, and focusable; it receives focus on
 * initial arrival AND on every subsequent Next, each time with that
 * question's own non-empty text; answering a question (without
 * navigating) does not steal focus away mid-interaction; rapid repeated
 * navigation and navigating away entirely (destruction) produce no
 * console/page errors.
 *
 * ── What this suite does NOT and cannot prove ───────────────────────────
 * That Narrator (or any other assistive technology) actually interrupts
 * its speech queue when this focus change happens. Focus movement is a
 * CANDIDATE mitigation, not a guaranteed fix — only a manual Narrator
 * retest can confirm it. See this task's final report for the manual
 * verification steps.
 *
 * Navigation uses startQuizViaUi + advanceToQuestion (real progression),
 * never a direct page.goto to a non-first question — QuizGuard redirects
 * that back to Q1 on a fresh attempt.
 */

const doohickeys = quizData.find((q: any) => (q.quizId || q.id) === 'fixture-doohickeys');
const HEADING_H3 = `${HEADING}[tabindex="-1"]`;

async function headingState(page: import('@playwright/test').Page) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return { found: false as const };
    return {
      found: true as const,
      isFocused: document.activeElement === el,
      text: (el.textContent || '').trim(),
    };
  }, HEADING_H3);
}

test.describe('Topic Quiz route focus — every question change, never on answer/feedback/timer updates (fix regression)', () => {
  test('arriving at Q1 from Introduction focuses the question heading, which already carries non-empty, matching text', async ({ page }) => {
    await startQuizViaUi(page, 'fixture-doohickeys', /fixture doohickeys/i);

    const state = await headingState(page);
    if (!state.found) throw new Error('heading element not found');
    expect(state.isFocused).toBe(true);
    expect(state.text.length).toBeGreaterThan(0);
    expect(state.text).toContain(doohickeys.questions[0].questionText.slice(0, 20));
  });

  test('clicking Next moves focus BACK onto the heading, now with the NEW question text', async ({ page }) => {
    await startQuizViaUi(page, 'fixture-doohickeys', /fixture doohickeys/i);

    const correctIdx = doohickeys.questions[0].options.findIndex(
      (o: any) => o.correct === true || o.correct === 'true'
    );
    await page.locator('.option-row').nth(correctIdx).click();
    await page.waitForTimeout(600);

    const nextBtn = page.locator(NEXT_BTN);
    await expect(nextBtn).toBeEnabled({ timeout: 10_000 });
    await nextBtn.click();
    await advanceToQuestion(page, doohickeys, 2);
    await page.waitForTimeout(300);

    const state = await headingState(page);
    if (!state.found) throw new Error('heading element not found');
    expect(state.isFocused).toBe(true);
    expect(state.text).toContain(doohickeys.questions[1].questionText.slice(0, 20));
    // Genuinely a different question's text, not a stale re-focus of Q1's.
    expect(state.text).not.toContain(doohickeys.questions[0].questionText.slice(0, 20));
  });

  test('selecting an option (answer/feedback update, no navigation) does NOT steal focus back onto the heading', async ({ page }) => {
    await startQuizViaUi(page, 'fixture-doohickeys', /fixture doohickeys/i);

    // Initial arrival already focused the heading — move focus elsewhere
    // (onto the option itself, as a real click does) before triggering the
    // answer/feedback update under test.
    const correctIdx = doohickeys.questions[0].options.findIndex(
      (o: any) => o.correct === true || o.correct === 'true'
    );
    const row = page.locator('.option-row').nth(correctIdx);
    await row.click();
    await page.waitForTimeout(900); // past the feedback announcer's 400ms stagger too

    const state = await headingState(page);
    if (!state.found) throw new Error('heading element not found');
    // The verdict/feedback effects fired (same question, same index) — the
    // heading must NOT have reclaimed focus as a side effect of that.
    expect(state.isFocused).toBe(false);
  });

  test('rapid repeated Next clicks land focus on the FINAL question only (never a stale intermediate one), and navigating away entirely produces no console/page errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      // NG02955 (NgOptimizedImage LCP-priority advisory on QuizSelection's
      // tile images) is a pre-existing Angular dev-mode diagnostic, unrelated
      // to focus management — it fires whenever /quiz loads, regardless of
      // this fix. Everything else still fails the test.
      if (msg.text().includes('NG02955')) return;
      errors.push(msg.text());
    });

    await startQuizViaUi(page, 'fixture-doohickeys', /fixture doohickeys/i);

    for (let q = 0; q < 2; q++) {
      const correctIdxs: number[] = doohickeys.questions[q].options
        .map((o: any, i: number) => ((o.correct === true || o.correct === 'true') ? i : -1))
        .filter((i: number) => i >= 0);
      for (const idx of correctIdxs) {
        await page.locator('.option-row').nth(idx).click();
      }
      const nextBtn = page.locator(NEXT_BTN);
      await expect(nextBtn).toBeEnabled({ timeout: 10_000 });
      // Click Next immediately — deliberately inside the feedback
      // announcer's stagger window, and before any afterNextRender focus
      // callback from THIS click has necessarily run yet.
      await nextBtn.click();
    }
    await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForTimeout(500);

    // Focus must land on the FINAL question reached (index 2, 1-based),
    // never an intermediate one — confirms rapid Next/Next cannot leave
    // focus on a stale/earlier heading.
    const afterRapidNav = await headingState(page);
    if (!afterRapidNav.found) throw new Error('heading element not found');
    expect(afterRapidNav.isFocused).toBe(true);
    expect(afterRapidNav.text).toContain(doohickeys.questions[2].questionText.slice(0, 20));
    expect(afterRapidNav.text).not.toContain(doohickeys.questions[0].questionText.slice(0, 20));
    expect(afterRapidNav.text).not.toContain(doohickeys.questions[1].questionText.slice(0, 20));

    // Navigate away entirely while a focus effect could still be pending —
    // this component (and its injector) is destroyed mid-flight.
    await page.goto('/quiz');
    await page.locator('.quiz-tile').first().waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForTimeout(300);

    expect(errors).toEqual([]);
  });
});
