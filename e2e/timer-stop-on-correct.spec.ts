import { test, expect, Page } from '@playwright/test';
import { HEADING, correctIndexForHeading, diQuiz, correctRowsForHeading, findMultiAnswerQuestion } from './helpers';

/**
 * TOPIC QUIZ TIMER STOPS ON CORRECT COMPLETION — regression guard.
 *
 * THE REGRESSION: the countdown never stopped when the correct answer(s) were
 * selected, for single- OR multi-answer questions. The synchronous click-time
 * path (`QqcOptionClickOrchestratorService#computeCorrectness`) derived
 * correctness from `option.correct` / `isOptionCorrect(option)` — data the API
 * never sends once questions come from `/questions` (Stage 14 removed it from
 * the client entirely) — so `allCorrect` always read false, and the only
 * timer-stop call in the click pipeline (`safeStopTimer`, gated on it, and
 * itself gated to multi-answer only) never fired. Nothing else re-checked
 * once the actual `/check` verdict landed, so the countdown just ran to
 * expiry regardless of what was clicked.
 *
 * THE FIX asks the SAME verdict authority `TimerService#hasRecordedCorrectCompletion`
 * (and therefore `allCorrectSelectedFromVerdict`) already uses for the
 * freeze-on-revisit decision — never `option.correct`, never local
 * click-confirmed-dot-status/elapsed-time approximations. A reactive effect
 * (`OptionFeedbackEffectsService#stopTimerOnVerdictComplete`) fires the moment
 * a terminal verdict lands for the active question and stops the timer then,
 * regardless of how long `/check` took.
 */

const TIMER = '.scoreboard-timer .scoreboard';

async function timerSeconds(page: Page): Promise<number> {
  const t = (await page.locator(TIMER).textContent()) ?? '';
  const m = t.match(/(\d+):(\d+)/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

async function startFixtureWidgets(page: Page): Promise<void> {
  await page.goto('/quiz/intro/fixture-widgets');
  await page.locator('.start-btn').click();
  await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 20000 });
}

test.describe('single-answer', () => {
  test('a correct pick stops the timer immediately, and it stays stopped', async ({ page }) => {
    await startFixtureWidgets(page);

    const h = (await page.locator(HEADING).textContent()) ?? '';
    const correctIdx = correctIndexForHeading(h);
    expect(correctIdx).toBeGreaterThanOrEqual(0);

    await page.locator('.option-row').nth(correctIdx).click();

    const samples: number[] = [];
    for (let i = 0; i < 6; i++) {
      samples.push(await timerSeconds(page));
      await page.waitForTimeout(500);
    }
    expect(samples.every((s) => s === samples[0]),
      `timer must stop the instant the correct answer is selected, got ${JSON.stringify(samples)}`
    ).toBe(true);
  });

  test('a wrong pick does NOT stop the timer; the following correct pick does', async ({ page }) => {
    await startFixtureWidgets(page);

    const h = (await page.locator(HEADING).textContent()) ?? '';
    const correctIdx = correctIndexForHeading(h);
    const rows = page.locator('.option-row');
    const count = await rows.count();
    const wrongIdx = [...Array(count).keys()].find((i) => i !== correctIdx) ?? 0;

    const beforeWrong = await timerSeconds(page);
    await rows.nth(wrongIdx).click();
    await page.waitForTimeout(1500);
    const afterWrong = await timerSeconds(page);
    expect(afterWrong, 'a wrong pick must not stop the timer').toBeLessThan(beforeWrong);

    await rows.nth(correctIdx).click();
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      samples.push(await timerSeconds(page));
      await page.waitForTimeout(500);
    }
    expect(samples.every((s) => s === samples[0]),
      `the correct pick that follows a wrong one must still stop the timer, got ${JSON.stringify(samples)}`
    ).toBe(true);
  });
});

test.describe('multi-answer', () => {
  test('a partial correct selection does NOT stop the timer; the final required pick does', async ({ page }) => {
    const MULTI = findMultiAnswerQuestion(diQuiz);
    await page.goto(`/quiz/question/fixture-gadgets/${MULTI.index}`);
    await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 20000 });

    const rows = page.locator('.option-row');
    const heading = (await page.locator(HEADING).textContent()) ?? '';
    const corrects = await correctRowsForHeading(rows, diQuiz, heading);
    expect(corrects.length).toBeGreaterThanOrEqual(2);

    for (let i = 0; i < corrects.length - 1; i++) {
      await rows.nth(corrects[i]).click();
      await page.waitForTimeout(400);
    }
    const t1 = await timerSeconds(page);
    await page.waitForTimeout(1500);
    const t2 = await timerSeconds(page);
    expect(t2, 'a partial multi-answer selection must not stop the timer').toBeLessThan(t1);

    await rows.nth(corrects[corrects.length - 1]).click();
    const samples: number[] = [];
    for (let i = 0; i < 6; i++) {
      samples.push(await timerSeconds(page));
      await page.waitForTimeout(500);
    }
    expect(samples.every((s) => s === samples[0]),
      `selecting the final required correct option must stop the timer, got ${JSON.stringify(samples)}`
    ).toBe(true);
  });
});
