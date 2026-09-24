import { test, expect, Page } from '@playwright/test';

/**
 * Performance Insights — smoke test through the real UI.
 *
 * Reads only what the app already stores. Nothing here invents a storage format:
 * the two seeds are exactly the shapes TopicPerformanceHistoryService
 * (`topicPerformanceHistory:v1`) and InterviewHistoryService
 * (`interviewAttemptHistory:v2`) write themselves, so this also proves the
 * stores are still readable by the feature. No answer data is seeded — the
 * stores hold raw counts only.
 *
 * The dashboard lives on its own unguarded /progress route, so it is reached by
 * navigating to it: there is no engagement gate or accordion to open first.
 *
 * Assertions are about content and structure — sources, counts, labels — never
 * pixels, fonts or CSS.
 */

const PANEL_DETAILS = '.progress-summary';
const INSIGHTS = 'codelab-performance-insights';

const TOPIC_KEY = 'topicPerformanceHistory:v1';
const INTERVIEW_KEY = 'interviewAttemptHistory:v2';

const record = (
  attemptId: string,
  source: 'topic-quiz' | 'weak-areas-practice',
  completedAt: string,
  topicId: string,
  topicName: string,
  correct: number,
  total: number
) => ({ attemptId, source, completedAt, topicId, topicName, correct, total });

/**
 * Topic Quiz   4 attempts: previous 2 = 4/20 (20%), recent 2 = 19/20 (95%)  → +75 pts, 23/40 = 57%
 *              (23/40 is exactly 57.5, but the app's Math.round((c / t) * 100) yields 57.49999…, so it
 *              shows 57 — the SAME convention the Interview scoring uses, deliberately not changed)
 * Practice     1 attempt : 1/3 (33%)
 * Interview    1 attempt : 7/10 (70%), so no comparison is possible
 *
 * Topics across every source:
 *   Alpha  19/20 (quiz) + 4/5 (interview)            = 23/25 = 92%  → Strongest
 *   Beta   4/20 (quiz) + 1/3 (practice) + 3/5 (int.) =  8/28 = 29%  → Needs Review
 */
const TOPIC_STORE = {
  version: 1,
  records: [
    record('quiz:fixture-beta:1', 'topic-quiz', '2026-09-01T10:00:00.000Z', 'fixture-beta', 'Beta Topic', 1, 10),
    record('quiz:fixture-beta:2', 'topic-quiz', '2026-09-02T10:00:00.000Z', 'fixture-beta', 'Beta Topic', 3, 10),
    record('quiz:fixture-alpha:3', 'topic-quiz', '2026-09-03T10:00:00.000Z', 'fixture-alpha', 'Alpha Topic', 9, 10),
    record('quiz:fixture-alpha:4', 'topic-quiz', '2026-09-04T10:00:00.000Z', 'fixture-alpha', 'Alpha Topic', 10, 10),
    record('practice:seed-1', 'weak-areas-practice', '2026-09-05T10:00:00.000Z', 'fixture-beta', 'Beta Topic', 1, 3)
  ]
};

const INTERVIEW_STORE = {
  version: 2,
  attempts: [
    {
      id: 'att_seed_1',
      sessionId: 'is_seed_1',
      attemptNumber: 1,
      completedAt: '2026-09-06T10:00:00.000Z',
      score: 7,
      totalQuestions: 10,
      percentage: 70,
      completionReason: 'submitted',
      selectedTopicIds: ['fixture-alpha', 'fixture-beta'],
      topicPerformance: [
        { topicId: 'fixture-alpha', topicName: 'Alpha Topic', correct: 4, total: 5, percentage: 80 },
        { topicId: 'fixture-beta', topicName: 'Beta Topic', correct: 3, total: 5, percentage: 60 }
      ]
    }
  ]
};

/**
 * Seed BEFORE the app boots, only when the key is absent, so a reload keeps
 * whatever the app has since written rather than resetting it.
 */
async function seed(page: Page, stores: { topic?: object; interview?: object }): Promise<void> {
  await page.addInitScript(
    ({ topic, interview, topicKey, interviewKey }) => {
      if (topic && localStorage.getItem(topicKey) === null) {
        localStorage.setItem(topicKey, JSON.stringify(topic));
      }
      if (interview && localStorage.getItem(interviewKey) === null) {
        localStorage.setItem(interviewKey, JSON.stringify(interview));
      }
    },
    { topic: stores.topic, interview: stores.interview, topicKey: TOPIC_KEY, interviewKey: INTERVIEW_KEY }
  );
}

/** Open the dedicated Your Progress page directly (a real, unguarded route). */
async function openYourProgress(page: Page): Promise<void> {
  await page.goto('/progress');
  await expect(page.getByRole('heading', { level: 1, name: 'Your Progress' })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(PANEL_DETAILS)).toBeVisible();
}

const overviewRow = (page: Page, source: string) =>
  page.locator(`section[aria-labelledby="pi-overview-heading"] li[data-source="${source}"]`);
const recentRow = (page: Page, source: string) =>
  page.locator(`section[aria-labelledby="pi-recent-heading"] li[data-source="${source}"]`);
const topicsIn = (page: Page, headingId: string): Promise<string[]> =>
  page
    .locator(`section[aria-labelledby="${headingId}"] li[data-topic]`)
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset['topic'] ?? ''));

test('performance insights: separate sources, transparent comparison, and Strongest never overlaps Needs Review', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await seed(page, { topic: TOPIC_STORE, interview: INTERVIEW_STORE });
  await openYourProgress(page);

  const insights = page.locator(INSIGHTS);
  await expect(insights).toBeVisible();
  await expect(insights.getByRole('heading', { level: 2, name: 'Performance Insights' })).toBeVisible();

  // ── the existing Your Progress content is still there, unchanged ──────
  await expect(page.locator(PANEL_DETAILS)).toContainText('Overall Progress');
  await expect(page.locator(PANEL_DETAILS)).toContainText('Needs Review');

  // ── three sources, kept SEPARATE, each with its sample size ───────────
  await expect(overviewRow(page, 'topic-quiz')).toContainText('Topic Quiz');
  await expect(overviewRow(page, 'topic-quiz')).toContainText('57%');
  await expect(overviewRow(page, 'topic-quiz')).toContainText('23 / 40 questions · 4 attempts');

  await expect(overviewRow(page, 'interview')).toContainText('Interview Mode');
  await expect(overviewRow(page, 'interview')).toContainText('70%');
  await expect(overviewRow(page, 'interview')).toContainText('7 / 10 questions · 1 attempt');

  await expect(overviewRow(page, 'weak-areas-practice')).toContainText('Weak Areas Practice');
  await expect(overviewRow(page, 'weak-areas-practice')).toContainText('33%');
  await expect(overviewRow(page, 'weak-areas-practice')).toContainText('1 / 3 questions · 1 attempt');

  // No blended figure. Blending all three would give 31/53 = 58%, which must appear nowhere.
  await expect(insights).not.toContainText('58%');
  await expect(insights).not.toContainText(/overall accuracy|combined|skill/i);

  // ── recent vs previous: plain arithmetic, and an honest "not enough" ──
  await expect(recentRow(page, 'topic-quiz')).toContainText('+75 pts');
  await expect(recentRow(page, 'topic-quiz')).toContainText('Recent 95% · Previous 20%');
  await expect(recentRow(page, 'interview')).toContainText('Not enough history for a comparison yet.');
  await expect(recentRow(page, 'interview')).not.toContainText('pts');
  // One practice attempt is not a comparison, so Practice has no row here at all.
  await expect(recentRow(page, 'weak-areas-practice')).toHaveCount(0);
  await expect(page.locator('section[aria-labelledby="pi-recent-heading"]'))
    .not.toContainText(/improv|declin|better|worse/i);

  // ── topics, from the SAME data Weak Areas judges ──────────────────────
  const alpha = page.locator('section[aria-labelledby="pi-topics-heading"] li[data-topic="fixture-alpha"]');
  await expect(alpha).toContainText('Alpha Topic');
  await expect(alpha).toContainText('92%');
  await expect(alpha).toContainText('23 / 25 questions');

  const beta = page.locator('section[aria-labelledby="pi-topics-heading"] li[data-topic="fixture-beta"]');
  await expect(beta).toContainText('29%');
  await expect(beta).toContainText('8 / 28 questions');

  // ── Strongest and Needs Review are disjoint ───────────────────────────
  const strongest = await topicsIn(page, 'pi-strongest-heading');
  const needsReview = await topicsIn(page, 'pi-review-heading');
  expect(strongest).toEqual(['fixture-alpha']);
  expect(needsReview).toEqual(['fixture-beta']);
  expect(strongest.filter((id) => needsReview.includes(id))).toEqual([]);

  // ── links to the existing Interview History, and discloses the window ─
  await expect(insights.getByRole('link', { name: 'View interview history' }))
    .toHaveAttribute('href', '/interview/history');
  await expect(insights.locator('.pi__note')).toContainText('Older results are not included.');
  await expect(insights.locator('.pi__note')).not.toContainText(/lifetime|all.?time/i);

  // ── it stores nothing of its own ──────────────────────────────────────
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys.filter((k) => /insight|performanceInsights/i.test(k))).toEqual([]);

  expect(pageErrors).toEqual([]);
});

test('performance insights: a legacy best-score-only user sees the neutral Insights empty state', async ({ page }) => {
  // A best score is progress (the summary shows) but is NOT Insights history, so
  // the dashboard renders and Insights explains it has nothing yet.
  await page.addInitScript(() => localStorage.setItem('quizBestScores', JSON.stringify({ 'fixture-widgets': 80 })));
  await openYourProgress(page);
  await expect(page.locator(INSIGHTS)).toContainText(
    'Complete quizzes or interviews to build your performance history.'
  );
  await expect(page.locator(`${INSIGHTS} li[data-source]`)).toHaveCount(0);
});

test('performance insights: Topic Quiz history alone shows no Interview or Practice rows', async ({ page }) => {
  await seed(page, {
    topic: {
      version: 1,
      records: [record('quiz:fixture-alpha:1', 'topic-quiz', '2026-09-03T10:00:00.000Z', 'fixture-alpha', 'Alpha Topic', 4, 5)]
    }
  });
  await openYourProgress(page);

  await expect(overviewRow(page, 'topic-quiz')).toContainText('4 / 5 questions · 1 attempt');
  await expect(overviewRow(page, 'interview')).toHaveCount(0);
  await expect(overviewRow(page, 'weak-areas-practice')).toHaveCount(0);
  await expect(page.locator(INSIGHTS)).not.toContainText('Interview Mode');
  await expect(page.locator(INSIGHTS).getByRole('link', { name: 'View interview history' })).toHaveCount(0);
  // One attempt: the sample is shown, the comparison is honestly unavailable.
  await expect(recentRow(page, 'topic-quiz')).toContainText('Not enough history for a comparison yet.');
});

test('performance insights: is present and usable at a phone-sized viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page, { topic: TOPIC_STORE, interview: INTERVIEW_STORE });
  await openYourProgress(page);

  const insights = page.locator(INSIGHTS);
  await expect(insights).toBeVisible();
  await expect(overviewRow(page, 'topic-quiz')).toBeVisible();
  await expect(overviewRow(page, 'interview')).toBeVisible();
  await expect(recentRow(page, 'topic-quiz')).toBeVisible();
  await expect(insights.getByRole('link', { name: 'View interview history' })).toBeVisible();
  await expect(insights.locator('.pi__note')).toBeVisible();
});
