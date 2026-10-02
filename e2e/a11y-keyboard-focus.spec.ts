import { test, expect, Page } from '@playwright/test';
import { HEADING, NEXT_BTN } from './helpers';

/**
 * Regression coverage for two accessibility defects fixed on
 * fix/a11y-keyboard-focus:
 *
 * 1) Topic Quiz answers (mat-radio-button / mat-checkbox) were keyboard
 *    unreachable: quiz-question.component.scss's "hide all MDC visuals" rule
 *    put `display: none` on the native .mdc-radio__native-control /
 *    .mdc-checkbox__native-control inputs, which removes an element from the
 *    tab order entirely (opacity/visibility would not). Fixed by excluding
 *    those two selectors from the hide-rule — they're made
 *    invisible-but-present instead (opacity:0, full-size, on top) by a rule
 *    already in the same file — and adding a `:has(input:focus-visible)`
 *    outline on the custom option box.
 *
 * 2) The Score/Timer scoreboard menu triggers suppressed `outline` on
 *    `:focus-visible` (not just `:focus`/`:active`), in both styles.scss
 *    (global) and timer.component.scss's own same-specificity-tier
 *    `.mat-mdc-button:focus-visible` rule — both had to change or the
 *    component-local rule would keep winning. Fixed by splitting
 *    `:focus-visible` out of the "remove on click" rules in both files and
 *    restoring a real outline for it.
 *
 * These assert actual DOM/computed-style behavior in a real browser (Tab
 * reachability, native Space activation, `getComputedStyle(...).outline*`),
 * not CSS source text, so they fail if the rendered result regresses even if
 * someone reshuffles the selectors that produce it.
 */

const OPTION_ROW = '.option-row';

async function tabUntil(
  page: Page,
  predicate: () => Promise<boolean>,
  maxPresses = 60,
): Promise<void> {
  for (let i = 0; i < maxPresses; i++) {
    if (await predicate()) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Condition not met within ${maxPresses} Tab presses`);
}

test.describe('Topic Quiz answers — keyboard reachable + visible focus (defect 1)', () => {
  test("Tab reaches the first option's native input, Space selects it, and Next proceeds — keyboard only", async ({ page }) => {
    await page.goto('/quiz/question/fixture-widgets/1');
    await page.locator(OPTION_ROW).first().waitFor({ state: 'visible', timeout: 20_000 });

    await tabUntil(page, async () => {
      const type = await page.evaluate(() => document.activeElement?.getAttribute('type'));
      return type === 'radio' || type === 'checkbox';
    });

    const activeType = await page.evaluate(() => document.activeElement?.getAttribute('type'));
    expect(['radio', 'checkbox']).toContain(activeType);

    // Structural assertion: Tab could not have landed here if the native
    // input were still `display: none` — confirm it genuinely isn't.
    const activeDisplay = await page.evaluate(
      () => getComputedStyle(document.activeElement as Element).display,
    );
    expect(activeDisplay).not.toBe('none');

    // Visible focus indicator on the custom option box.
    const box = page.locator(OPTION_ROW).first();
    await expect(box).toBeVisible();
    const outlineStyle = await box.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outlineStyle).not.toBe('none');

    // Native radio activation via Space — no custom keydown handler involved.
    await page.keyboard.press('Space');
    await expect(box).toHaveClass(/selected/);

    await expect(page.locator(NEXT_BTN)).toBeEnabled();
    await page.locator(NEXT_BTN).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator(HEADING)).toBeVisible();
  });

  test('a mouse click still selects the option, with no visible focus outline (unchanged visuals)', async ({ page }) => {
    await page.goto('/quiz/question/fixture-widgets/1');
    const box = page.locator(OPTION_ROW).first();
    await box.waitFor({ state: 'visible', timeout: 20_000 });

    await box.click();
    await expect(box).toHaveClass(/selected/);

    const outlineStyle = await box.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outlineStyle).toBe('none');
  });
});

test.describe('Score/Timer menu triggers — visible keyboard focus, mouse styling preserved (defect 2)', () => {
  const triggers = [
    { name: 'Score menu trigger', ariaLabel: 'Score display menu' },
    { name: 'Timer menu trigger', ariaLabel: 'Timer menu' },
  ];

  for (const { name, ariaLabel } of triggers) {
    test(`${name}: Tab shows a real outline; a mouse click does not`, async ({ page }) => {
      await page.goto('/quiz/question/fixture-widgets/1');
      const trigger = page.getByRole('button', { name: ariaLabel });
      await trigger.waitFor({ state: 'visible', timeout: 20_000 });

      await tabUntil(page, async () => trigger.evaluate((el) => el === document.activeElement));
      await expect(trigger).toBeFocused();
      const kbOutline = await trigger.evaluate((el) => getComputedStyle(el).outlineStyle);
      expect(kbOutline).not.toBe('none');

      // Re-focus via a mouse click (opens the menu) — no visible outline.
      await trigger.click();
      const mouseOutline = await trigger.evaluate((el) => getComputedStyle(el).outlineStyle);
      expect(mouseOutline).toBe('none');
    });
  }

  test('Score menu: Enter opens it, Escape closes it and returns focus to the trigger', async ({ page }) => {
    await page.goto('/quiz/question/fixture-widgets/1');
    const trigger = page.getByRole('button', { name: 'Score display menu' });
    await trigger.waitFor({ state: 'visible', timeout: 20_000 });

    await tabUntil(page, async () => trigger.evaluate((el) => el === document.activeElement));
    await page.keyboard.press('Enter');
    await expect(page.locator('.mat-mdc-menu-panel')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('.mat-mdc-menu-panel')).toBeHidden();
    await expect(trigger).toBeFocused();
  });
});
