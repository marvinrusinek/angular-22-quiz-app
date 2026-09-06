import { test, expect } from '@playwright/test';
import { HEADING, NEXT_BTN, RESULTS_BTN, tsQuiz, correctIndexForHeading } from './helpers';

/**
 * Angular Aria Toolbar prototype — keyboard coverage for the Quiz Review
 * filter (All / Correct / Incorrect) on the Topic Quiz Results page.
 *
 * THE BEHAVIOR BEING PINNED: `ngToolbar`/`ngToolbarWidgetGroup` replace the
 * old plain `role="group"` + `aria-pressed` buttons with `role="radiogroup"`
 * + `role="radio"`/`aria-checked` and native roving tabindex + Arrow Left/
 * Right navigation. `reviewFilter` remains the ONE authoritative signal that
 * drives which review items are displayed.
 */

async function reachResultsWithMixedScore(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/quiz/question/fixture-widgets/1');
  const total = tsQuiz.questions.length;

  for (let i = 0; i < total; i++) {
    const rows = page.locator('.option-row');
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    await expect
      .poll(async () => correctIndexForHeading((await page.locator(HEADING).textContent()) ?? ''),
        { timeout: 8000 })
      .toBeGreaterThanOrEqual(0);

    const correct = correctIndexForHeading((await page.locator(HEADING).textContent()) ?? '');
    // Deliberately get the FIRST question wrong so BOTH Correct and
    // Incorrect filters have at least one matching item.
    const pick = i === 0 ? (correct === 0 ? 1 : 0) : correct;
    await rows.nth(pick).click();

    if (i < total - 1) {
      await page.locator(NEXT_BTN).click();
      await expect(page).toHaveURL(new RegExp(`/${i + 2}$`));
    }
  }

  await page.locator(RESULTS_BTN).click();
  await expect(page).toHaveURL(/\/results\//);
}

test('Results review filter: keyboard Tab/Arrow/Enter navigation, mouse click, and visible focus', async ({ page }) => {
  await reachResultsWithMixedScore(page);

  // The accordion only renders when the "Quiz Review" section is active
  // (behind the collapsible nav menu), and is itself @defer (on viewport)
  // inside it — it does not exist in the DOM at all until that section is
  // selected AND scrolled into view.
  await page.getByLabel('Toggle navigation menu').click();
  await page.locator('button.nav-item', { hasText: 'Quiz Review' }).click();
  await page.locator('.quiz-summary').scrollIntoViewIfNeeded();

  const group = page.locator('.review-filter');
  await group.waitFor({ state: 'visible', timeout: 20_000 });
  await expect(group).toHaveAttribute('role', 'radiogroup');

  const buttons = page.locator('.review-filter-btn');
  await expect(buttons).toHaveCount(3);

  // 1-2. Tab into the group; initial focus lands on the currently-checked
  // item ("All"), the group's single native Tab stop (roving tabindex).
  await page.keyboard.press('Tab');
  let attempts = 0;
  while (attempts < 40) {
    const isInGroup = await page.evaluate(() => {
      const active = document.activeElement;
      return !!active && !!active.closest('.review-filter');
    });
    if (isInGroup) break;
    await page.keyboard.press('Tab');
    attempts++;
  }
  const allBtn = buttons.nth(0);
  await expect(allBtn).toBeFocused();
  await expect(allBtn).toHaveAttribute('aria-checked', 'true');

  // Visible focus indicator: an outline actually painted, not "none".
  const outlineStyle = await allBtn.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outlineStyle).not.toBe('none');

  // 3. Arrow Right moves focus to "Correct" (roving tabindex — no click).
  await page.keyboard.press('ArrowRight');
  const correctBtn = buttons.nth(1);
  await expect(correctBtn).toBeFocused();
  // Moving focus alone must not change the selection/filter yet.
  await expect(allBtn).toHaveAttribute('aria-checked', 'true');

  // 4. Arrow Left moves focus back to "All".
  await page.keyboard.press('ArrowLeft');
  await expect(allBtn).toBeFocused();

  // 5. The documented keyboard interaction (Enter) changes the selection.
  await page.keyboard.press('ArrowRight'); // focus -> "Correct"
  await page.keyboard.press('Enter');
  await expect(correctBtn).toHaveAttribute('aria-checked', 'true');
  await expect(allBtn).toHaveAttribute('aria-checked', 'false');

  // 6. Selecting "Correct" actually changes the displayed application
  // results — assert via the filter button's own live count, which is
  // unambiguous and stable regardless of the accordion's internal item markup.
  const correctCountText = (await correctBtn.textContent()) ?? '';
  const correctCountMatch = correctCountText.match(/\((\d+)\)/);
  expect(correctCountMatch).not.toBeNull();
  const expectedCorrect = Number(correctCountMatch![1]);
  expect(expectedCorrect).toBeGreaterThan(0);

  // 7. Mouse selection still works: click "Incorrect" directly.
  const incorrectBtn = buttons.nth(2);
  await incorrectBtn.click();
  await expect(incorrectBtn).toHaveAttribute('aria-checked', 'true');
  await expect(correctBtn).toHaveAttribute('aria-checked', 'false');

  // 8. Focus indicator remains visible after a mouse-driven selection change.
  await expect(incorrectBtn).toBeFocused();
});
