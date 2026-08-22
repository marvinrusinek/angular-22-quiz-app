import { test, expect, Page } from '@playwright/test';

import { HEADING, NEXT_BTN, PREV_BTN } from './helpers';

/**
 * The composed FET must survive leaving and returning to the tab.
 *
 * ── The regression this pins ──────────────────────────────────────
 *
 * Answering correctly composes a FET that names the option:
 *
 *     "Option 1 is correct because TS uses a colon (:) to ..."
 *
 * Switching away from the browser and back replaced it with the RAW
 * authorized explanation — the same sentence without the composed prefix.
 * The hide path deliberately clears explanation state
 * (`resetExplanationStateOnHide`, `refreshExplanationStatePostRestore`) to stop
 * a stale FET replaying, and `heading-inputs` falls through to the verdict's own
 * raw text when every FET store is empty. Once the composed value was gone,
 * that fallback was all that remained.
 *
 * ── Why CDP rather than a dispatched event ────────────────────────
 *
 * Two cheaper approaches were tried against this defect and BOTH silently
 * proved nothing:
 *
 *   1. `page.bringToFront()` on a second tab. The shared config launches
 *      Chromium with --disable-backgrounding-occluded-windows and friends
 *      (deliberately — see playwright.config.ts), so no page ever goes hidden.
 *      Zero visibility events fired and the spec passed without exercising
 *      a single line of the restore path.
 *   2. The same, with those flags dropped for the file. Also zero events:
 *      headless Chromium does not background a page for a foreground change.
 *
 *   3. CDP `Emulation.setPageVisibilityStateOverride`, which drove the
 *      browser's own state. It has been REMOVED from the protocol —
 *      "'Emulation.setPageVisibilityStateOverride' wasn't found".
 *
 * What remains — and what `assessment-integrity.spec.ts` already uses — is to
 * override `document.visibilityState`/`hidden` and dispatch the real events.
 * That is NOT the empty synthetic case the brief warns about: the handler's
 * first branch reads `document.visibilityState`, so overriding the property is
 * exactly what makes the hide path execute. Dispatching the event ALONE (with
 * the property left 'visible') is the version that silently skips the restore
 * chain, and is what this deliberately does not do. Everything downstream —
 * `resetExplanationStateOnHide`, the purge, `performFullVisibilityRestore`,
 * `refreshExplanationStatePostRestore` — is the app's real code.
 */

const MSG = '.instructions-message';
const NEXT_MSG = 'Please click the Next button to continue.';

/** Text that must never replace a composed FET. */
const PLACEHOLDERS = [
  /Explanation not provided/i,
  /No explanation available/i,
  /Error (loading|processing) explanation/i
];

async function gotoQuestion(page: Page, quiz: string, n: number): Promise<void> {
  await page.goto(`/quiz/question/${quiz}/${n}`);
  await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 30_000 });
}

/**
 * Leave the tab and come back, the way a user does.
 *
 * The override is applied and then CLEARED — not merely set to 'visible' — so
 * the page is left under normal browser control for the rest of the spec.
 */
async function setVisibility(page: Page, state: 'hidden' | 'visible'): Promise<void> {
  const seen = await page.evaluate((next) => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => next
    });
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => next === 'hidden'
    });

    let observed = false;
    const witness = () => { observed = document.visibilityState === next; };
    document.addEventListener('visibilitychange', witness);

    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event(next === 'hidden' ? 'blur' : 'focus'));

    document.removeEventListener('visibilitychange', witness);
    return observed;
  }, state);

  // The app must actually observe the transition. Both earlier approaches
  // no-opped silently and produced GREEN tests that exercised nothing — this
  // fails loudly instead.
  expect(seen, `page did not observe visibilityState='${state}'`).toBe(true);
}

async function leaveAndReturn(page: Page): Promise<void> {
  await setVisibility(page, 'hidden');

  // Time spent away, not a hack to catch a transient: the hide path is async
  // (it persists state and captures elapsed time) and the defect appears on
  // the RETURN. Every assertion after this is retried up to its timeout, so
  // this does not race anything.
  await page.waitForTimeout(1200);

  await setVisibility(page, 'visible');
}

test.describe('composed FET survives a real tab switch', () => {
  test('leaving the tab and returning keeps the composed FET', async ({ page }) => {
    await gotoQuestion(page, 'typescript', 1);

    await page.locator('.option-row').nth(0).click();
    await expect(page.locator(HEADING)).toContainText(/is correct because/i, { timeout: 15_000 });

    const composed = (await page.locator(HEADING).textContent())?.trim() ?? '';
    expect(composed).toMatch(/^Option \d+ (is|are) correct because/i);

    await leaveAndReturn(page);

    // The SAME composed text, not merely "something containing the raw words".
    // Asserting the exact string is what distinguishes the composed FET from
    // the raw authorized explanation it used to be replaced by.
    await expect(page.locator(HEADING)).toHaveText(composed, { timeout: 15_000 });

    const after = (await page.locator(HEADING).textContent())?.trim() ?? '';
    expect(after).toMatch(/^Option \d+ (is|are) correct because/i);
    for (const placeholder of PLACEHOLDERS) expect(after).not.toMatch(placeholder);
    expect(after.length).toBeGreaterThan(0);
  });

  test('the selection message also survives the tab switch', async ({ page }) => {
    await gotoQuestion(page, 'typescript', 1);

    await page.locator('.option-row').nth(0).click();
    await expect(page.locator(MSG)).toHaveText(NEXT_MSG, { timeout: 15_000 });

    await leaveAndReturn(page);

    await expect(page.locator(MSG)).toHaveText(NEXT_MSG, { timeout: 15_000 });
    await expect(page.locator(MSG)).not.toHaveText('Please select the correct answer to continue.');
  });
});

test.describe('revisit navigation does not leak explanations', () => {
  /**
   * A revisit deliberately shows QUESTION TEXT, not the FET — pinned by
   * `single-source-heading.spec.ts` ("correct click -> FET; revisit -> question
   * text") and `heading-model.spec.ts` ("on a revisit the FET is suppressed for
   * a RESOLVED question"). So the guard here is that the heading returns to the
   * RIGHT question's text and never to another question's explanation.
   */
  test('Next then Previous returns to this question, with no foreign FET', async ({ page }) => {
    await gotoQuestion(page, 'typescript', 1);

    const questionText = (await page.locator(HEADING).textContent())?.trim() ?? '';

    await page.locator('.option-row').nth(0).click();
    await expect(page.locator(HEADING)).toContainText(/is correct because/i, { timeout: 15_000 });
    const composed = (await page.locator(HEADING).textContent())?.trim() ?? '';

    await page.locator(NEXT_BTN).click();
    // Q2 must not inherit Q1's explanation.
    await expect(page.locator(HEADING)).not.toHaveText(composed, { timeout: 15_000 });

    await page.locator(PREV_BTN).click();

    await expect(page.locator(HEADING)).toHaveText(questionText, { timeout: 15_000 });

    const heading = (await page.locator(HEADING).textContent())?.trim() ?? '';
    for (const placeholder of PLACEHOLDERS) expect(heading).not.toMatch(placeholder);
  });

  test('an unanswered next question shows no explanation at all', async ({ page }) => {
    await gotoQuestion(page, 'typescript', 1);

    await page.locator('.option-row').nth(0).click();
    await expect(page.locator(HEADING)).toContainText(/is correct because/i, { timeout: 15_000 });

    await page.locator(NEXT_BTN).click();
    await page.locator('.option-row').first().waitFor({ state: 'visible' });

    // Nothing has been checked on Q2, so no FET may be showing — neither a
    // leaked one nor a fabricated placeholder.
    const heading = (await page.locator(HEADING).textContent())?.trim() ?? '';
    expect(heading).not.toMatch(/is correct because/i);
    for (const placeholder of PLACEHOLDERS) expect(heading).not.toMatch(placeholder);
  });
});
