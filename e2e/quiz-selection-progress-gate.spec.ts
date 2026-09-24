import { test, expect, Page, request } from '@playwright/test';
import { SPRING_HEALTH_URL } from './support/e2e-backends';

/**
 * Your Progress visibility gate — the fix for the Custom Interview
 * regression identified in the Export-Interview-Report audit.
 *
 * ROOT DEFECT: `showSelectionProgress` (quiz-selection.component.ts) gated
 * the WHOLE "Your Progress" panel — Performance Insights included — on Topic
 * Quiz session-engagement/access/achievements only. Interview Mode's own
 * entry point on this page (the "Start Building" promo card) is plain
 * navigation and never touches any of those three signals, so a Custom (or
 * preset) Interview completed without ever selecting a Topic Quiz tile left
 * the panel hidden despite the attempt already being durably recorded.
 *
 * THE FIX: one more OR clause reading the EXISTING, already-reactive
 * `InterviewHistoryService.history()` signal. No new storage, no new
 * mechanism — these tests seed/read exactly the `interviewAttemptHistory:v2`
 * shape the app itself writes (see e2e/performance-insights.spec.ts).
 *
 * Case A needs the real Spring Interview backend Playwright starts on :8080
 * (see interview-results-backend.spec.ts for the same precondition and the
 * Custom-Interview completion flow this reproduces locally rather than
 * importing across spec files — Playwright test files are not meant to be
 * import targets of one another).
 */

// What showSelectionProgress() still gates on Quiz Selection. The dashboard no
// longer lives there (it is on /progress), so the gate is asserted through the
// achievements row it continues to control.
const GATED = '.achievements-summary-row';
const PROGRESS_LINK = 'a.progress-entry__link';
const PANEL_DETAILS = '.progress-summary';
const INSIGHTS = 'codelab-performance-insights';
const HISTORY_KEY = 'interviewAttemptHistory:v2';
const RESULTS_URL = /\/interview\/results\/[^/?#]+/;

test.beforeAll(async () => {
  // Case A drives a real Interview through the backend Playwright controls.
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

/** A real, minimal Custom Interview, start to Results. Mirrors completeInterview() in interview-results-backend.spec.ts. */
async function completeCustomInterview(page: Page, count = 10): Promise<void> {
  await page.goto('/interview');
  await page.locator('.chip:has-text("Beginner")').first().click();
  const boxes = page.locator('.topic-check input[type="checkbox"]');
  await expect(boxes.first()).toBeVisible();
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

const d = (n: number) => new Date(Date.UTC(2026, 8, n, 10)).toISOString();

const CUSTOM_SEED = {
  version: 2,
  attempts: [{
    id: 'att_seed_custom', sessionId: 'is_seed_custom', attemptNumber: 1,
    completedAt: d(1), score: 7, totalQuestions: 10, percentage: 70,
    completionReason: 'submitted', configKind: 'custom', configuredDifficulty: 'beginner',
    selectedTopicIds: ['router'],
    topicPerformance: [{ topicId: 'router', topicName: 'Angular Router', correct: 7, total: 10, percentage: 70 }]
  }]
};

const PRESET_SEED = {
  version: 2,
  attempts: [{
    id: 'att_seed_preset', sessionId: 'is_seed_preset', attemptNumber: 1,
    completedAt: d(2), score: 9, totalQuestions: 10, percentage: 90,
    completionReason: 'submitted', configKind: 'preset', presetId: 'junior', presetName: 'Junior Angular Developer',
    selectedTopicIds: ['router', 'forms'],
    topicPerformance: [
      { topicId: 'router', topicName: 'Angular Router', correct: 4, total: 5, percentage: 80 },
      { topicId: 'forms', topicName: 'Angular Forms', correct: 5, total: 5, percentage: 100 }
    ]
  }]
};

async function seed(page: Page, store: object): Promise<void> {
  await page.addInitScript((s) => localStorage.setItem('interviewAttemptHistory:v2', JSON.stringify(s)), store);
}

test.describe('Your Progress visibility — Interview history alone is sufficient', () => {

  test('Case A — real Custom Interview, no Topic Quiz touched: Your Progress becomes visible and shows the attempt', async ({ page }) => {
    test.setTimeout(120_000);

    // Guard the premise: a genuinely fresh browser — nothing stored yet.
    await page.goto('/quiz');
    const preState = await page.evaluate(() => ({
      interview: localStorage.getItem('interviewAttemptHistory:v2'),
      bestScores: localStorage.getItem('quizBestScores'),
      started: sessionStorage.getItem('startedQuizIds'),
      completed: sessionStorage.getItem('completedQuizIds')
    }));
    expect(Object.values(preState).every((v) => v === null)).toBe(true);
    // No Topic Quiz tile is ever touched anywhere in this test.
    await expect(page.locator(GATED)).toHaveCount(0);
    // ...but the entry point is always there, even for a user with nothing.
    await expect(page.locator(PROGRESS_LINK)).toBeVisible();

    await completeCustomInterview(page);

    // Interview history is recorded on Results load, independent of Quiz Selection.
    const stored = await page.evaluate((k) => localStorage.getItem(k), HISTORY_KEY);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!).attempts).toHaveLength(1);

    // Navigate back to Quiz Selection the way a real user does — never via a Topic Quiz tile.
    await page.locator('.ir-btn:has-text("Return to Quiz Selection")').click();
    await page.locator('.quiz-tile').first().waitFor({ state: 'visible', timeout: 20_000 });

    await expect(page.locator(GATED)).toBeVisible();
    // Confirm no Topic Quiz was ever completed — the gate is NOT open because of one.
    await expect(page.locator('.quiz-tile.completed')).toHaveCount(0);

    await page.locator(PROGRESS_LINK).click();
    await expect(page).toHaveURL(/\/progress$/);
    await expect(page.locator(PANEL_DETAILS)).toBeVisible();

    const insights = page.locator(INSIGHTS);
    await expect(insights).toContainText('Interview Mode');
    await expect(insights).toContainText(/\d+ \/ 10 questions · 1 attempt/);
    await expect(insights).not.toContainText('Topic Quiz');
    await expect(insights).not.toContainText('Weak Areas Practice');
  });

  test('Case B — persisted Interview history + a fresh page load: Your Progress is visible immediately, and survives a real reload', async ({ page }) => {
    await seed(page, CUSTOM_SEED);
    await page.goto('/quiz');
    await page.locator('.quiz-tile').first().waitFor({ state: 'visible', timeout: 20_000 });

    // No engagement of any kind: no tile click, no sessionStorage, no achievement.
    const gateState = await page.evaluate(() => ({
      started: sessionStorage.getItem('startedQuizIds'),
      completed: sessionStorage.getItem('completedQuizIds'),
      achievements: localStorage.getItem('quizAchievements')
    }));
    expect(Object.values(gateState).every((v) => v === null)).toBe(true);

    await expect(page.locator(GATED)).toBeVisible();
    await page.locator(PROGRESS_LINK).click();
    await expect(page.locator(INSIGHTS)).toContainText('Interview Mode');
    await expect(page.locator(INSIGHTS)).toContainText('70%');
    await expect(page.locator(INSIGHTS)).toContainText('7 / 10 questions · 1 attempt');

    // A REAL reload — not SPA navigation — proves this is durable storage, not
    // the in-memory SessionEngagementService the audit explicitly excluded as the fix.
    await page.reload();
    await expect(page.locator(INSIGHTS)).toContainText('Interview Mode');
    await page.goto('/quiz');
    await page.locator('.quiz-tile').first().waitFor({ state: 'visible', timeout: 20_000 });
    await expect(page.locator(GATED)).toBeVisible();
  });

  test('Case C — a preset Interview attempt satisfies the same visibility contract as a custom one', async ({ page }) => {
    await seed(page, PRESET_SEED);
    await page.goto('/quiz');
    await page.locator('.quiz-tile').first().waitFor({ state: 'visible', timeout: 20_000 });

    await expect(page.locator(GATED)).toBeVisible();
    await page.locator(PROGRESS_LINK).click();
    await expect(page.locator(INSIGHTS)).toContainText('Interview Mode');
    await expect(page.locator(INSIGHTS)).toContainText('90%');
    await expect(page.locator(INSIGHTS)).toContainText('9 / 10 questions · 1 attempt');
  });

  test('with no Interview history and no other engagement, Your Progress stays hidden (unchanged baseline)', async ({ page }) => {
    await page.goto('/quiz');
    await page.locator('.quiz-tile').first().waitFor({ state: 'visible', timeout: 20_000 });
    await expect(page.locator(GATED)).toHaveCount(0);
    // The dashboard is never embedded on Quiz Selection any more.
    await expect(page.locator('codelab-progress-summary, mat-expansion-panel')).toHaveCount(0);
  });
});
