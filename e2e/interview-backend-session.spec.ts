import { test, expect, Page, request } from '@playwright/test';

import { SPRING_HEALTH_URL } from './support/e2e-backends';

/**
 * Stage 9D-2 cutover smoke: the Interview session route driven against a REAL
 * backend.
 *
 * What this proves that a unit test cannot: the builder creates the session on
 * the server, the guard hydrates the route from it, answers are written over
 * HTTP, and a refresh re-fetches everything — while the browser never receives
 * an answer key. The full Interview e2e migration lands in Stage 9F; this file
 * covers the cutover itself.
 *
 * These tests need the Spring Interview backend that Playwright starts on :8080. If it is not
 * healthy the whole file FAILS (it used to skip, and it used to probe the Node backend on :3000,
 * which is not the one that serves Interview sessions).
 */

const OPTION = '.io-input';
const NEXT = '.pg-next';
const PROGRESS = '.interview-progress';
const QUESTION_BOX = '.interview-question-box';
const SESSION_URL = /\/interview\/session\/[^/?#]+/;

test.beforeAll(async () => {
  // Interview lifecycle traffic goes to SPRING (the app's INTERVIEW_API_BASE_URL), which Playwright
  // starts and controls — see playwright.config.ts. A backend that is not answering means the harness
  // is broken, and that must FAIL: skipping would let a misconfigured run report green while proving
  // nothing. The URL comes from the shared helper, never from an environment override, so this
  // cannot be pointed at a backend the harness does not control.
  const context = await request.newContext();
  try {
    const response = await context.get(SPRING_HEALTH_URL, { timeout: 5000 });
    expect(
      response.ok(),
      `The controlled Spring Interview backend at ${SPRING_HEALTH_URL} is not healthy (HTTP ${response.status()}) — Playwright should have started it`
    ).toBe(true);
  } finally {
    await context.dispose();
  }
});

async function startInterview(page: Page, count = '10'): Promise<void> {
  await page.goto('/interview');
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

  // The session id is in the URL — it is an identifier, not a secret.
  await page.waitForURL(SESSION_URL);
  await expect(page.locator(QUESTION_BOX)).toBeVisible();
}

const storedReference = (page: Page) =>
  page.evaluate(() => sessionStorage.getItem('interviewSessionRef:v2'));

/**
 * A reload counts as leaving the assessment, so Assessment Integrity Mode
 * greets the user with its warning-on-return dialog. That is the shipped
 * behaviour; dismiss it before touching the page underneath.
 */
async function dismissIntegrityWarning(page: Page): Promise<void> {
  const button = page.locator('button:has-text("Return to Assessment")');
  if (await button.isVisible().catch(() => false)) {
    await button.click();
    await expect(button).toHaveCount(0);
  }
}

test.describe('Interview session — real backend', () => {
  test('builder creates the session, the guard hydrates the route, answers persist', async ({ page }) => {
    await startInterview(page);

    await expect(page.locator(PROGRESS)).toContainText('Question 1');
    await expect(page.locator(NEXT)).toBeDisabled();

    // Answering issues a save; Next opens once the server confirms it.
    await page.locator(OPTION).first().check({ force: true });
    await expect(page.locator(NEXT)).toBeEnabled();
    await expect(page.locator('.interview-save--error')).toHaveCount(0);

    await page.locator(NEXT).click();
    await expect(page.locator(PROGRESS)).toContainText('Question 2');
  });

  test('a refresh re-fetches position, answers and remaining time from the server', async ({ page }) => {
    await startInterview(page);

    await page.locator(OPTION).first().check({ force: true });
    await expect(page.locator(NEXT)).toBeEnabled();
    await page.locator(NEXT).click();
    await expect(page.locator(PROGRESS)).toContainText('Question 2');

    const before = await page.locator('.interview-timer__value').textContent();
    const questionBefore = await page.locator('.interview-question').textContent();

    await page.reload();
    await expect(page.locator(QUESTION_BOX)).toBeVisible();
    await dismissIntegrityWarning(page);

    // Same question, restored from the stored INDEX plus a fresh server fetch.
    await expect(page.locator(PROGRESS)).toContainText('Question 2');
    expect(await page.locator('.interview-question').textContent()).toBe(questionBefore);

    // Time is anchored to the server deadline, so a refresh cannot extend it.
    const after = await page.locator('.interview-timer__value').textContent();
    const seconds = (value: string | null) => {
      const [m, s] = (value ?? '0:0').split(':');
      return Number(m) * 60 + Number(s);
    };
    expect(seconds(after)).toBeLessThanOrEqual(seconds(before));

    // Going back shows the answer the SERVER holds for question 1.
    await page.locator('.pg-prev').click();
    await expect(page.locator(PROGRESS)).toContainText('Question 1');
    await expect(page.locator(`${OPTION}:checked`)).toHaveCount(1);
  });

  test('the browser is never sent an answer key', async ({ page }) => {
    const bodies: string[] = [];
    page.on('response', async (response) => {
      if (!response.url().includes('/api/')) return;
      try {
        bodies.push(await response.text());
      } catch {
        // Non-text response — nothing to inspect.
      }
    });

    await startInterview(page);
    await page.locator(OPTION).first().check({ force: true });
    await expect(page.locator(NEXT)).toBeEnabled();

    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      for (const banned of ['isCorrect', 'is_correct', 'correctOptionIds', 'explanation']) {
        expect(body).not.toContain(banned);
      }
    }

    // Nothing on screen reveals correctness before submission either.
    await expect(page.locator('.correct-option, .incorrect-option')).toHaveCount(0);
  });

  test('only the minimal reference is persisted, and the token is sessionStorage-only', async ({ page }) => {
    await startInterview(page);
    await page.locator(OPTION).first().check({ force: true });
    await expect(page.locator(NEXT)).toBeEnabled();

    const raw = await storedReference(page);
    expect(raw).not.toBeNull();
    expect(Object.keys(JSON.parse(raw!)).sort())
      .toEqual(['currentIndex', 'sessionId', 'sessionToken', 'version']);

    // The legacy key held a full generated assessment; it must be gone.
    expect(await page.evaluate(() => sessionStorage.getItem('interviewSession'))).toBeNull();

    // A bearer token in localStorage would survive the tab and the session.
    const local = await page.evaluate(() => JSON.stringify(localStorage));
    expect(local).not.toContain('sessionToken');
    expect(local).not.toContain(JSON.parse(raw!).sessionToken);
  });

  test('a session URL with no stored reference redirects to the builder', async ({ page }) => {
    await page.goto('/interview');
    await page.evaluate(() => sessionStorage.clear());

    await page.goto('/interview/session/is_not_a_real_session');
    await expect(page).toHaveURL(/\/interview$/);
  });

  test('the id-less legacy session path redirects to the builder', async ({ page }) => {
    await page.goto('/interview/session');
    await expect(page).toHaveURL(/\/interview$/);
  });

  test('a session id that does not match the stored reference is refused', async ({ page }) => {
    await startInterview(page);
    const reference = JSON.parse((await storedReference(page))!) as { sessionId: string };

    await page.goto(`/interview/session/${reference.sessionId}-tampered`);
    await expect(page).toHaveURL(/\/interview$/);

    // The real reference survives — a typed URL must not destroy a live session.
    const after = JSON.parse((await storedReference(page))!) as { sessionId: string };
    expect(after.sessionId).toBe(reference.sessionId);
  });
});
