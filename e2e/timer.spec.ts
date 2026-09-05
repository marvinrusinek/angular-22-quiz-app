import { test, expect, Page } from '@playwright/test';
import { HEADING, NEXT_BTN, PREV_BTN, correctIndexForHeading } from './helpers';

/**
 * Timer freeze-on-revisit guard.
 *
 * Feature (shipped 2026-06-07/08, ~10 hard-won iterations): revisiting a
 * CORRECTLY-answered question shows its countdown FROZEN at the seconds it had
 * when answered — not a fresh full countdown, not running, and not a bogus
 * 0:00 flash. Past bugs: the display reset to 0:30 and counted down, or mirrored
 * another question's time, or flashed 0:00.
 *
 * This needs no app changes / no waiting for expiry: we let a few seconds
 * elapse, answer correctly, leave and come back, and assert the timer is
 * frozen (stable over time, not full, not zero) on revisit.
 */

const TIMER = '.scoreboard-timer .scoreboard';

async function startTs(page: Page) {
  await page.goto('/quiz/intro/fixture-widgets');
  await page.locator('.start-btn').click();
  await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 20_000 });
}

/** Read the countdown seconds from the "0:SS" timer display. */
async function readTimerSeconds(page: Page): Promise<number> {
  const t = (await page.locator(TIMER).textContent()) ?? '';
  const m = t.match(/(\d+):(\d+)/);
  return m ? Number(m[2]) : NaN;
}

test.describe('timer — freeze on revisit of a correctly-answered question', () => {
  test('revisited correct answer shows a frozen (not reset, not zero, not running) timer', async ({ page }) => {
    await startTs(page);
    const rows = page.locator('.option-row');

    // Let a few seconds elapse so the frozen value is clearly < full (30).
    await expect.poll(async () => readTimerSeconds(page), { timeout: 8000 }).toBeLessThanOrEqual(27);

    // Answer Q1 correctly → its timer should freeze for revisits.
    const h = (await page.locator(HEADING).textContent()) ?? '';
    const correctIdx = correctIndexForHeading(h);
    expect(correctIdx).toBeGreaterThanOrEqual(0);
    await rows.nth(correctIdx).click();
    await expect(page.locator(NEXT_BTN)).toBeEnabled();

    // Go forward to Q2, then back to Q1 (the revisit).
    await page.locator(NEXT_BTN).click();
    await expect(page).toHaveURL(/\/2$/);
    await page.locator('.option-row').first().waitFor({ state: 'visible' });
    await page.locator(PREV_BTN).click();
    await expect(page).toHaveURL(/\/1$/);
    await page.locator('.option-row').first().waitFor({ state: 'visible' });

    // On revisit the timer must be frozen:
    const onRevisit = await readTimerSeconds(page);
    expect(Number.isNaN(onRevisit)).toBe(false);
    expect(onRevisit).toBeGreaterThan(0);   // not a bogus 0:00 flash
    expect(onRevisit).toBeLessThan(30);     // not reset to the full countdown

    // ...and not running: stable across ~2.5s (a reset/running timer would tick down).
    await page.waitForTimeout(2500);
    const later = await readTimerSeconds(page);
    expect(later).toBe(onRevisit);
  });
});

/**
 * Timeout-coloring guard (Option A: real countdown, no app changes — so this
 * test is slow by design). On timeout the correct option(s) are revealed green
 * and UNSELECTED INCORRECT options stay gray (neither green nor red). Guards the
 * bug fixed 2026-06-12 where an unselected incorrect option wrongly turned green
 * on timeout (isCurrentOptionCorrect reading the wrong question). The color
 * classes (correct-option / incorrect-option) live on `.option-row`.
 */
test.describe('timer — timeout option coloring', () => {
  test('on timeout, correct options turn green and unselected incorrect options stay gray', async ({ page }) => {
    test.setTimeout(60_000); // the real ~30s countdown must elapse
    await startTs(page);
    const rows = page.locator('.option-row');

    // Capture the correct index BEFORE timeout (the heading becomes the FET after).
    const h = (await page.locator(HEADING).textContent()) ?? '';
    const correctIdx = correctIndexForHeading(h);
    expect(correctIdx).toBeGreaterThanOrEqual(0);
    const optCount = await rows.count();

    // Do NOT answer — let the countdown run out.
    await expect.poll(async () => readTimerSeconds(page), { timeout: 45_000 }).toBe(0);
    await page.waitForTimeout(1000); // let the timeout reveal + coloring apply

    // Correct option is revealed green.
    await expect(rows.nth(correctIdx)).toHaveClass(/correct-option/);

    // Every unselected INCORRECT option is gray: neither green nor red.
    for (let i = 0; i < optCount; i++) {
      if (i === correctIdx) continue;
      await expect(rows.nth(i)).not.toHaveClass(/correct-option/);
      await expect(rows.nth(i)).not.toHaveClass(/incorrect-option/);
    }
  });
});
