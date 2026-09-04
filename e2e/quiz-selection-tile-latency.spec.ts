import { test, expect } from '@playwright/test';

/**
 * THE REGRESSION: Topic Quiz tiles stayed empty for however long the cold
 * Render-free-tier backend took to answer `GET /api/quizzes` (measured
 * ~12.4s TTFB cold vs ~0.2-0.4s warm) — up to 10-15s of a blank grid while
 * the static Interview tile (no network dependency) appeared instantly.
 *
 * `QuizSelectionComponent.quizzes` is a pure `computed()` over
 * `TopicQuizMetadataService`'s per-field signals, which stayed empty maps
 * until `load()`'s response landed — there was nothing to render a tile
 * FROM in the meantime.
 *
 * Fixed by seeding those signals synchronously, on service construction,
 * from `QUIZ_CATALOG_METADATA` — a bundled, SAFE, metadata-only snapshot
 * (quizId/title/summary/image/difficulty/facts/questionCount ONLY — no
 * question text, options, correctness, or explanations; see the file's own
 * doc comment). `load()`'s response still OVERWRITES every field the moment
 * it lands, so the bundled data is a first-paint placeholder only, never an
 * authority, and actual quiz content stays exclusively backend-driven.
 */
test('Topic Quiz tiles paint alongside the Interview tile even while /api/quizzes is still pending', async ({ page }) => {
  let released: () => void;
  const gate = new Promise<void>((res) => { released = res; });

  await page.route('**/api/quizzes', async (route) => {
    await gate;
    await route.continue();
  });

  const t0 = Date.now();
  await page.goto('/select');

  await page.locator('.interview-tile').first().waitFor({ state: 'visible', timeout: 30000 });
  const tInterview = Date.now() - t0;

  // THE REGRESSION: this used to time out — no topic tile existed to become
  // visible while /api/quizzes was still pending.
  await page.locator('.quiz-tile:not(.interview-tile)').first().waitFor({ state: 'visible', timeout: 5000 });
  const tTopic = Date.now() - t0;

  const gap = tTopic - tInterview;
  console.log('interview tile at', tInterview, 'ms; topic tile at', tTopic, 'ms; gap =', gap, 'ms');
  expect(gap).toBeLessThan(1500);

  // Releasing the held /api/quizzes response must not break anything —
  // the authoritative data replaces the bundled placeholder cleanly.
  released!();
  await page.waitForTimeout(1500);
  const count = await page.locator('.quiz-tile:not(.interview-tile)').count();
  expect(count).toBeGreaterThan(5);
});
