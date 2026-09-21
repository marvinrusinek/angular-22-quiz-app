import { test, expect, Page, request } from '@playwright/test';

import { SPRING_HEALTH_URL } from './support/e2e-backends';

/**
 * Stage 9E: the RESULTS half of the backend migration, against a real backend.
 *
 * Covers what the restored Interview specs do not: that a refresh re-fetches
 * an identical frozen result, that nothing answer-bearing reaches localStorage,
 * and that the result endpoint carries no backend internals.
 *
 * Needs the Spring Interview backend that Playwright starts on :8080. If it is not healthy the
 * whole file FAILS (it used to skip, and it used to probe the Node backend on :3000).
 */

const RESULTS_URL = /\/interview\/results\/[^/?#]+/;
const HISTORY_KEY = 'interviewAttemptHistory:v2';

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

async function completeInterview(page: Page, count = 10): Promise<void> {
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
  await page.waitForURL(/\/interview\/session\/[^/?#]+/);

  for (let i = 1; i <= count; i++) {
    const option = page.locator('.io-option').first();
    await option.click();
    await expect(option).toHaveClass(/io-selected/);
    if (i < count) {
      await page.locator('.pg-next').first().click();
      await expect(page.locator('.interview-progress')).toContainText(`Question ${i + 1}`);
    }
  }

  await page.locator('.show-results-btn').click();
  await expect(page.getByText('Submit Assessment?')).toBeVisible();
  await page.locator('button:has-text("Submit Assessment")').last().click();
  await page.waitForURL(RESULTS_URL);
}

/** A reload counts as leaving the assessment, so Integrity greets the user. */
async function dismissIntegrityWarning(page: Page): Promise<void> {
  const button = page.locator('button:has-text("Return to Assessment")');
  if (await button.isVisible().catch(() => false)) await button.click();
}

test.describe('Interview results — real backend', () => {
  test('a refresh re-fetches an IDENTICAL frozen result', async ({ page }) => {
    await completeInterview(page);

    const before = {
      score: await page.locator('.score-pct').innerText(),
      stats: await page.locator('.stat-grid dd').allInnerTexts(),
      topics: await page.locator('.topic-row').allInnerTexts()
    };

    await page.reload();
    await dismissIntegrityWarning(page);
    await expect(page.locator('.score-pct')).toBeVisible();

    expect(await page.locator('.score-pct').innerText()).toBe(before.score);
    expect(await page.locator('.stat-grid dd').allInnerTexts()).toEqual(before.stats);
    expect(await page.locator('.topic-row').allInnerTexts()).toEqual(before.topics);

    // Review is still available — re-fetched, not restored from storage.
    await page.locator('button:has-text("Review Answers")').click();
    await expect(page.locator('.rv-item')).toHaveCount(10);
    await expect(page.locator('.rv-explanation__heading').first()).toBeVisible();
  });

  test('a refresh does not create a second history entry', async ({ page }) => {
    await completeInterview(page);

    const attempts = async () => {
      const raw = await page.evaluate((key) => localStorage.getItem(key), HISTORY_KEY);
      return JSON.parse(raw ?? '{"attempts":[]}').attempts.length as number;
    };
    expect(await attempts()).toBe(1);

    await page.reload();
    await dismissIntegrityWarning(page);
    await expect(page.locator('.score-pct')).toBeVisible();
    await page.reload();
    await dismissIntegrityWarning(page);
    await expect(page.locator('.score-pct')).toBeVisible();

    // Deduplicated by the server-stable sessionId.
    expect(await attempts()).toBe(1);
  });

  test('history v2 stores sanitized analytics ONLY', async ({ page }) => {
    await completeInterview(page);

    const raw = await page.evaluate((key) => localStorage.getItem(key), HISTORY_KEY);
    expect(raw).not.toBeNull();

    const store = JSON.parse(raw!);
    expect(store.version).toBe(2);

    const attempt = store.attempts[0];
    expect(attempt.sessionId).toBeTruthy();
    expect(attempt.totalQuestions).toBe(10);
    expect(attempt.topicPerformance.length).toBeGreaterThan(0);

    for (const banned of [
      'review', 'questions', 'options', 'selectedOptionIds', 'correctOptionIds',
      'explanation', 'answerKey', 'sessionToken', 'questionText'
    ]) {
      expect(raw).not.toContain(banned);
    }
  });

  test('NO complete review — and no token — reaches localStorage', async ({ page }) => {
    await completeInterview(page);

    // Capture real question text from the rendered review, then prove it is
    // nowhere on disk.
    await page.locator('button:has-text("Review Answers")').click();
    await expect(page.locator('.rv-item')).toHaveCount(10);
    const questionText = (await page.locator('.rv-question').first().innerText()).trim();
    expect(questionText.length).toBeGreaterThan(10);

    const local = await page.evaluate(() => JSON.stringify(localStorage));
    expect(local).not.toContain(questionText);
    expect(local).not.toContain('sessionToken');

    // The token lives in sessionStorage only, inside the minimal reference.
    const reference = await page.evaluate(() => sessionStorage.getItem('interviewSessionRef:v2'));
    expect(Object.keys(JSON.parse(reference!)).sort())
      .toEqual(['currentIndex', 'sessionId', 'sessionToken', 'version']);
    expect(local).not.toContain(JSON.parse(reference!).sessionToken);
  });

  test('the result response carries no internal database fields', async ({ page }) => {
    const bodies: string[] = [];
    page.on('response', async (response) => {
      if (!response.url().includes('/result') && !response.url().includes('/submit')) return;
      try {
        bodies.push(await response.text());
      } catch {
        // Non-text response.
      }
    });

    await completeInterview(page);
    // The response handler reads bodies asynchronously, so poll rather than
    // assuming they have landed by the time navigation finishes.
    await expect.poll(() => bodies.length).toBeGreaterThan(0);

    for (const body of bodies) {
      for (const banned of [
        'isCorrect', 'is_correct', 'tokenHash', 'token_hash', 'attemptId',
        'sourceQuestionIndex', 'sourceOptionIndex', 'databasePath', 'dataPath',
        'result_json', 'config_json'
      ]) {
        expect(body).not.toContain(banned);
      }
      // ...while the authorized review material IS present.
      expect(body).toContain('correctOptionIds');
      expect(body).toContain('explanation');
    }
  });

  test('the certificate panel renders from sanitized history', async ({ page }) => {
    await completeInterview(page);

    // The count is 0 here BY DESIGN: only interviews completed on or after the
    // curriculum-completion date qualify, and a fresh browser has not finished
    // the curriculum, so qualification has not started. What this proves is
    // that the panel still reads sanitized v2 history without breaking.
    // The qualifying sequence itself is covered in
    // interview-certificate.service.spec.ts, where storage can be seeded.
    const panel = page.locator('app-interview-certificate-status');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(/Interviews completed:\s*\d+\s*\/\s*5/);
    await expect(panel).toContainText('Angular Explorer');
  });

  test('a submitted session cannot be reopened as an active assessment', async ({ page }) => {
    await completeInterview(page);
    const sessionId = new URL(page.url()).pathname.split('/').pop()!;

    await page.goto(`/interview/session/${sessionId}`);
    // The guard sees a submitted session and routes to its results.
    await expect(page).toHaveURL(RESULTS_URL);
  });
});
