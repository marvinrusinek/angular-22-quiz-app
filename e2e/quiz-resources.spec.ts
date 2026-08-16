import { test, expect } from '@playwright/test';
import { HEADING, NEXT_BTN, RESULTS_BTN, correctIndicesForHeading, diQuiz } from './helpers';

/**
 * The Results-page "Brush up your knowledge" panel, end to end.
 *
 * These links used to come from the `resources` block of
 * `assets/data/quiz.json`. They now come from
 * `GET /api/quizzes/:quizId/resources`, served from PostgreSQL — which is what
 * lets that asset be deleted later.
 *
 * Run against the e2e database, which is seeded by the SAME import script the
 * developer database uses, so the links here are the real ones.
 *
 * `dependency-injection` is used because it is one of the eight quizzes that
 * actually has resources and it already has helpers in this suite.
 */

const QUIZ = 'dependency-injection';

/** Resources the seeded bank holds for this quiz, in source order. */
const EXPECTED: readonly { title: string; url: string }[] =
  (JSON.parse(
    require('node:fs').readFileSync('src/assets/data/quiz.json', 'utf8')
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
  // Counting local-asset fetches for the whole run would prove nothing about
  // this panel: the app still fetches `assets/data/quiz.json` many times per
  // run (three separate loaders, re-entered on navigation — S4 collapses them).
  // What S3 has to prove is narrower and is the thing that would break on
  // deletion: rendering THIS panel reads the API and does not read the asset.
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
