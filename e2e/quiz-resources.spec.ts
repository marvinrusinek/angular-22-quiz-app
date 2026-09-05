import { test, expect } from '@playwright/test';
import { HEADING, NEXT_BTN, RESULTS_BTN, correctIndicesForHeading, diQuiz } from './helpers';

/**
 * The Results-page "Brush up your knowledge" panel, end to end.
 *
 * These links used to come from the `resources` block of the Angular client
 * asset `assets/data/quiz.json`. They now come from
 * `GET /api/quizzes/:quizId/resources`, served from PostgreSQL — which is
 * what let that asset actually be deleted (Angular Stage 14, S6p).
 *
 * Run against the e2e database, which Stage 15 seeds from a deterministic
 * SYNTHETIC bank (backend/test/helpers/synthetic-quiz-bank.json, the same
 * fixture the backend's own unit tests use) rather than any real quiz
 * content — that fixture is the actual ground truth for what the running
 * app serves during E2E.
 *
 * `fixture-gadgets` is used because it is the one quiz the fixture's
 * top-level `resources` block assigns links to, and it already has helpers
 * in this suite.
 */

const QUIZ = 'fixture-gadgets';

/** Resources the seeded bank holds for this quiz, in source order. */
const EXPECTED: readonly { title: string; url: string }[] =
  (JSON.parse(
    require('node:fs').readFileSync('backend/test/helpers/synthetic-quiz-bank.json', 'utf8')
  ).resources ?? [])
    .find((entry: { quizId: string }) => entry.quizId === QUIZ)
    ?.resources ?? [];

test('the Results resources panel is served by the API, not the local asset', async ({ page }) => {
  expect(EXPECTED.length).toBeGreaterThan(0);

  // Record what the page asks for, so the assertions below are about the
  // SOURCE and not merely about the rendered text.
  const resourceCalls: string[] = [];
  const localAssetCalls: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/resources')) resourceCalls.push(url);
    if (url.includes('assets/data/quiz.json')) localAssetCalls.push(url);
  });

  await page.goto(`/quiz/question/${QUIZ}/1`);
  const rows = page.locator('.option-row');
  await rows.first().waitFor({ state: 'visible', timeout: 30_000 });

  // Play the quiz through, answering correctly, to reach the Results page.
  const total = diQuiz.questions.length;
  for (let i = 0; i < total; i++) {
    await rows.first().waitFor({ state: 'visible' });
    const heading = (await page.locator(HEADING).first().textContent()) ?? '';
    for (const correct of correctIndicesForHeading(diQuiz, heading)) {
      await rows.nth(correct).click();
    }
    if (i < total - 1) {
      await page.locator(NEXT_BTN).click();
      await expect(page).toHaveURL(new RegExp(`/${i + 2}$`));
    }
  }

  await page.locator(RESULTS_BTN).click();
  await expect(page).toHaveURL(/\/results\//);

  // From here on, watch the RESOURCES window specifically.
  //
  // S6p: the app no longer fetches `assets/data/quiz.json` at ALL — the
  // bootstrap fetch was removed and the asset itself deleted — so
  // localAssetCalls staying empty for the whole run is no longer even a
  // narrow claim about this one panel. The reset below is kept anyway so
  // this assertion still reads as "rendering THIS panel reads the API and
  // does not read the (now nonexistent) asset" on its own, without relying
  // on a fact about the rest of the run.
  resourceCalls.length = 0;
  localAssetCalls.length = 0;

  // The Results page is sectioned, and the section nav lives inside the
  // hamburger dropdown — it is not rendered at all until the menu is opened
  // (`@if (menuOpen())`). Open it, then pick the Resources section.
  //
  // The score section ALSO renders this panel, but only for a sub-60% score,
  // where it is the "go read something" prompt. This section shows it
  // unconditionally, which is the stable place to assert.
  await page.locator('.hamburger-btn').click();
  await page.locator('.nav-dropdown').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Resources' }).click();

  // The panel itself starts collapsed.
  const header = page.locator('.resources-header').first();
  await header.waitFor({ state: 'visible', timeout: 20_000 });
  await header.click();

  const items = page.locator('.resources-section li');
  await expect(items).toHaveCount(EXPECTED.length);

  // Same links, in the same order the source lists them.
  for (const [i, resource] of EXPECTED.entries()) {
    await expect(items.nth(i).locator('.resource-title')).toHaveText(resource.title);
    await expect(items.nth(i).locator('a')).toHaveAttribute('href', resource.url);
  }

  // THE SOURCE. The API was asked for these links...
  expect(resourceCalls.some((url) => url.includes(`/quizzes/${QUIZ}/resources`))).toBe(true);

  // ...and rendering the panel read no local asset at all.
  expect(localAssetCalls).toEqual([]);
});
