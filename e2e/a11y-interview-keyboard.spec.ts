import { test, expect, Page } from '@playwright/test';

/**
 * Full keyboard-only Interview flow: Builder -> Session -> Results -> Export
 * Report, with no .click() anywhere.
 *
 * An earlier attempt at this test pressed Enter on every focused control,
 * including the Quick Setup / Difficulty chips. Those chips are REAL native
 * `<input type="radio">` elements inside a `<form (submit)="...startInterview()">`
 * (see build-your-interview.component.html's own comment: "The native event
 * keeps Enter-to-submit working"). Pressing Enter while a radio has focus
 * submits the nearest form in every browser — it triggered startInterview()
 * before Topics/Count were configured, which is what actually broke that
 * attempt. It was a test-script defect, not a product one: fixed here by
 * using the correct native keys per control —
 *   - radio chips (Quick Setup, Difficulty): Tab enters the group ONCE
 *     (landing on whichever is checked, or the first if none is); ArrowRight
 *     moves AND selects within the group. Enter is never sent to a radio.
 *   - checkboxes (Topics): each is its own Tab stop; Space toggles it.
 *   - real `<button type="button">` (Select All, count chips, io-option,
 *     pg-next, show-results-btn): Enter/Space both safely activate them.
 *   - the actual `<button type="submit" class="start-interview-btn">`:
 *     Enter here is the intended submit action.
 */

/**
 * Assessment Integrity Mode (a separate, pre-existing feature — see
 * assessment-integrity.service.ts) can pop its "Assessment focus lost" dialog
 * if the page's window blurs, which can happen running headless under heavy
 * background automation even with no real external focus change. It is
 * unrelated to this a11y fix; dismiss it the same way a real keyboard user
 * would (its "Return to Assessment" button is `cdkFocusInitial`, so Enter
 * dismisses it the instant it opens) rather than let it block the flow.
 * Checked on every tabUntil iteration since it can appear unpredictably
 * between any two keystrokes, not just at fixed call sites.
 */
async function dismissIntegrityDialogIfPresent(page: Page): Promise<void> {
  const dialog = page.getByRole('heading', { name: 'Assessment focus lost' });
  // Target the dialog's own button directly (`.press('Enter')` focuses it
  // first) rather than blindly sending Enter to "whatever currently has
  // focus": MatDialog's cdkFocusInitial trap can lag its DOM insertion by a
  // tick, and a blind Enter in that gap can land on the PAGE's own focused
  // control instead (observed: it hit the session's "Enter Full Screen"
  // button, which then caused repeated fullscreen enter/exit cycles — each
  // one its own integrity event — compounding the problem instead of
  // clearing it). Not asserting it stays closed: under heavy background
  // load the window blur/visibilitychange that opens it can repeat.
  if (await dialog.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Return to Assessment' }).press('Enter');
    await page.waitForTimeout(100);
  }
}

async function tabUntil(page: Page, predicate: () => Promise<boolean>, maxPresses = 60): Promise<void> {
  for (let i = 0; i < maxPresses; i++) {
    await dismissIntegrityDialogIfPresent(page);
    if (await predicate()) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Condition not met within ${maxPresses} Tab presses`);
}

/** Every real key-activation goes through here: dismiss the (unrelated, load-dependent) integrity dialog first if it reopened right before this exact keystroke. */
async function pressKey(page: Page, key: string): Promise<void> {
  await dismissIntegrityDialogIfPresent(page);
  await page.keyboard.press(key);
}

test.describe('Full keyboard-only Interview flow', () => {
  test('Builder -> Session -> Results -> Export Report, keyboard only', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/interview');
    await page.locator('.chip:has-text("Beginner")').first().waitFor({ state: 'visible' });

    // Quick Setup radiogroup: Tab lands on "Custom" (already checked, the
    // default) — confirmed via the input's own checked state, no key sent.
    await tabUntil(page, async () =>
      page.evaluate(() => (document.activeElement as HTMLInputElement)?.closest('label.chip')?.textContent?.includes('Custom') ?? false),
    );
    const customChecked = await page.evaluate(() => (document.activeElement as HTMLInputElement)?.checked);
    expect(customChecked).toBe(true);

    // Difficulty radiogroup: Tab lands on "Beginner" (default-checked);
    // ArrowRight switches to "Intermediate" to PROVE keyboard control (not
    // just that the default happens to be acceptable), no Enter involved.
    await pressKey(page, 'Tab');
    const landedOnDifficulty = await page.evaluate(() =>
      (document.activeElement as HTMLInputElement)?.closest('.option-row[role="radiogroup"]')?.getAttribute('aria-label'),
    );
    expect(landedOnDifficulty).toBe('Difficulty');
    await pressKey(page, 'ArrowRight');
    const afterArrow = await page.evaluate(() => ({
      checked: (document.activeElement as HTMLInputElement)?.checked,
      label: (document.activeElement as HTMLInputElement)?.closest('label.chip')?.textContent?.trim(),
    }));
    expect(afterArrow.checked).toBe(true);
    expect(afterArrow.label).toBe('Intermediate');

    // Topics: reach "Select All" (a real button, Enter is safe) via Tab.
    const boxes = page.locator('.topic-check input[type="checkbox"]');
    await expect(boxes.first()).toBeVisible();
    await tabUntil(page, async () => page.evaluate(() => (document.activeElement?.textContent || '').trim() === 'Select All'));
    await pressKey(page, 'Enter');
    await expect(boxes.first()).toBeChecked();

    // Question count: a real <button>, Enter is safe.
    await tabUntil(page, async () => page.evaluate(() => (document.activeElement?.textContent || '').trim() === '10'));
    await pressKey(page, 'Enter');

    // Start Interview: the actual submit button — Enter is the intended action.
    await tabUntil(page, async () => page.evaluate(() => (document.activeElement as HTMLElement)?.classList?.contains('start-interview-btn')));
    await expect(page.locator('.start-interview-btn')).toBeEnabled();
    await pressKey(page, 'Enter');
    await page.waitForURL(/\/interview\/session\/[^/?#]+/, { timeout: 20_000 });
    await expect(page.locator('.interview-question-box')).toBeVisible();

    // Answer all 10 questions via keyboard only (Tab to the option, Space,
    // Tab to Next, Enter — io-option/pg-next are real buttons).
    for (let i = 1; i <= 10; i++) {
      await dismissIntegrityDialogIfPresent(page);
      await tabUntil(page, async () => page.evaluate(() => (document.activeElement as HTMLElement)?.closest('.io-option') !== null));
      const optionOutline = await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle);
      expect(optionOutline).not.toBe('none'); // visible focus on the option itself
      await pressKey(page, 'Space');
      await expect(page.locator('.io-option').first()).toHaveClass(/io-selected/);
      if (i < 10) {
        await dismissIntegrityDialogIfPresent(page);
        await tabUntil(page, async () => page.evaluate(() => (document.activeElement as HTMLElement)?.classList?.contains('pg-next')));
        await pressKey(page, 'Enter');
        await expect(page.locator('.interview-progress')).toContainText(`Question ${i + 1}`);
      }
    }

    // Submit: Show Results -> confirmation dialog -> Submit Assessment, all
    // real buttons, Enter is safe throughout.
    await dismissIntegrityDialogIfPresent(page);
    await tabUntil(page, async () => page.evaluate(() => (document.activeElement as HTMLElement)?.classList?.contains('show-results-btn')));
    await pressKey(page, 'Enter');
    await expect(page.getByText('Submit Assessment?')).toBeVisible();
    // Two elements share this text now: the page's own (disabled-looking)
    // button behind the dialog, and the dialog's real confirm button — the
    // same ambiguity interview-report.spec.ts's helper disambiguates with
    // `.last()`. `.press('Enter')` focuses this exact element first, so it's
    // still a real keyboard activation, just an unambiguous one.
    await dismissIntegrityDialogIfPresent(page);
    await page.locator('button:has-text("Submit Assessment")').last().press('Enter');
    await page.waitForURL(/\/interview\/results\/[^/?#]+/, { timeout: 20_000 });

    // Results: Export Report reachable, visible focus, Enter opens it.
    await tabUntil(page, async () => page.evaluate(() => (document.activeElement?.textContent || '').trim() === 'Export Report'));
    const exportOutline = await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle);
    expect(exportOutline).not.toBe('none');
    await pressKey(page, 'Enter');
    await page.waitForURL(/\/interview\/report\/[^/?#]+/, { timeout: 20_000 });

    // Export Report: heading receives focus automatically on route arrival
    // (already covered by interview-report.spec.ts's click-driven flow; this
    // confirms it's also true for a keyboard-only arrival).
    await expect(page.getByRole('heading', { level: 1, name: 'Interview Report' })).toBeFocused();
    await expect(page.locator('article.rv-item')).toHaveCount(10);

    // Back to Results via keyboard, closing the loop.
    await tabUntil(page, async () => page.evaluate(() => (document.activeElement?.textContent || '').trim() === 'Back to Results'));
    await pressKey(page, 'Enter');
    await page.waitForURL(/\/interview\/results\/[^/?#]+/, { timeout: 20_000 });

    console.log('FULL KEYBOARD-ONLY INTERVIEW FLOW: Builder -> Session -> Results -> Export Report -> Results, no mouse used');
  });
});
