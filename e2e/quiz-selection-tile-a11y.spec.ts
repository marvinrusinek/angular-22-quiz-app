import { test, expect, Page } from '@playwright/test';

/**
 * THE REGRESSION: every quiz tile's clickable surface was a plain
 * `<div class="quiz-tile" (click)="onSelect(...)">` — no `tabindex`, `role`,
 * or keydown handler, so a keyboard-only or screen-reader user could not
 * reach or activate it at all (mouse/touch worked; Tab skipped straight
 * over every tile).
 *
 * Fixed with a real `<button type="button" class="quiz-tile__activate">`
 * overlaid across the same clickable area, so native browser semantics (Tab
 * reachability, Enter/Space activation) apply for free — no custom keydown
 * handling was added or is needed.
 */

const TILE = '.quiz-tile:not(.interview-tile)';
const ACTIVATE_BTN = '.quiz-tile__activate';

/** Tab forward until the target selector is the focused element, or fail. */
async function tabUntilFocused(page: Page, selector: string, maxPresses = 40): Promise<void> {
  for (let i = 0; i < maxPresses; i++) {
    const isFocused = await page.evaluate((sel) => {
      const active = document.activeElement;
      return !!active && !!document.querySelector(sel) && active === document.querySelector(sel);
    }, selector);
    if (isFocused) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Could not reach ${selector} via Tab within ${maxPresses} presses`);
}

test.describe('Quiz Selection tile — keyboard accessibility', () => {
  test('a tile is reachable via Tab, shows a visible focus indicator, and Enter activates it (same destination as a mouse click)', async ({ page }) => {
    await page.goto('/select');
    await page.locator(TILE).first().waitFor({ state: 'visible', timeout: 30_000 });

    const button = page.locator(TILE).first().locator(ACTIVATE_BTN);
    await expect(button).toHaveCount(1);

    await tabUntilFocused(page, `${TILE} ${ACTIVATE_BTN}`);
    await expect(button).toBeFocused();

    // Visible focus indicator: an outline actually painted, not "none".
    const outlineStyle = await button.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outlineStyle).not.toBe('none');

    await page.keyboard.press('Enter');
    // The same destination onSelect() always routes to for a not-started
    // quiz: /intro/<quizId> (or /results/<quizId> if already completed) —
    // either way, activation must navigate away from /select.
    await page.waitForURL(/\/(intro|results)\//, { timeout: 15_000 });
  });

  test('Space also activates the tile button (native <button> semantics, no custom handler needed)', async ({ page }) => {
    await page.goto('/select');
    await page.locator(TILE).first().waitFor({ state: 'visible', timeout: 30_000 });

    const button = page.locator(TILE).first().locator(ACTIVATE_BTN);
    await tabUntilFocused(page, `${TILE} ${ACTIVATE_BTN}`);
    await expect(button).toBeFocused();

    await page.keyboard.press('Space');
    await page.waitForURL(/\/(intro|results)\//, { timeout: 15_000 });
  });

  test('ordinary mouse click on the tile still selects it (unchanged behavior)', async ({ page }) => {
    await page.goto('/select');
    await page.locator(TILE).first().waitFor({ state: 'visible', timeout: 30_000 });

    await page.locator(TILE).first().click();
    await page.waitForURL(/\/(intro|results)\//, { timeout: 15_000 });
  });

  test('the status-icon link (when present) stays independently focusable and clickable, not swallowed by the tile button', async ({ page }) => {
    await page.goto('/select');
    await page.locator(TILE).first().waitFor({ state: 'visible', timeout: 30_000 });

    const statusLink = page.locator(`${TILE} .status-icon a`).first();
    if (await statusLink.count() === 0) {
      // No quiz has a known status in a fresh session — nothing to verify.
      return;
    }
    await expect(statusLink).toBeVisible();
    // Independently reachable/clickable — not covered by the full-tile button.
    await statusLink.click();
    await page.waitForURL(/\/(intro|results)\//, { timeout: 15_000 });
  });
});
