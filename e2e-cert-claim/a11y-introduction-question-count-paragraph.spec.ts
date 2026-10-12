import { test, expect, Page } from '@playwright/test';

/**
 * REOPENED: a real localhost Narrator retest still required multiple Down
 * Arrow presses to read the "Test your wits with N timed multiple-choice
 * questions!" paragraph, even after an earlier `role="presentation"` fix
 * on the `<strong>` wrapping the dynamic count. That fix only changed the
 * accessibility tree's ROLE for the element; it did not remove the
 * element itself, which remained a separate DOM node and a separate
 * rendered text run from its neighbors. Claiming that three merged-role
 * StaticText nodes would read as one Narrator unit was an unproven
 * assumption — this spec does not repeat it, and the real retest proved
 * it wrong.
 *
 * This spec instead compares the paragraph against a genuinely minimal,
 * framework-free single-text-node paragraph (built inline, no app
 * involvement) to establish what a TRUE one-leaf-object paragraph's
 * accessibility shape looks like, then verifies the app's own paragraph
 * — now built from one Angular interpolation (`introDetailsTextSig()`),
 * no child elements at all — is structurally identical to that baseline.
 * This establishes the DOM/accessibility-tree shape only; it does not and
 * cannot establish what Narrator actually speaks or how many Down Arrow
 * presses it takes — only a real Narrator retest can confirm that.
 */

async function axNodesOf(page: Page, selector: string): Promise<Array<{ role?: string; name?: string }>> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Accessibility.enable');
  await cdp.send('DOM.enable');

  await page.evaluate((sel) => {
    document.querySelectorAll('[data-ax-probe]').forEach((el) => el.removeAttribute('data-ax-probe'));
    const el = document.querySelector(sel);
    if (el) el.setAttribute('data-ax-probe', '1');
  }, selector);

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

test.describe('Introduction question-count paragraph vs. a minimal single-text-node baseline', () => {
  test('a genuinely minimal paragraph with one text node exposes exactly one StaticText accessibility node (the reference shape)', async ({ page }) => {
    await page.goto('about:blank');
    await page.setContent('<p id="baseline">Test your wits with 10 timed multiple-choice questions! Have fun and share!</p>');

    const domChildCount = await page.evaluate(
      () => document.getElementById('baseline')!.childNodes.length
    );
    expect(domChildCount).toBe(1);

    const nodes = await axNodesOf(page, '#baseline');
    const staticTextNodes = nodes.filter((n) => n.role === 'StaticText');
    expect(staticTextNodes).toHaveLength(1);
    expect(staticTextNodes[0].name).toBe(
      'Test your wits with 10 timed multiple-choice questions! Have fun and share!'
    );
  });

  test("the app's own paragraph is structurally identical to that baseline: one DOM text node, one StaticText node, no child elements", async ({ page }) => {
    await page.goto('/quiz');
    await page.locator('.quiz-tile').first().waitFor({ state: 'visible', timeout: 30_000 });
    const tile = page.locator('.quiz-tile').filter({ hasText: /fixture widgets/i }).first();
    await tile.scrollIntoViewIfNeeded();
    await tile.click();
    await page.locator('h1[tabindex="-1"]').waitFor({ state: 'visible', timeout: 20_000 });

    const dom = await page.evaluate(() => {
      const p = document.querySelector('.intro-centered-text')!;
      return {
        childCount: p.childNodes.length,
        childTypes: Array.from(p.childNodes).map((n) => n.nodeType),
        hasAnyChildElement: p.querySelector('*') !== null,
        text: p.textContent?.trim()
      };
    });

    // No child elements at all — exactly one text node, matching the
    // minimal baseline's own shape. 3 === Node.TEXT_NODE (the browser DOM
    // constant, not available in this Node.js test-runner context).
    expect(dom.childCount).toBe(1);
    expect(dom.childTypes).toEqual([3]);
    expect(dom.hasAnyChildElement).toBe(false);

    const nodes = await axNodesOf(page, '.intro-centered-text');
    const staticTextNodes = nodes.filter((n) => n.role === 'StaticText');
    expect(staticTextNodes).toHaveLength(1);

    // The real, dynamic count is preserved in that one node — not hidden,
    // not replaced with a placeholder.
    expect(staticTextNodes[0].name).toMatch(
      /^Test your wits with \d+ timed multiple-choice questions! Have fun and share!$/
    );
    expect(dom.text).toBe(staticTextNodes[0].name);
  });
});
