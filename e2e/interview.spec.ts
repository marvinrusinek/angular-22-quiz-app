import { test, expect, Page } from '@playwright/test';

/** Results carries the non-secret session id — never a token or a score. */
const RESULTS_URL = /\/interview\/results\/[^/?#]+/;

/**
 * Interview ("Assessment") Mode end-to-end coverage + a topic-quiz regression
 * guard proving Interview Mode leaves the normal quizzes untouched.
 *
 * Each test gets a fresh browser context (clean sessionStorage), so the
 * URL-protection + resume specs are deterministic.
 */

// Configure the builder (Beginner, all topics, given count) and start. Assumes
// the page is already on /interview (possibly with a ?interviewSeconds= hook).
async function configureAndStart(page: Page, count: '10' | '20' | '30' = '10') {
  await page.locator('.chip:has-text("Beginner")').first().click();
  // Use the builder's own Select All rather than ticking each box: choosing a
  // difficulty re-renders the topic list, so a loop over a captured count can
  // click an element that has just been replaced.
  const boxes = page.locator('.topic-check input[type="checkbox"]');
  await expect(boxes.first()).toBeVisible();
  await page.locator('.topics-toolbar button:has-text("Select All")').click();
  await expect(boxes.first()).toBeChecked();
  await page.locator(`.chip--button:has-text("${count}")`).first().click();
  await page.locator('.start-interview-btn').click();
  // The session route carries the backend session id.
  await page.waitForURL(/\/interview\/session\/[^/?#]+/);
  await expect(page.locator('.interview-question-box')).toBeVisible();
}

// Answer every question (first option), advancing with Next, then Submit and
// land on the Results page. Mirrors the hardened main-flow answering loop.
async function answerAllAndSubmit(page: Page, count: number) {
  for (let i = 1; i <= count; i++) {
    const firstOption = page.locator('.io-option').first();
    await firstOption.click();
    await expect(firstOption).toHaveClass(/io-selected/);
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

/**
 * Everything downstream of SUBMIT now reads the FROZEN backend result: the
 * guard loads it through one pipeline, Results renders it, and Review uses the
 * server's own review data. History keeps a sanitized analytics summary only.
 */
test.describe('Interview Mode', () => {
  test('main flow: selection card → build → session → submit → results → review', async ({ page }) => {
    await page.goto('/quiz');
    await page.locator('.interview-tile__cta').click();
    await expect(page).toHaveURL(/\/interview$/);

    await configureAndStart(page, '10');
    await expect(page.locator('.interview-session__title')).toHaveText(/Angular Assessment/);

    // Answer every question, advancing with Next. Click the option LABEL (the
    // visible control) rather than force-checking the hidden input, and confirm
    // the selection registered (io-selected) before advancing — Next is gated on
    // the answer, so this avoids a race with the zoneless change detection.
    for (let i = 1; i <= 10; i++) {
      const firstOption = page.locator('.io-option').first();
      await firstOption.click();
      await expect(firstOption).toHaveClass(/io-selected/);
      if (i < 10) {
        await page.locator('.pg-next').first().click();
        await expect(page.locator('.interview-progress')).toContainText(`Question ${i + 1}`);
      }
    }

    // last question → Submit Assessment (confirm dialog)
    await page.locator('.show-results-btn').click();
    await expect(page.getByText('Submit Assessment?')).toBeVisible();
    await page.locator('button:has-text("Submit Assessment")').last().click();

    await page.waitForURL(RESULTS_URL);
    await expect(page.locator('.interview-results__title')).toHaveText(/Assessment Complete/);
    await expect(page.locator('.score-pct')).toBeVisible();

    // review shows per-question answers + explanations
    await page.locator('button:has-text("Review Answers")').click();
    await expect(page.locator('.rv-item')).toHaveCount(10);
    // All / Incorrect / Correct / Skipped (Flagged is hidden until flagging ships).
    await expect(page.locator('.rv-filter')).toHaveCount(4);
  });

  test('performance trends: first attempt shows the empty state, a second attempt renders the chart', async ({ page }) => {
    // Several full interviews, each answer and submit a round trip to a
    // remote database. The 60s default was sized for local SQLite.
    test.setTimeout(150_000);
    // First completed interview → recorded, but the trend needs ≥ 2 attempts, so
    // Results shows the "first recorded interview" empty state (no chart).
    await page.goto('/interview');
    await configureAndStart(page, '10');
    await answerAllAndSubmit(page, 10);

    await expect(page.locator('.perf-trends__heading')).toHaveText(/Performance Trends/);
    await expect(page.locator('.perf-trends__empty')).toContainText('first recorded interview');
    await expect(page.locator('.perf-chart')).toHaveCount(0);

    // Build another in the SAME context (localStorage history persists) → now two
    // attempts, so the chart + metrics + accessible data list all render.
    await page.locator('button:has-text("Build Another Assessment")').click();
    await expect(page).toHaveURL(/\/interview$/);
    await configureAndStart(page, '10');
    await answerAllAndSubmit(page, 10);

    await expect(page.locator('.perf-chart__svg')).toBeVisible();
    await expect(page.locator('.perf-chart__dot')).toHaveCount(2);
    await expect(page.locator('.perf-chart__dot--latest')).toHaveCount(1);
    await expect(page.locator('.perf-metrics dd')).toHaveCount(4);
    await expect(page.locator('.perf-trends__sr li')).toHaveCount(2);
  });

  test('interview history: results → history list → read-only summary', async ({ page }) => {
    // Several full interviews, each answer and submit a round trip to a
    // remote database. The 60s default was sized for local SQLite.
    test.setTimeout(120_000);
    await page.goto('/interview');
    await configureAndStart(page, '10');
    await answerAllAndSubmit(page, 10);

    // Gateway button beneath Performance Trends.
    await page.locator('a:has-text("View Interview History")').click();
    await expect(page).toHaveURL(/\/interview\/history$/);
    await expect(page.locator('.interview-history__title')).toHaveText(/Interview History/);

    // The just-completed attempt appears as a card with a summary above it.
    await expect(page.locator('.ih-summary dd').first()).toHaveText('1');
    await expect(page.locator('.ih-card')).toHaveCount(1);

    // TWO actions. `Review Answers` is offered only while a durable pointer to
    // the session still exists, because the review is fetched from the backend;
    // `View Summary` is always available because the analytics are local.
    await expect(page.locator('.ih-card__actions a')).toHaveCount(2);
    await expect(page.locator('.ih-card__actions a:has-text("Review Answers")')).toBeVisible();

    // View Summary opens the read-only historical detail (no session restore).
    await page.locator('.ih-card__actions a:has-text("View Summary")').click();
    await expect(page).toHaveURL(/\/interview\/history\/.+/);
    await expect(page.locator('.ihd__readonly')).toContainText('Read Only');

    // History itself stores ANALYTICS ONLY — never questions, answers or
    // explanations. Those are fetched from the server for THIS attempt, which
    // is possible here because the session reference is still in sessionStorage
    // for this tab. A generous timeout: this is a real backend round trip, not
    // a local read.
    await expect(page.locator('app-interview-review')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator('.rv-item').first()).toBeVisible({ timeout: 30_000 });
    // Loading has settled, so neither note is showing.
    await expect(page.locator('.ihd-note')).toHaveCount(0);

    // Topic Performance is reused here too.
    await expect(page.locator('.topic-row').first()).toBeVisible();
  });

  test('interview readiness: limited state → score → updates → cleared with history', async ({ page }) => {
    // Several full interviews, each answer and submit a round trip to a
    // remote database. The 60s default was sized for local SQLite.
    test.setTimeout(210_000);
    // 1. First interview → limited-data readiness (no numeric score yet).
    await page.goto('/interview');
    await configureAndStart(page, '10');
    await answerAllAndSubmit(page, 10);

    await expect(page.locator('.readiness__heading')).toHaveText(/Interview Readiness/);
    await expect(page.locator('.readiness__limited')).toContainText('at least one more interview');
    await expect(page.locator('.readiness__score')).toHaveCount(0);

    // 2. Second interview → a numeric score + the four-factor breakdown appear.
    await page.locator('button:has-text("Build Another Assessment")').click();
    await expect(page).toHaveURL(/\/interview$/);
    await configureAndStart(page, '10');
    await answerAllAndSubmit(page, 10);

    await expect(page.locator('.readiness__score')).toBeVisible();
    await expect(page.locator('.readiness__score')).toContainText('/ 100');
    await expect(page.locator('.readiness__band')).toBeVisible();
    await expect(page.locator('.readiness__factor')).toHaveCount(4);
    // Deterministic proof it was computed from history: "Based on 2 …".
    await expect(page.locator('.readiness__basedon')).toContainText('Based on 2 completed interviews');

    // 3. A third completed interview → readiness is genuinely RECALCULATED from
    //    the now-larger history (the based-on count advances 2 → 3).
    await page.locator('button:has-text("Build Another Assessment")').click();
    await expect(page).toHaveURL(/\/interview$/);
    await configureAndStart(page, '10');
    await answerAllAndSubmit(page, 10);
    await expect(page.locator('.readiness__score')).toContainText('/ 100');
    await expect(page.locator('.readiness__basedon')).toContainText('Based on 3 completed interviews');

    // 4. Clearing the retained history removes the score automatically (no
    //    separate readiness store) — verify on the history page after clearing.
    await page.evaluate(() => localStorage.removeItem('interviewAttemptHistory:v2'));
    await page.goto('/interview/history');
    await expect(page.locator('.interview-history__empty')).toContainText('No completed interviews yet');
    await expect(page.locator('.readiness__score')).toHaveCount(0);
  });

  test('topic trends: more-data-needed → direction after a repeat → expand → linked summary → cleared', async ({ page }) => {
    // Several full interviews, each answer and submit a round trip to a
    // remote database. The 60s default was sized for local SQLite.
    test.setTimeout(150_000);
    // 1. First interview → topics appear as "More data needed".
    await page.goto('/interview');
    await configureAndStart(page, '10');
    await answerAllAndSubmit(page, 10);

    await page.locator('a:has-text("View Topic Trends")').click();
    await expect(page).toHaveURL(/\/interview\/history#topic-trends/);
    await expect(page.locator('.topic-trends__heading')).toHaveText(/Topic Trends/);
    await expect(page.locator('.tt-badge--dir-insufficient').first()).toContainText('More data needed');
    await expect(page.locator('.topic-trends__note')).toContainText('repeated topics');

    // 2. Second interview (same topics repeat) → a topic gets a direction + change.
    await page.locator('a:has-text("Build an Interview")').first().click();
    await expect(page).toHaveURL(/\/interview$/);
    await configureAndStart(page, '10');
    await answerAllAndSubmit(page, 10);
    await page.locator('a:has-text("View Topic Trends")').click();
    await page.locator('#topic-trends').scrollIntoViewIfNeeded();

    // A directional (non-insufficient) card now exists with numeric change text.
    const directional = page.locator('.tt-card:not(.tt-card--insufficient)').first();
    await expect(directional).toBeVisible();
    await expect(directional.locator('.tt-card__metrics')).toContainText('%');

    // 3. Expand a topic → history table + link to the historical interview summary.
    await directional.locator('.tt-card__toggle').click();
    await expect(directional.locator('.tt-history__table')).toBeVisible();
    await directional.locator('.tt-history__link').first().click();
    await expect(page).toHaveURL(/\/interview\/history\/.+/);
    await expect(page.locator('.ihd__readonly')).toContainText('Read Only');   // no session restored

    // 4. Clearing history removes Topic Trends automatically (no separate store).
    await page.evaluate(() => localStorage.removeItem('interviewAttemptHistory:v2'));
    await page.goto('/interview/history');
    await expect(page.locator('.interview-history__empty')).toBeVisible();
    await expect(page.locator('.topic-trends')).toHaveCount(0);
  });

  test('review answers: summary, statuses, unanswered handling, filters, read-only', async ({ page }) => {
    await page.goto('/interview');
    await configureAndStart(page, '10');

    // Answer the first 8 (first option each), then jump to the last question
    // (direct paginator jumps aren't gated) leaving Q9 + Q10 unanswered.
    for (let i = 1; i <= 8; i++) {
      await page.locator('.io-option').first().click();
      if (i < 8) {
        await page.locator('.pg-next').first().click();
        await expect(page.locator('.interview-progress')).toContainText(`Question ${i + 1}`);
      }
    }
    await page.locator('.pg-page[aria-label^="Go to question 10,"]').click();
    await page.locator('.show-results-btn').click();
    await expect(page.getByText('Submit Assessment?')).toBeVisible();
    await page.locator('button:has-text("Submit Assessment")').last().click();
    await page.waitForURL(RESULTS_URL);

    const score = await page.locator('.score-pct').innerText();

    await page.locator('button:has-text("Review Answers")').click();
    await expect(page.locator('.interview-results__review-heading')).toHaveText(/Review Answers/);
    await expect(page.locator('.rv-item')).toHaveCount(10);

    // Summary (from the submitted result): 2 unanswered; counts sum to 10.
    await expect(page.locator('.rv-summary__unanswered')).toHaveText('2');
    const nums = await page.locator('.rv-summary dd').allInnerTexts();
    // nums[0] = "X / 10"; correct+incorrect+unanswered = 10.
    const [c, inc, un] = [nums[1], nums[2], nums[3]].map((n) => parseInt(n, 10));
    expect(c + inc + un).toBe(10);

    // Filter chips in the new order.
    await expect(page.locator('.rv-filter')).toHaveCount(4);

    // Unanswered filter → the 2 skipped questions, each with the message + a
    // highlighted correct answer, and read-only (no interactive controls).
    await page.locator('.rv-filter', { hasText: 'Unanswered' }).click();
    await expect(page.locator('.rv-item')).toHaveCount(2);
    await expect(page.locator('.rv-unanswered').first()).toContainText('did not answer');
    await expect(page.locator('.rv-item').first().locator('.rv-correct').first()).toBeVisible();
    await expect(page.locator('.rv-option button, .rv-option input')).toHaveCount(0);

    // Explanation section is present.
    await page.locator('.rv-filter', { hasText: 'All' }).click();
    await expect(page.locator('.rv-explanation__heading').first()).toContainText('Explanation');

    // Returning to Results (Hide Review) leaves the score unchanged.
    await page.locator('button:has-text("Hide Review")').click();
    await expect(page.locator('.score-pct')).toHaveText(score);
  });

  test('deferred feedback: no correctness or explanation during the assessment', async ({ page }) => {
    await page.goto('/interview');
    await configureAndStart(page, '10');

    await page.locator('.io-input').first().check({ force: true });

    // No correctness classes/colors, no icons, no FET during the interview.
    await expect(page.locator('.correct-option, .incorrect-option')).toHaveCount(0);
    await expect(page.locator('codelab-quiz-content')).toHaveCount(0);
    await expect(page.locator('.rv-correct, .rv-wrong')).toHaveCount(0);
    // neutral selected marker is allowed
    await expect(page.locator('.io-option.io-selected')).toHaveCount(1);
  });

  test('numeric navigation: paginator (no question dots) + direct jump', async ({ page }) => {
    await page.goto('/interview');
    await configureAndStart(page, '20');

    await expect(page.locator('.interview-paginator')).toBeVisible();
    await expect(page.locator('.paging-dots .dot')).toHaveCount(0);   // no topic-quiz dots

    // first + last shown, ellipsis present (question 1 → 1 2 3 … 20)
    await expect(page.locator('.pg-page[aria-label^="Go to question 1,"]')).toBeVisible();
    await expect(page.locator('.pg-page[aria-label^="Go to question 20,"]')).toBeVisible();
    await expect(page.locator('.pg-ellipsis').first()).toBeVisible();

    // direct jump to a visible page updates the current marker
    await page.locator('.pg-page[aria-label^="Go to question 3,"]').click();
    await expect(page.locator('.pg-page.current')).toHaveText('3');
  });

  /**
   * PENDING — and deliberately so.
   *
   * The deadline is now the SERVER's. `durationSeconds` is on the backend's
   * rejected-request-keys list precisely so a client cannot set the length of
   * its own assessment, and the `?interviewSeconds=` hook that used to shorten
   * the local timer no longer influences anything. Driving real expiry would
   * mean waiting out a 15-minute session, and the only ways to avoid that are
   * to let the client dictate the duration or to add a test-only backdoor to
   * the API — both of which would undo the property this migration exists to
   * establish.
   *
   * The behaviour itself IS covered: expiry-fires-once and
   * submit-without-submittedByExpiry are unit-tested in
   * interview-session.component.spec.ts, and the backend decides
   * `submittedByExpiry` from its own clock (backend/test/interview-submission).
   * Re-enable this if a signed, non-production short-session affordance is ever
   * added to the API.
   */
  test.fixme('timer expiry auto-submits once', async ({ page }) => {
    await page.goto('/interview?interviewSeconds=3');
    await configureAndStart(page, '10');
    await expect(page.locator('.interview-timer__value')).toBeVisible();

    await page.waitForURL(RESULTS_URL, { timeout: 20_000 });
    await expect(page.locator('.interview-results__title')).toHaveText(/Assessment Complete/);
    await expect(page.locator('.interview-results__expiry')).toContainText("Time's up");
  });

  test('direct session access without a session redirects to the builder', async ({ page }) => {
    await page.goto('/interview/session');
    await expect(page).toHaveURL(/\/interview$/);
  });

  test('refresh mid-assessment resumes position, answers and remaining time', async ({ page }) => {
    await page.goto('/interview');
    await configureAndStart(page, '10');

    await page.locator('.io-input').first().check({ force: true });
    await page.locator('.pg-page[aria-label^="Go to question 3,"]').click();
    await expect(page.locator('.pg-page.current')).toHaveText('3');
    await page.waitForTimeout(2500);   // let a couple seconds drain so remaining < 15:00

    await page.reload();

    await expect(page).toHaveURL(/\/interview\/session/);
    await expect(page.locator('.pg-page.current')).toHaveText('3');           // position restored
    await expect(page.locator('.interview-session__progress')).toContainText('1 / 10');  // answer restored
    // remaining time is restored (continued), NOT reset to the full 15:00
    const after = await page.locator('.interview-timer__value').innerText();
    expect(after).not.toBe('15:00');
  });
});

test.describe('topic quiz is unchanged by Interview Mode', () => {
  test('a normal quiz still uses question dots + the Scoreboard-style timer', async ({ page }) => {
    await page.goto('/quiz/intro/fixture-widgets');
    await page.locator('.start-btn, button:has-text("Start")').first().click();
    await page.waitForURL('**/quiz/question/fixture-widgets/1');

    // topic-quiz UI intact
    await expect(page.locator('.paging-dots .dot').first()).toBeVisible();
    await expect(page.locator('span.scoreboard').first()).toBeVisible();

    // and it is NOT the interview UI
    await expect(page.locator('.interview-paginator')).toHaveCount(0);
    await expect(page.locator('.interview-timer__value')).toHaveCount(0);
  });
});
