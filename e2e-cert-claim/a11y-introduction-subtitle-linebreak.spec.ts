import { test, expect, Page } from '@playwright/test';
import { tsQuiz } from '../e2e/helpers';

/**
 * Reopened: a live Narrator retest still reported a spoken "space" before
 * "Take the quiz and find out!" even after removing the stray leading-space
 * text node that followed the subtitle's `<br />`. Comparing the exact
 * subtitle DOM and accessibility structure (localhost vs. the deployed
 * build) found both identical — ruling out caching/staleness — but
 * surfaced something the whitespace fix could never have touched: the
 * `<br>` element ITSELF is exposed as its own accessible object (Chromium
 * maps it to `role: "LineBreak"`, `name: "\n"`), sitting between the two
 * sentences' own `StaticText` nodes, independent of any surrounding
 * whitespace.
 *
 * Candidate fix: `aria-hidden="true"` on the `<br>` only. Verified via CDP
 * before this test existed: with it, the standalone LineBreak node is gone
 * from the accessibility tree — only the two StaticText nodes remain, in
 * the same order — while the `<br>`'s own VISUAL line break is unaffected
 * (confirmed separately via layout measurement: the two sentences still
 * render on separate lines).
 *
 * Lives in e2e-cert-claim/ (run via `npm run e2e:certificate`) rather than
 * the main e2e/ harness: the Introduction page has no dependency on
 * Interview Mode/Spring at all, and this suite already provisions its own
 * disposable local Postgres container with no Spring webServer entry — the
 * right-sized isolation for a change that touches only Introduction markup.
 *
 * Confirmed by a real localhost Narrator retest: the "space" announcement
 * is gone specifically with this aria-hidden fix (not merely the earlier
 * whitespace removal, which was already live and insufficient on its own).
 *
 * RESOLVED 2026-10-14+, FOR TAB NAVIGATION ONLY: a real Narrator retest
 * found this still took 2 Down Arrow presses (the two StaticText nodes
 * this fix leaves exposed). Several candidates failed across two
 * different Narrator navigation mechanisms (see
 * introduction.component.html's own comment for the full history) before
 * `tabindex="0"` on this SAME element — no other markup change — made it
 * a normal Tab stop. A real Narrator retest, on the local production
 * build, confirmed Tab onto this element reads both sentences together
 * with the two-line layout preserved. The SAME retest found Down Arrow
 * (scan-mode reading) still reads the two sentences separately on this
 * exact markup — that is NOT fixed by this change and is not claimed to
 * be; do not conflate the two navigation mechanisms' results.
 *
 * That retest also reported Narrator saying "group" right after landing
 * on the subtitle via Tab. A CDP ancestor check (not committed) found
 * `<mat-card-subtitle>`'s own unstyled "generic" role as a plausible,
 * consistent explanation (the same role Chromium is known to map to
 * Windows UIA's ControlType.Group elsewhere in this app) — but that is
 * an observation and a plausible explanation, not something CDP ancestry
 * inspection proves is the actual cause of what Narrator speaks.
 */

/**
 * Uses `getFullAXTree` (whole page, unscoped) rather than
 * `getPartialAXTree`'s `fetchRelatives` convenience expansion — the
 * latter is a known-fragile API whose relative-expansion logic doesn't
 * reliably reach descendants once an intermediate node (like the
 * subtitle's own span, now a real non-ignored node since it's
 * `tabindex="0"`) changes the tree shape it was bridging through. A
 * full-tree scan, filtered to this subtitle's own known text, is robust
 * to that. Confirmed via a one-off diagnostic (not committed) that the
 * `fetchRelatives` approach silently returned nothing for this exact
 * content once the Tab-stop fix was added, while the full tree still had
 * it correctly — a test-helper fragility, not a real regression.
 */
async function subtitleAxNodes(page: Page): Promise<Array<{ role?: string; name?: string }>> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Accessibility.enable');
  const full = await cdp.send('Accessibility.getFullAXTree', {});
  return (full as any).nodes
    .filter((n: any) => {
      const name = n.name?.value;
      return (
        n.role?.value === 'LineBreak' ||
        (n.role?.value === 'StaticText' && typeof name === 'string' && (name.includes('versed') || name.includes('Take the quiz')))
      );
    })
    .map((n: any) => ({
      role: n.role ? n.role.value : undefined,
      name: n.name ? n.name.value : undefined
    }));
}

test.describe('Introduction subtitle: the <br> is hidden from the accessibility tree, sentences stay exposed in order', () => {
  test('no standalone LineBreak accessibility node exists between the two sentences, which remain StaticText in reading order', async ({ page }) => {
    await page.goto('/quiz');
    await page.locator('.quiz-tile').first().waitFor({ state: 'visible', timeout: 30_000 });
    const tile = page.locator('.quiz-tile').filter({ hasText: /fixture widgets/i }).first();
    await tile.scrollIntoViewIfNeeded();
    await tile.click();
    await page.locator('h1[tabindex="-1"]').waitFor({ state: 'visible', timeout: 20_000 });

    const nodes = await subtitleAxNodes(page);

    // The defect this fix removes: no node of role "LineBreak" anywhere
    // under the subtitle.
    expect(nodes.some((n) => n.role === 'LineBreak')).toBe(false);

    // Both sentences are still exposed, as StaticText, in the same order
    // as the source — nothing about the actual content was suppressed.
    const staticTextNames = nodes.filter((n) => n.role === 'StaticText').map((n) => n.name);
    expect(staticTextNames).toEqual([
      `How well versed are you in ${tsQuiz.milestone}?`,
      'Take the quiz and find out!'
    ]);
  });

  test('the visible line break is unaffected: the two sentences still render on separate lines', async ({ page }) => {
    await page.goto('/quiz');
    await page.locator('.quiz-tile').first().waitFor({ state: 'visible', timeout: 30_000 });
    const tile = page.locator('.quiz-tile').filter({ hasText: /fixture widgets/i }).first();
    await tile.scrollIntoViewIfNeeded();
    await tile.click();
    await page.locator('h1[tabindex="-1"]').waitFor({ state: 'visible', timeout: 20_000 });

    const layout = await page.evaluate(() => {
      const span = document.querySelector('mat-card-subtitle span')!;
      const textNodes = Array.from(span.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE);
      const firstRange = document.createRange();
      firstRange.selectNodeContents(textNodes[0]);
      const lastRange = document.createRange();
      lastRange.selectNodeContents(textNodes[textNodes.length - 1]);
      return {
        firstLineTop: firstRange.getBoundingClientRect().top,
        secondLineTop: lastRange.getBoundingClientRect().top,
        brStillInDom: !!span.querySelector('br'),
        brAriaHidden: span.querySelector('br')?.getAttribute('aria-hidden')
      };
    });

    expect(layout.brStillInDom).toBe(true);
    expect(layout.brAriaHidden).toBe('true');
    expect(layout.secondLineTop).toBeGreaterThan(layout.firstLineTop + 5);
  });

  test('the subtitle is a real Tab stop reachable by keyboard, with a visible focus outline (Tab navigation only — the title above it remains tabindex="-1" and is not itself a normal Tab stop)', async ({ page }) => {
    await page.goto('/quiz');
    await page.locator('.quiz-tile').first().waitFor({ state: 'visible', timeout: 30_000 });
    const tile = page.locator('.quiz-tile').filter({ hasText: /fixture widgets/i }).first();
    await tile.scrollIntoViewIfNeeded();
    await tile.click();
    await page.locator('h1[tabindex="-1"]').waitFor({ state: 'visible', timeout: 20_000 });

    // Arrival focus lands on the title (unchanged, tabindex="-1", not a
    // normal Tab stop) — pressing Tab once from there should reach the
    // subtitle, since it's the first real tabbable element on this page.
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      return {
        tag: el.tagName,
        className: el.className,
        text: (el.textContent ?? '').trim(),
        outlineStyle: getComputedStyle(el).outlineStyle
      };
    });

    expect(focused.className).toContain('intro-subtitle-text');
    expect(focused.text).toContain('How well versed');
    expect(focused.text).toContain('Take the quiz and find out!');
    expect(focused.outlineStyle).not.toBe('none');
  });
});
