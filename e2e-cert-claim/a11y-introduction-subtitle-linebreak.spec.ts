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
 */

async function subtitleAxNodes(page: Page): Promise<Array<{ role?: string; name?: string }>> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Accessibility.enable');
  await cdp.send('DOM.enable');

  await page.evaluate(() => {
    document.querySelectorAll('[data-ax-probe]').forEach((el) => el.removeAttribute('data-ax-probe'));
    const subtitle = document.querySelector('mat-card-subtitle');
    if (subtitle) subtitle.setAttribute('data-ax-probe', '1');
  });

  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const { nodeId } = await cdp.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: '[data-ax-probe="1"]'
  });
  const desc = await cdp.send('DOM.describeNode', { nodeId });
  const ax = await cdp.send('Accessibility.getPartialAXTree', {
    backendNodeId: (desc as any).node.backendNodeId,
    fetchRelatives: true
  });
  return (ax as any).nodes.map((n: any) => ({
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
});
