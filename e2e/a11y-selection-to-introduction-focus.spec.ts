import { test, expect } from '@playwright/test';
import { quizData } from './helpers';

/**
 * Regression coverage for a SEPARATE, scoped focus-only mitigation on
 * IntroductionComponent (introduction.component.ts/.html) — NOT the
 * Topic Quiz navigation-speech fix covered by a11y-navigation-announcement
 * and a11y-route-focus. This is its own investigation: Quiz Selection ->
 * Introduction is a SEPARATE route-change pair, one step earlier in the
 * funnel, with its own reported symptom (old Quiz Selection speech
 * continuing after Introduction has already loaded) and its own component.
 *
 * ── Why focus-only, not focus + a live announcement ─────────────────────
 * QuizComponent's Introduction -> Q1 cold start hit the same class of
 * problem. A real Narrator retest there found the combined approach
 * (focus + a coordinated navigation announcement) FAILED on that
 * transition, while focus ALONE, retested separately, PASSED — see
 * QuizComponent's route-focus effect for the full evidence trail. This
 * mirrors that confirmed result rather than reusing the announcement
 * approach untested on a different page.
 *
 * No new aria-live region was added, and no setTimeout/delay — focus runs
 * once, via afterNextRender (a post-render callback, not a timer), when
 * the real quiz card first becomes available. Introduction's own
 * PRE-EXISTING "Loading…" aria-live region (for a slow fetch) is
 * untouched. No app/router-level focus management was added — this is
 * scoped entirely to IntroductionComponent's own constructor effect.
 *
 * ── What this suite proves ──────────────────────────────────────────────
 * The quiz title receives focus, exactly once, with its own non-empty
 * text, once real quiz content is available after navigating from Quiz
 * Selection; it is not re-focused on its own re-renders; no new live
 * region was introduced.
 *
 * ── Manual retest results ────────────────────────────────────────────────
 * Keyboard-only navigation through this transition: PASSED. Narrator:
 * mostly works — the title is announced and heard. Three things this
 * manual retest surfaced, all tracked, none masked by this suite's
 * DOM-level assertions alone:
 *   - The title was being announced as "[title], Group" — a SEPARATE,
 *     now-fixed semantic defect confirmed via Chromium's raw accessibility
 *     tree (role="generic" on `MatCardTitle`, which has no ARIA role of
 *     its own, mapping to Windows UIA's ControlType.Group). Fixed first
 *     with an ARIA override (role="heading" aria-level="1"), then with a
 *     native `<h1 matCardTitle>` once that override was found to cause a
 *     further issue (next item) — see introduction.component.html's own
 *     comment. Not something this candidate's focus mechanism caused; it
 *     is a pre-existing Angular Material default this candidate's new
 *     focus call simply gave a reason to be read aloud for the first time.
 *   - Narrator then announced the heading role/level ("level 1") TWICE.
 *     CONFIRMED (not assumed) to be Narrator's own announcement behavior
 *     for a programmatically-focused native heading in general, NOT
 *     specific to this app or Material: a minimal, framework-free HTML
 *     page (one `<h1 tabindex="-1">`, no Angular, no Material, focused
 *     the same deferred way) was built and real-Narrator retested side
 *     by side with this component, and reproduced the IDENTICAL double
 *     announcement, with the identical DOM/accessibility-tree signature
 *     (one AX node, role "heading", one `.focus()` call, one `focusin`
 *     event) already found here. No further heading markup change is
 *     justified by any evidence gathered — the native `<h1>` is final.
 *   - The certificate-badge link's own speech from Quiz Selection still
 *     carries over in some cases. This remains UNRESOLVED. A DOM/focus/
 *     mutation trace found no evidence of that link being refocused or
 *     mutated after the click, but that does NOT prove no accessibility
 *     event occurred — DOM observers cannot see every platform
 *     accessibility notification Chromium may fire internally. No fix is
 *     proposed for this here.
 *
 * ── What this suite does NOT and cannot prove ───────────────────────────
 * That Narrator (or any other assistive technology) actually stops
 * speaking Quiz Selection content when this focus change happens, beyond
 * what the manual retest above already found. DOM-level assertions here
 * prove the mechanism itself (focus landing once, correctly, with no new
 * live region) — they cannot observe platform accessibility events the
 * way a real screen reader does.
 */

async function introTitleState(page: import('@playwright/test').Page) {
  const sel = 'h1[tabindex="-1"]';
  return page.evaluate((s) => {
    const el = document.querySelector(s) as HTMLElement | null;
    if (!el) return { found: false as const };
    return {
      found: true as const,
      isFocused: document.activeElement === el,
      text: (el.textContent || '').trim(),
    };
  }, sel);
}

test.describe('Quiz Selection -> Introduction focus (scoped candidate, Narrator retest pending)', () => {
  test('clicking a quiz tile focuses the Introduction title, with that quiz\'s own non-empty text', async ({ page }) => {
    const quiz = quizData.find((q: any) => (q.quizId || q.id) === 'fixture-doohickeys');

    await page.goto('/quiz');
    await page.locator('.quiz-tile').first().waitFor({ state: 'visible', timeout: 30_000 });
    const tile = page.locator('.quiz-tile').filter({ hasText: /fixture doohickeys/i }).first();
    await tile.scrollIntoViewIfNeeded();
    await tile.click();

    await page.locator('h1[tabindex="-1"]').waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForTimeout(300);

    const state = await introTitleState(page);
    if (!state.found) throw new Error('intro title element not found');
    expect(state.isFocused).toBe(true);
    expect(state.text.length).toBeGreaterThan(0);
    expect(state.text).toContain(quiz.milestone);
  });

  test('no new live region was introduced on this page by the focus mitigation', async ({ page }) => {
    await page.goto('/quiz');
    await page.locator('.quiz-tile').first().waitFor({ state: 'visible', timeout: 30_000 });
    // Filter out the Interview feature card — it routes to /interview, never
    // through Introduction, so `.first()` alone is not reliably a topic quiz.
    const tile = page.locator('.quiz-tile').filter({ hasText: /fixture doohickeys/i }).first();
    await tile.scrollIntoViewIfNeeded();
    await tile.click();

    await page.locator('h1[tabindex="-1"]').waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForTimeout(300);

    // The app shell's OWN start-spinner overlay (app.component.html) and
    // any Material/CDK-injected announcer element are pre-existing,
    // app-wide, and unrelated to this change — asserting zero aria-live
    // elements document-wide would be wrong. What this change must not do
    // is add one of ITS OWN inside the quiz card this component owns.
    const liveRegionCountInCard = await page.locator('.quiz-card [aria-live]').count();
    expect(liveRegionCountInCard).toBe(0);
  });

  test('the title is not re-focused on its own later re-renders (e.g. toggling the shuffle preference)', async ({ page }) => {
    await page.goto('/quiz');
    await page.locator('.quiz-tile').first().waitFor({ state: 'visible', timeout: 30_000 });
    const tile = page.locator('.quiz-tile').filter({ hasText: /fixture doohickeys/i }).first();
    await tile.scrollIntoViewIfNeeded();
    await tile.click();

    await page.locator('h1[tabindex="-1"]').waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForTimeout(300);

    // Move focus elsewhere deliberately, then interact with the page in a
    // way that re-renders (the slide toggle) — the title must NOT steal
    // focus back, since the one-shot guard only ever fires once per
    // component instance.
    const toggle = page.locator('mat-slide-toggle button[role="switch"]');
    await toggle.focus();
    await toggle.click();
    await page.waitForTimeout(300);

    const state = await introTitleState(page);
    if (!state.found) throw new Error('intro title element not found');
    expect(state.isFocused).toBe(false);
  });
});
