import { test, expect, Page } from '@playwright/test';
import { HEADING, NEXT_BTN, RESULTS_BTN, tsQuiz, correctIndexForHeading, correctRowsForHeading } from './helpers';

const PANEL = 'mat-expansion-panel';
const PANEL_HEADER = 'mat-expansion-panel-header';
const PANEL_DETAILS = '.progress-summary';
const TS_TILE = '.quiz-tile:has(h5.quiz-title:text-is("Fixture Widgets"))';
const BEST_SCORES_KEY = 'quizBestScores';

/**
 * These two things are DELIBERATELY different and are asserted separately:
 *
 *  1. PERSISTED PROGRESS DATA — `BestScoreService` → localStorage `quizBestScores`
 *     (`Record<quizId, number 0-100>`; key presence means "completed"). Durable:
 *     survives reloads, and a lower retake never lowers it.
 *
 *  2. PANEL VISIBILITY — the "Your Progress" panel and the per-card score line
 *     sit behind `@if (showSelectionProgress())`, which is an OR of three
 *     sources (quiz-selection.component.ts:102):
 *
 *         sessionEngagement.engaged()   in-memory — lost on any reload
 *       || hasAccessedQuizzes()         sessionStorage (startedQuizIds /
 *                                       completedQuizIds) — survives a RELOAD
 *                                       in the SAME TAB, but not a new tab or a
 *                                       restarted browser
 *       || achievementsEarned() > 0     localStorage — survives everything,
 *                                       including a new browser session
 *
 *     Only the FIRST is per-page-load. Once the user has real progress the panel
 *     is retained across a refresh BY DESIGN, so the achievements header and
 *     per-tile progress don't vanish on a returning user. A brand-new user with
 *     no progress at all still gets a clean, progress-free screen.
 *
 *     Playwright gives each test a fresh context, so every test here starts as
 *     that brand-new user — both stores begin empty.
 *
 * Consequence for this spec: it enters through Quiz Selection and clicks the
 * tile (deep-linking to a question URL never sets the in-memory flag), and after
 * a refresh it expects the panel to REMAIN — this run has completed a quiz, so
 * the durable sources hold. The session-only half of the gate is asserted
 * separately below, with a user who has no stored progress.
 */

/** The durable record — read directly, so it is independent of panel visibility. */
async function storedBestScores(page: Page): Promise<Record<string, number>> {
  return page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? '{}'),
    BEST_SCORES_KEY
  );
}

/**
 * Enter the way a real user does: Quiz Selection → Fixture Widgets tile → Start.
 * The tile click is what calls `onSelect()` → `markEngaged()`.
 */
async function engageViaTileAndStart(page: Page): Promise<void> {
  await page.goto('/quiz');
  await page.locator(TS_TILE).waitFor({ state: 'visible', timeout: 20_000 });
  await page.locator(TS_TILE).click();
  await expect(page).toHaveURL(/\/quiz\/intro\/fixture-widgets/);
  await page.locator('.start-btn').click();
  await expect(page).toHaveURL(/\/question\/fixture-widgets\/1$/);
}

/** Return to Quiz Selection through the app (router navigation, not a reload). */
async function backToSelection(page: Page): Promise<void> {
  await page.getByTitle('select quiz').click();
  await page.locator('.quiz-tile').first().waitFor({ state: 'visible', timeout: 20_000 });
}

/** Answer the whole fixture-widgets quiz. `wrongFirst` misses Q1 → 90%. */
async function answerFixtureWidgets(page: Page, wrongFirst = false): Promise<void> {
  const total = tsQuiz.questions.length;
  for (let i = 0; i < total; i++) {
    const rows = page.locator('.option-row');
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    await expect
      .poll(async () => correctIndexForHeading((await page.locator(HEADING).textContent()) ?? ''),
        { timeout: 8000 })
      .toBeGreaterThanOrEqual(0);

    const heading = (await page.locator(HEADING).textContent()) ?? '';
    const correct = correctIndexForHeading(heading);

    if (wrongFirst && i === 0) {
      await rows.nth(correct === 0 ? 1 : 0).click();
    } else {
      // Multi-answer aware — fixture-widgets has one multi-answer question
      // among otherwise single-answer ones.
      const corrects = await correctRowsForHeading(rows, tsQuiz, heading);
      for (const idx of corrects) {
        await rows.nth(idx).click();
        await page.waitForTimeout(250);
      }
    }

    if (i < total - 1) {
      await page.locator(NEXT_BTN).click();
      await expect(page).toHaveURL(new RegExp(`/${i + 2}$`));
    }
  }
  await page.locator(RESULTS_BTN).click();
  await expect(page).toHaveURL(/\/results\//);
}

test('progress: score persists durably, the panel is retained once progress exists, and a lower retake keeps the best score', async ({ page }) => {
  test.setTimeout(240_000);

  // ── complete the quiz perfectly (100%), entering via the tile so the
  //    session-engagement flag is set the way a real user sets it ───────────
  await engageViaTileAndStart(page);
  await answerFixtureWidgets(page);
  await backToSelection(page);

  // ── panel is visible for an ENGAGED session ─────────────────────────────
  await expect(page.locator(PANEL)).toBeVisible();
  // Catalog-safe: the total is the number of quizzes, which grows over time.
  await expect(page.locator(PANEL_HEADER)).toContainText(/1 of \d+ completed/);
  await expect(page.locator(PANEL_DETAILS)).toBeHidden();  // collapsed by default

  // The percentage is derived from the same total, so derive it here too rather
  // than hard-coding it (1 of 20 → 5%).
  const headerText = (await page.locator(PANEL_HEADER).textContent()) ?? '';
  const totalQuizzes = Number(/1 of (\d+) completed/.exec(headerText)?.[1]);
  expect(totalQuizzes).toBeGreaterThan(0);
  await expect(page.locator(PANEL_HEADER))
    .toContainText(`${Math.round((1 / totalQuizzes) * 100)}%`);

  // Expanding reveals the full bar-graph breakdown (overall + difficulty bars).
  await page.locator(PANEL_HEADER).click();
  await expect(page.locator(PANEL_DETAILS)).toBeVisible();
  await expect(page.locator(PANEL_DETAILS)).toContainText('Overall Progress');
  await expect(page.locator(PANEL_DETAILS)).toContainText('Beginner');
  await expect(page.locator(`${PANEL_DETAILS} .progress-summary__bar[role="progressbar"]`).first()).toBeVisible();

  // The completed card shows Completed + Best 100%.
  const completedTile = page.locator('.quiz-tile.completed');
  await expect(completedTile).toHaveCount(1);
  await expect(completedTile.locator('.quiz-card-progress')).toContainText('Completed');
  await expect(completedTile.locator('.quiz-card-progress')).toContainText('100%');

  // ── the DURABLE record, asserted independently of any UI ────────────────
  expect((await storedBestScores(page))['fixture-widgets']).toBe(100);

  // ── refresh: the in-memory flag resets, but DURABLE progress keeps the panel ──
  await page.reload();
  await page.locator('.quiz-tile').first().waitFor({ state: 'visible', timeout: 20_000 });

  // The panel REMAINS. engaged() is back to false, but this run completed a
  // quiz, so hasAccessedQuizzes() (sessionStorage — intact, same tab) and
  // achievementsEarned() (localStorage) each hold the gate open on their own.
  await expect(page.locator(PANEL)).toBeVisible();
  expect((await storedBestScores(page))['fixture-widgets']).toBe(100);

  // ── navigate away through the app and come back ────────────────────────
  // Where the tile lands depends on state — an untouched quiz opens its intro,
  // an already-completed one opens its results — so accept either.
  await page.locator(TS_TILE).click();
  await expect(page).toHaveURL(/\/quiz\/(intro|results)\/fixture-widgets/);
  await page.goBack();
  await page.locator('.quiz-tile').first().waitFor({ state: 'visible', timeout: 20_000 });

  // Panel still there, showing the SAME saved score.
  await expect(page.locator(PANEL)).toBeVisible();
  await expect(page.locator(PANEL_HEADER)).toContainText(/1 of \d+ completed/);
  await expect(page.locator('.quiz-tile.completed .quiz-card-progress')).toContainText('100%');

  // ── retake with a LOWER score: completed quiz → results → Restart ───────
  await page.locator('.quiz-tile.completed').click();
  await expect(page).toHaveURL(/\/results\//);
  await page.getByTitle('restart').click();
  await expect(page).toHaveURL(/\/question\/fixture-widgets\/1$/);
  await answerFixtureWidgets(page, /* wrongFirst */ true);  // 90%

  // Back to selection: the best score must remain 100%, not the 90% retake —
  // in the UI and in the durable store.
  await backToSelection(page);
  await expect(page.locator('.quiz-tile.completed .quiz-card-progress')).toContainText('100%');
  await expect(page.locator('.quiz-tile.completed .quiz-card-progress')).not.toContainText('90%');
  expect((await storedBestScores(page))['fixture-widgets']).toBe(100);
});

/**
 * The gate from a BRAND-NEW user's starting point.
 *
 * With nothing stored, every source of `showSelectionProgress()` is false, so
 * the screen starts clean. Engaging then opens the gate — and note that the very
 * act of opening a quiz is itself RECORDED (the quiz is added to the
 * sessionStorage accessed list), so from that point on the panel survives a
 * reload of this tab. The "clean start" is the state of a user with no stored
 * progress, not something that returns on every page load.
 */
test('progress: a brand-new user starts clean, and engaging opens the gate durably', async ({ page }) => {
  await page.goto('/quiz');
  await page.locator('.quiz-tile').first().waitFor({ state: 'visible', timeout: 20_000 });

  // Guard the premise: a genuinely fresh user. Each source is read from the
  // store that actually backs it — scores/achievements in localStorage, the
  // accessed list in sessionStorage.
  const stored = await page.evaluate(() => ({
    best: localStorage.getItem('quizBestScores'),
    achievements: localStorage.getItem('quizAchievements'),
    started: sessionStorage.getItem('startedQuizIds'),
    completed: sessionStorage.getItem('completedQuizIds')
  }));
  expect(Object.values(stored).every((v) => v === null || v === '{}' || v === '[]')).toBe(true);

  // Fresh load: no panel.
  await expect(page.locator(PANEL)).toHaveCount(0);

  // Tile click calls onSelect() -> markEngaged(), which opens the gate.
  await page.locator(TS_TILE).click();
  await expect(page).toHaveURL(/\/quiz\/(intro|results)\/fixture-widgets/);
  await page.goBack();   // router navigation, so the in-memory flag survives
  await page.locator('.quiz-tile').first().waitFor({ state: 'visible', timeout: 20_000 });
  await expect(page.locator(PANEL)).toBeVisible();

  // A real reload drops the in-memory flag — but opening the quiz recorded it in
  // the sessionStorage accessed list, which survives a reload of this tab, so
  // hasAccessedQuizzes() now holds the gate open on its own.
  await page.reload();
  await page.locator('.quiz-tile').first().waitFor({ state: 'visible', timeout: 20_000 });
  await expect(page.locator(PANEL)).toBeVisible();

  // Prove it is the STORED progress doing the work, not something incidental.
  // Both stores must go: the accessed list is in sessionStorage, scores and
  // achievements in localStorage. Clearing only one leaves the gate open.
  // Clearing both represents a brand-new user or cleared site data — NOT a new
  // browser session, which would drop sessionStorage but keep localStorage, so
  // achievementsEarned() would still hold the panel open on its own.
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
  await page.locator('.quiz-tile').first().waitFor({ state: 'visible', timeout: 20_000 });
  await expect(page.locator(PANEL)).toHaveCount(0);
});
