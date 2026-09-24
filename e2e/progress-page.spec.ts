import { test, expect, Page } from '@playwright/test';

/**
 * The dedicated /progress page (Your Progress).
 *
 * It is a top-level, UNGUARDED route: a user with no history gets an empty state
 * rather than a redirect, so the URL always works — from a link, a refresh or a
 * deep link. Its content is the existing dashboard (ProgressSummary +
 * PerformanceInsights); nothing here re-tests Insights formulas — that lives in
 * performance-insights.spec.ts. This spec is about the page's states and the
 * navigation in and out of it.
 *
 * Seeds are exactly the shapes the app itself writes (see
 * performance-insights.spec.ts), injected before boot.
 */

const TOPIC_KEY = 'topicPerformanceHistory:v1';
const INTERVIEW_KEY = 'interviewAttemptHistory:v2';
const BEST_KEY = 'quizBestScores';

const EMPTY_COPY = 'Complete a Topic Quiz or an Interview to start building your performance history.';
const SUMMARY = '.progress-summary';
const INSIGHTS = 'codelab-performance-insights';

const TOPIC_STORE = {
  version: 1,
  records: [
    { attemptId: 'quiz:fixture-alpha:1', source: 'topic-quiz', completedAt: '2026-09-03T10:00:00.000Z', topicId: 'fixture-alpha', topicName: 'Alpha Topic', correct: 4, total: 5 }
  ]
};

const INTERVIEW_STORE = {
  version: 2,
  attempts: [{
    id: 'att_seed_1', sessionId: 'is_seed_1', attemptNumber: 1,
    completedAt: '2026-09-06T10:00:00.000Z', score: 7, totalQuestions: 10, percentage: 70,
    completionReason: 'submitted', configKind: 'custom', configuredDifficulty: 'beginner',
    selectedTopicIds: ['fixture-alpha'],
    topicPerformance: [{ topicId: 'fixture-alpha', topicName: 'Alpha Topic', correct: 7, total: 10, percentage: 70 }]
  }]
};

const PRESET_STORE = {
  version: 2,
  attempts: [{
    id: 'att_seed_p', sessionId: 'is_seed_p', attemptNumber: 1,
    completedAt: '2026-09-07T10:00:00.000Z', score: 9, totalQuestions: 10, percentage: 90,
    completionReason: 'submitted', configKind: 'preset', presetId: 'junior', presetName: 'Junior Angular Developer',
    selectedTopicIds: ['fixture-alpha'],
    topicPerformance: [{ topicId: 'fixture-alpha', topicName: 'Alpha Topic', correct: 9, total: 10, percentage: 90 }]
  }]
};

/** Seed BEFORE boot, only when a key is absent, so a reload keeps what the app wrote since. */
async function seed(page: Page, stores: Record<string, unknown>): Promise<void> {
  await page.addInitScript((entries) => {
    for (const [key, value] of Object.entries(entries)) {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(value));
    }
  }, stores);
}

async function openProgress(page: Page): Promise<void> {
  await page.goto('/progress');
  await expect(page.getByRole('heading', { level: 1, name: 'Your Progress' })).toBeVisible({ timeout: 20_000 });
}

const emptyState = (page: Page) => page.locator('.progress-page__empty');
const sourceRow = (page: Page, source: string) => page.locator(`${INSIGHTS} section[aria-labelledby="pi-overview-heading"] li[data-source="${source}"]`);

test.describe('Your Progress page — states', () => {
  test('a brand-new user gets the empty state with real links, and the page writes nothing', async ({ page }) => {
    await openProgress(page);

    await expect(emptyState(page)).toBeVisible();
    await expect(emptyState(page)).toHaveAttribute('role', 'status');
    await expect(emptyState(page)).toContainText(EMPTY_COPY);
    await expect(page.locator(SUMMARY)).toHaveCount(0);
    await expect(page.locator(INSIGHTS)).toHaveCount(0);

    // Real anchors, not click handlers.
    await expect(page.getByRole('link', { name: 'Choose a Quiz' })).toHaveAttribute('href', /\/quiz$/);
    await expect(page.getByRole('link', { name: 'Start an Interview' })).toHaveAttribute('href', /\/interview$/);

    // Viewing the page must not fabricate history, engagement or a session.
    const stored = await page.evaluate(() => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage)
    }));
    expect(stored.local.filter((k) => /topicPerformance|interviewAttempt|quizBestScores|quizAchievements/.test(k))).toEqual([]);
    expect(stored.session.filter((k) => /startedQuizIds|completedQuizIds|interview.*session|practice/i.test(k))).toEqual([]);
  });

  test('Topic Quiz history alone: dashboard shows Topic Quiz only, no empty state', async ({ page }) => {
    await seed(page, { [TOPIC_KEY]: TOPIC_STORE });
    await openProgress(page);

    await expect(emptyState(page)).toHaveCount(0);
    await expect(page.locator(SUMMARY)).toBeVisible();
    await expect(sourceRow(page, 'topic-quiz')).toContainText('4 / 5 questions · 1 attempt');
    await expect(sourceRow(page, 'interview')).toHaveCount(0);
    await expect(sourceRow(page, 'weak-areas-practice')).toHaveCount(0);
  });

  test('custom Interview history alone is enough — and is not a new user', async ({ page }) => {
    await seed(page, { [INTERVIEW_KEY]: INTERVIEW_STORE });
    await openProgress(page);

    await expect(emptyState(page)).toHaveCount(0);
    await expect(sourceRow(page, 'interview')).toContainText('7 / 10 questions · 1 attempt');
    await expect(sourceRow(page, 'topic-quiz')).toHaveCount(0);
  });

  test('preset Interview history alone is enough', async ({ page }) => {
    await seed(page, { [INTERVIEW_KEY]: PRESET_STORE });
    await openProgress(page);

    await expect(emptyState(page)).toHaveCount(0);
    await expect(sourceRow(page, 'interview')).toContainText('9 / 10 questions · 1 attempt');
  });

  test('mixed history shows each source separately', async ({ page }) => {
    await seed(page, { [TOPIC_KEY]: TOPIC_STORE, [INTERVIEW_KEY]: INTERVIEW_STORE });
    await openProgress(page);

    await expect(emptyState(page)).toHaveCount(0);
    await expect(sourceRow(page, 'topic-quiz')).toBeVisible();
    await expect(sourceRow(page, 'interview')).toBeVisible();
  });

  test('legacy user with only a best score is NOT treated as new', async ({ page }) => {
    await seed(page, { [BEST_KEY]: { 'fixture-widgets': 80 } });
    await openProgress(page);

    await expect(emptyState(page)).toHaveCount(0);
    await expect(page.locator(SUMMARY)).toBeVisible();
    await expect(page.locator(SUMMARY)).toContainText('Overall Progress');
    // Best scores are not Insights history, so Insights says so rather than inventing rows.
    await expect(page.locator(INSIGHTS)).toContainText('Complete quizzes or interviews to build your performance history.');
  });
});

test.describe('Your Progress page — navigation', () => {
  test('Choose a Quiz and Start an Interview go where they say', async ({ page }) => {
    await openProgress(page);
    await page.getByRole('link', { name: 'Choose a Quiz' }).click();
    await expect(page).toHaveURL(/\/quiz$/);
    await page.locator('.quiz-tile').first().waitFor({ state: 'visible', timeout: 20_000 });

    await page.locator('a.progress-entry__link').click();
    await expect(page).toHaveURL(/\/progress$/);
    await page.getByRole('link', { name: 'Start an Interview' }).click();
    await expect(page).toHaveURL(/\/interview$/);
  });

  test('View interview history links to Interview History', async ({ page }) => {
    await seed(page, { [INTERVIEW_KEY]: INTERVIEW_STORE });
    await openProgress(page);
    await page.locator(INSIGHTS).getByRole('link', { name: 'View interview history' }).click();
    await expect(page).toHaveURL(/\/interview\/history$/);
  });

  test('Quiz Selection offers View Your Progress to a brand-new user, and following it changes nothing stored', async ({ page }) => {
    await page.goto('/quiz');
    await page.locator('.quiz-tile').first().waitFor({ state: 'visible', timeout: 20_000 });
    // Nothing but the entry point — no "X of N completed" or embedded dashboard.
    await expect(page.locator('a.progress-entry__link')).toBeVisible();
    await expect(page.locator('body')).not.toContainText(/\d+ of \d+ completed/);

    const before = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage } }));
    await page.locator('a.progress-entry__link').click();
    await expect(page).toHaveURL(/\/progress$/);
    await expect(emptyState(page)).toBeVisible();
    const after = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage } }));
    expect(after).toBe(before);
  });

  test('a direct load, a refresh and browser Back all work on /progress', async ({ page }) => {
    await seed(page, { [TOPIC_KEY]: TOPIC_STORE });
    await openProgress(page);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Your Progress' })).toBeVisible({ timeout: 20_000 });
    await expect(sourceRow(page, 'topic-quiz')).toBeVisible();

    await page.getByRole('link', { name: 'Choose a Quiz' }).click();
    await expect(page).toHaveURL(/\/quiz$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/progress$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Your Progress' })).toBeVisible();
  });
});

test.describe('Your Progress page — focus and structure', () => {
  test('moves focus to the heading on entry, and leaving the page still works', async ({ page }) => {
    await page.goto('/quiz');
    await page.locator('.quiz-tile').first().waitFor({ state: 'visible', timeout: 20_000 });

    await page.locator('a.progress-entry__link').click();
    await expect(page).toHaveURL(/\/progress$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Your Progress' })).toBeFocused();

    await page.getByRole('link', { name: 'Choose a Quiz' }).click();
    await expect(page).toHaveURL(/\/quiz$/);
  });

  test('heading hierarchy is h1 → h2 → h3 with no skipped level and one h1', async ({ page }) => {
    await seed(page, { [TOPIC_KEY]: TOPIC_STORE, [INTERVIEW_KEY]: INTERVIEW_STORE });
    await openProgress(page);
    await expect(page.locator(INSIGHTS)).toBeVisible();

    const levels = await page.locator('h1, h2, h3, h4, h5, h6').evaluateAll(
      (hs) => hs.map((h) => Number(h.tagName[1]))
    );
    expect(levels.filter((l) => l === 1)).toHaveLength(1);
    expect(levels[0]).toBe(1);
    levels.forEach((l, i) => { if (i > 0) expect(l).toBeLessThanOrEqual(levels[i - 1] + 1); });
    await expect(page.getByRole('heading', { level: 2, name: 'Performance Insights' })).toBeVisible();
  });

  test('keyboard: the page links are reachable by Tab and activate with Enter', async ({ page }) => {
    await openProgress(page);
    const choose = page.getByRole('link', { name: 'Choose a Quiz' });
    for (let i = 0; i < 12 && !(await choose.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press('Tab');
    }
    await expect(choose).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/quiz$/);
  });
});

test.describe('Your Progress page — layout', () => {
  test('phone width: no horizontal page scroll and the dashboard is usable', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await seed(page, { [TOPIC_KEY]: TOPIC_STORE, [INTERVIEW_KEY]: INTERVIEW_STORE });
    await openProgress(page);
    await expect(sourceRow(page, 'interview')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`${theme} theme: the heading and empty-state copy are legible`, async ({ page }) => {
      await openProgress(page);
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      // The app animates theme colours; measure the settled state, not mid-transition.
      await page.waitForTimeout(1000);

      const ratio = await page.evaluate(() => {
        const lum = (rgb: string): number => {
          const m = rgb.match(/[\d.]+/g)!.map(Number);
          const [r, g, b] = m.slice(0, 3).map((v) => {
            const c = v / 255;
            return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const bgOf = (el: Element | null): string => {
          for (let n: Element | null = el; n; n = n.parentElement) {
            const bg = getComputedStyle(n).backgroundColor;
            if (bg && !/rgba?\(0, 0, 0, 0\)|transparent/.test(bg)) return bg;
          }
          return 'rgb(255, 255, 255)';
        };
        return ['.progress-page__title', '.progress-page__empty'].map((sel) => {
          const el = document.querySelector(sel);
          const fg = lum(getComputedStyle(el!).color);
          const bg = lum(bgOf(el));
          return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
        });
      });
      for (const r of ratio) expect(r).toBeGreaterThanOrEqual(4.5);
    });
  }
});
