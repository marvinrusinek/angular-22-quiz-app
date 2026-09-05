import { test, expect, Page } from '@playwright/test';

/**
 * Assessment Integrity Mode (browser-based DETERRENT) — Interview Mode only.
 * Verifies copy prevention scoped to the assessment box, a simulated focus
 * change recording exactly one event + the warning-on-return + continue, the
 * timer still advancing, and NO restrictions leaking onto Topic Quizzes.
 */

async function configureAndStart(page: Page, count: '10' | '20' | '30' = '10') {
  await page.locator('.chip:has-text("Beginner")').first().click();
  const boxes = page.locator('.topic-check input[type="checkbox"]');
  await expect(boxes.first()).toBeVisible();
  // Use the builder's own Select All rather than ticking each box: choosing a
  // difficulty re-renders the topic list, so a loop over a captured count can
  // click an element that has just been replaced.
  await page.locator('.topics-toolbar button:has-text("Select All")').click();
  await expect(boxes.first()).toBeChecked();
  await page.locator(`.chip--button:has-text("${count}")`).first().click();
  await page.locator('.start-interview-btn').click();
  // The session route carries the backend session id.
  await page.waitForURL(/\/interview\/session\/[^/?#]+/);
  await expect(page.locator('.interview-question-box')).toBeVisible();
}

// Simulate a tab-switch away and back inside the page (Playwright can't truly
// background a tab, so we drive the same events the browser fires).
async function simulateFocusAway(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('blur'));
  });
}
async function simulateFocusReturn(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });
}

test.describe('Assessment Integrity Mode', () => {
  test('question/answer text cannot be selected in the assessment box (user-select: none)', async ({ page }) => {
    await page.goto('/interview');
    await configureAndStart(page, '10');

    const userSelect = await page.evaluate(() => {
      const box = document.querySelector('.interview-question-box') as HTMLElement;
      return getComputedStyle(box).userSelect || (getComputedStyle(box) as any).webkitUserSelect;
    });
    expect(userSelect).toBe('none');

    // A copy event fired inside the box is prevented.
    const copyPrevented = await page.evaluate(() => {
      const box = document.querySelector('.interview-question-box') as HTMLElement;
      const ev = new Event('copy', { bubbles: true, cancelable: true });
      box.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    expect(copyPrevented).toBe(true);
  });

  test('a single simulated focus change records ONE event + warns on return + can continue', async ({ page }) => {
    await page.goto('/interview');
    await configureAndStart(page, '10');

    await simulateFocusAway(page);
    // No dialog while away.
    await expect(page.getByText('Assessment focus lost')).toHaveCount(0);

    await simulateFocusReturn(page);
    // Warning shown on return.
    await expect(page.getByText('Assessment focus lost')).toBeVisible();

    // Continue the assessment.
    await page.locator('button:has-text("Return to Assessment")').click();
    await expect(page.getByText('Assessment focus lost')).toHaveCount(0);
    await expect(page.locator('.interview-question-box')).toBeVisible();

    // Exactly one recorded (paired blur+visibilitychange did not double-count).
    await expect(page.locator('.ai-focus-status')).toContainText('1');

    // Still answerable after returning.
    await page.locator('.io-input').first().check({ force: true });
    await expect(page.locator('.io-option').first()).toBeVisible();
  });

  test('the assessment timer keeps advancing across a focus change', async ({ page }) => {
    await page.goto('/interview?interviewSeconds=600');
    await configureAndStart(page, '10');

    const read = async () =>
      (await page.locator('.interview-timer__value').innerText()).trim();
    const before = await read();

    await simulateFocusAway(page);
    await page.waitForTimeout(2500);
    await simulateFocusReturn(page);
    await page.locator('button:has-text("Return to Assessment")').click();

    const after = await read();
    expect(after).not.toBe(before);   // countdown continued while "away"
  });

  test('Topic Quizzes receive NO integrity restrictions', async ({ page }) => {
    await page.goto('/quiz/intro/fixture-widgets');
    await page.locator('button:has-text("Start the Quiz")').click();
    await expect(page.locator('mat-radio-button, .option').first()).toBeVisible();

    const info = await page.evaluate(() => {
      const hasInterviewBox = !!document.querySelector('.interview-question-box');
      const hasFullscreenBtn = !!document.querySelector('.ai-fullscreen-btn');
      // The topic question heading must remain selectable.
      const heading = document.querySelector('h3[quiz-projected-content], mat-card-content h3') as HTMLElement | null;
      const headingSelect = heading ? getComputedStyle(heading).userSelect : 'auto';
      return { hasInterviewBox, hasFullscreenBtn, headingSelect };
    });
    expect(info.hasInterviewBox).toBe(false);
    expect(info.hasFullscreenBtn).toBe(false);
    expect(info.headingSelect).not.toBe('none');
  });
});
