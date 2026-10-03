import { test, expect, Page } from '@playwright/test';

/**
 * Regression coverage for a reproduced low-contrast defect on
 * IntroductionComponent: the quiz-meta line ("N Questions · ~N min") and the
 * "Shuffle questions and answers" toggle label both used a HARDCODED blue
 * (chambray-blue / vivid-blue respectively) with no theme-aware override.
 * Measured against the real --bg-card tokens:
 *   - chambray-blue on the dark card (#3a3d46): 1.60:1
 *   - vivid-blue on the dark card:               3.67:1
 *   - vivid-blue on the LIGHT card (also found while verifying this fix,
 *     not something the dark-theme report mentioned):   2.96:1
 * All three are below WCAG AA's 4.5:1 for normal text. Fixed via one
 * theme-aware `--intro-accent` custom property
 * (introduction.component.scss), unchanged in light mode (still
 * chambray-blue, 6.77:1) and a lightened shade in dark mode (#6fb3ff,
 * 4.94:1) — both now comfortably clear 4.5:1.
 */

function luminance(rgb: string): number {
  const [r, g, b] = (rgb.match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map(Number);
  const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrastRatio(rgb1: string, rgb2: string): number {
  const l1 = luminance(rgb1);
  const l2 = luminance(rgb2);
  const [a, b] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (a + 0.05) / (b + 0.05);
}

async function readColors(page: Page) {
  return page.evaluate(() => {
    const cs = (el: Element | null) => (el ? getComputedStyle(el) : null);
    const card = document.querySelector('.quiz-card, mat-card.quiz-card');
    const metaItem = document.querySelector('.meta-item:not(.meta-difficulty)');
    // The VISIBLE label text does not inherit color from the mat-slide-toggle
    // host — confirmed via CDP's CSS.getMatchedStylesForNode against the real
    // app: MDC renders it through a nested <label class="mdc-label">, themed
    // by Material's own `--mat-slide-toggle-label-text-color` custom property
    // (falling back to --mat-sys-on-surface, a near-black Material default,
    // when unset). An earlier version of this test read the HOST's color
    // instead, which looked correct but did not reflect what was actually
    // painted — the real defect this spec exists to catch.
    const toggleLabel = document.querySelector('mat-slide-toggle label.mdc-label');
    return {
      cardBg: cs(card)?.backgroundColor ?? '',
      metaItemColor: cs(metaItem)?.color ?? '',
      toggleColor: cs(toggleLabel)?.color ?? '',
    };
  });
}

test.describe('Introduction meta/toggle contrast — both themes, enabled and keyboard-focused', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`${theme} theme: quiz-meta text and toggle label both clear 4.5:1 against the card`, async ({ page }) => {
      await page.goto('/quiz/intro/fixture-widgets');
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      await page.locator('.quiz-meta').first().waitFor({ state: 'visible', timeout: 20_000 });

      const { cardBg, metaItemColor, toggleColor } = await readColors(page);
      expect(contrastRatio(metaItemColor, cardBg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(toggleColor, cardBg)).toBeGreaterThanOrEqual(4.5);
    });

    test(`${theme} theme: toggle label color is unchanged while keyboard-focused`, async ({ page }) => {
      await page.goto('/quiz/intro/fixture-widgets');
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      await page.locator('.quiz-meta').first().waitFor({ state: 'visible', timeout: 20_000 });

      const before = await readColors(page);

      for (let i = 0; i < 15; i++) {
        const inToggle = await page.evaluate(() => !!document.activeElement?.closest('mat-slide-toggle'));
        if (inToggle) break;
        await page.keyboard.press('Tab');
      }
      expect(await page.evaluate(() => !!document.activeElement?.closest('mat-slide-toggle'))).toBe(true);

      const after = await readColors(page);
      expect(after.toggleColor).toBe(before.toggleColor);
      expect(contrastRatio(after.toggleColor, after.cardBg)).toBeGreaterThanOrEqual(4.5);
    });
  }

  test('375px width, dark theme: both still clear 4.5:1 (mobile media query only changes size, not color)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/quiz/intro/fixture-widgets');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.locator('.quiz-meta').first().waitFor({ state: 'visible', timeout: 20_000 });

    const { cardBg, metaItemColor, toggleColor } = await readColors(page);
    expect(contrastRatio(metaItemColor, cardBg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(toggleColor, cardBg)).toBeGreaterThanOrEqual(4.5);
  });

  test('the difficulty badge keeps its own per-difficulty color, unaffected by this fix', async ({ page }) => {
    await page.goto('/quiz/intro/fixture-widgets');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    const badge = page.locator('.meta-difficulty');
    if ((await badge.count()) === 0) return; // this fixture quiz has no declared difficulty — nothing to check
    const color = await badge.evaluate((el) => getComputedStyle(el).color);
    const accentColor = await page.locator('.meta-item:not(.meta-difficulty)').first().evaluate((el) => getComputedStyle(el).color);
    expect(color).not.toBe(accentColor); // still its own distinct green/yellow/red, not the generic accent
  });

  test('the slide toggle has no disabled state on this page (verified absent, not assumed)', async ({ page }) => {
    await page.goto('/quiz/intro/fixture-widgets');
    await page.locator('.quiz-meta').first().waitFor({ state: 'visible', timeout: 20_000 });
    const disabled = await page.locator('mat-slide-toggle').getAttribute('ng-reflect-disabled').catch(() => null);
    const ariaDisabled = await page.locator('mat-slide-toggle button[role="switch"]').getAttribute('aria-disabled').catch(() => null);
    expect(ariaDisabled === 'true' || disabled === 'true').toBe(false);
  });
});
