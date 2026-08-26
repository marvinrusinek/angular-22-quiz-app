import { test, expect, Page } from '@playwright/test';

import { HEADING, correctIndexForHeading } from './helpers';

/**
 * A PENDING VERDICT PAINTS NOTHING — COLOUR, NOT JUST CLASSES.
 *
 * `130eb7a1` fixed the two CSS-class branches and the visible red flash
 * SURVIVED on the deployed site, because the colour comes from an inline
 * `[style.background-color]` binding that still read the two-state view. A
 * frame-accurate trace showed the row sweeping to #ff0000 by ~1691ms and only
 * reaching green at ~1908ms — with `incorrect-option` never applied.
 *
 * The earlier live verifier sampled `className` every 250ms and passed. It was
 * measuring the wrong property, so no sampling rate would have caught it.
 * These assert the COMPUTED BACKGROUND, and hold `/check` open so the pending
 * window is deterministic rather than a race against localhost latency.
 *
 * Service workers are blocked because `page.route` cannot intercept a fetch a
 * service worker serves.
 */

test.use({ serviceWorkers: 'block' });

const ROW = '.option-row';

/** Red channel dominant and green channel low — i.e. visibly red. */
function isRed(bg: string): boolean {
  const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return false;
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return r > 150 && g < 110 && b < 110;
}

function isGreen(bg: string): boolean {
  const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return false;
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return g > 150 && r < 150;
}

/**
 * Clicks with `/check` held open and samples the computed background on EVERY
 * animation frame, so a one-frame paint cannot slip between samples.
 */
async function paintDuringPending(page: Page, idx: number): Promise<string[]> {
  let release: (() => void) | null = null;
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/check**', async (route) => { await held; await route.continue(); });

  await page.evaluate((i) => {
    const w = window as any;
    w.__paint = [];
    const row = document.querySelectorAll('.option-row')[i] as HTMLElement;
    let n = 0;
    const tick = () => {
      if (n++ > 180 || !row) return;
      w.__paint.push(getComputedStyle(row).backgroundColor);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, idx);

  await page.locator(ROW).nth(idx).click({ noWaitAfter: true });
  await page.waitForTimeout(2000);          // well past the 0.2s CSS transition
  const samples: string[] = await page.evaluate(() => (window as any).__paint ?? []);
  release!();
  await page.waitForTimeout(2500);
  return samples;
}

async function open(page: Page): Promise<number> {
  await page.goto('/quiz/question/typescript/1');
  await page.locator(ROW).first().waitFor({ state: 'visible', timeout: 30_000 });
  const heading = (await page.locator(HEADING).first().textContent()) ?? '';
  return correctIndexForHeading(heading);
}

test.describe('pending verdicts paint neither colour', () => {
  test('a CORRECT pick is never red at any frame while the check is in flight', async ({ page }) => {
    const correct = await open(page);

    const samples = await paintDuringPending(page, correct);
    const reds = samples.filter(isRed);
    console.log('PAINT correct: ' + samples.length + ' frames, ' + reds.length + ' red, distinct=' +
      JSON.stringify([...new Set(samples)].slice(0, 6)));

    // THE REGRESSION: the row swept to #ff0000 for ~113ms before turning green.
    expect(reds, 'no red frame while the verdict is unknown').toEqual([]);

    // ...and it resolves green once authorized.
    await expect
      .poll(async () => isGreen(await page.locator(ROW).nth(correct).evaluate(
        (el) => getComputedStyle(el).backgroundColor)), { timeout: 20_000 })
      .toBe(true);
  });

  test('a WRONG pick is not red while pending, then red once authorized', async ({ page }) => {
    const correct = await open(page);
    const wrong = correct === 0 ? 1 : 0;

    const samples = await paintDuringPending(page, wrong);
    const reds = samples.filter(isRed);
    console.log('PAINT wrong: ' + samples.length + ' frames, ' + reds.length + ' red');

    expect(reds, 'not red merely because the verdict is pending').toEqual([]);

    await expect
      .poll(async () => isRed(await page.locator(ROW).nth(wrong).evaluate(
        (el) => getComputedStyle(el).backgroundColor)), { timeout: 20_000 })
      .toBe(true);
  });

  test('CORRECT pick: no icon while pending, check once authorized', async ({ page }) => {
    const correct = await open(page);

    let release: (() => void) | null = null;
    const held = new Promise<void>((r) => { release = r; });
    await page.route('**/check**', async (route) => { await held; await route.continue(); });

    await page.locator(ROW).nth(correct).click({ noWaitAfter: true });
    await page.waitForTimeout(1200);

    const pending = await page.locator(ROW).nth(correct)
      .locator('mat-icon, .material-icons').allTextContents();
    console.log('PAINT correct icons pending: ' + JSON.stringify(pending));
    expect(pending.join(' '), 'no cross before the verdict').not.toContain('close');
    expect(pending.join(' '), 'no tick before the verdict either').not.toContain('check');

    release!();

    // Authorized correct → the tick, and green.
    await expect
      .poll(async () => (await page.locator(ROW).nth(correct)
        .locator('mat-icon, .material-icons').allTextContents()).join(' '), { timeout: 20_000 })
      .toContain('check');
    await expect
      .poll(async () => isGreen(await page.locator(ROW).nth(correct).evaluate(
        (el) => getComputedStyle(el).backgroundColor)), { timeout: 20_000 })
      .toBe(true);
  });

  test('WRONG pick: no icon while pending, close once authorized', async ({ page }) => {
    const correct = await open(page);
    const wrong = correct === 0 ? 1 : 0;

    let release: (() => void) | null = null;
    const held = new Promise<void>((r) => { release = r; });
    await page.route('**/check**', async (route) => { await held; await route.continue(); });

    await page.locator(ROW).nth(wrong).click({ noWaitAfter: true });
    await page.waitForTimeout(1200);

    const pending = await page.locator(ROW).nth(wrong)
      .locator('mat-icon, .material-icons').allTextContents();
    console.log('PAINT wrong icons pending: ' + JSON.stringify(pending));
    expect(pending.join(' '), 'no cross before the verdict').not.toContain('close');
    expect(pending.join(' '), 'no tick before the verdict').not.toContain('check');

    release!();

    // Authorized wrong → the cross, and red.
    await expect
      .poll(async () => (await page.locator(ROW).nth(wrong)
        .locator('mat-icon, .material-icons').allTextContents()).join(' '), { timeout: 20_000 })
      .toContain('close');
    await expect
      .poll(async () => isRed(await page.locator(ROW).nth(wrong).evaluate(
        (el) => getComputedStyle(el).backgroundColor)), { timeout: 20_000 })
      .toBe(true);
  });
});
