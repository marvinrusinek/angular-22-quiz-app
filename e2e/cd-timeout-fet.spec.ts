import { test, expect } from '@playwright/test';
import { HEADING, NEXT_BTN } from './helpers';

// The FET (explanation) must appear when the question timer expires on EVERY
// question, not just Q1. Regression: a spurious restartForQuestion() after the
// timeout wiped expiredForQuestionIndexSig, so Q2+ showed the question instead.
const FET_RE = /correct because/i;

async function navTo(page: any, target: number) {
  await page.goto('/quiz/question/change-detection/1');
  const rows = page.locator('.option-row');
  await rows.first().waitFor({ state: 'visible', timeout: 20_000 });
  for (let i = 1; i < target; i++) {
    await page.locator(NEXT_BTN).click();
    await expect(page).toHaveURL(new RegExp(`/${i + 1}$`));
    await rows.first().waitFor({ state: 'visible' });
  }
}

for (const q of [1, 2, 3]) {
  test(`CD Q${q}: timer expiry shows the FET`, async ({ page }) => {
    // Q2+ are reached by letting each prior question's timer expire (Next is
    // disabled until then), so the run needs headroom for several ~30s timers.
    test.setTimeout(240_000);
    await navTo(page, q);
    // Let the timer expire with NO interaction -> FET must appear in the heading.
    await expect(page.locator(HEADING)).toContainText(FET_RE, { timeout: 90_000 });
  });
}

test('genuine expiry locks every option — no click response, no fabricated selected/incorrect painting', async ({ page }) => {
  test.setTimeout(60_000);
  await navTo(page, 1);
  await expect(page.locator(HEADING)).toContainText(FET_RE, { timeout: 60_000 });

  const rows = page.locator('.option-row');
  const classes = await rows.evaluateAll((els) => els.map((el) => el.className));

  for (const cls of classes) {
    // Every option is locked, right down to the Material control itself —
    // not merely visually styled while still clickable underneath.
    expect(cls).toMatch(/\blocked-option\b/);
    expect(cls).toMatch(/mat-mdc-(radio|checkbox)-disabled/);
    // The user selected nothing this visit: no option may be painted as
    // though it were their pick, and no unselected option may be painted
    // incorrect — only the authorized correct option may reveal itself.
    expect(cls).not.toMatch(/\bselected\b/);
    expect(cls).not.toMatch(/\bincorrect-option\b/);
  }

  // Exactly the authorized correct option reveals green; nothing else does.
  const correctCount = classes.filter((c) => /\bcorrect-option\b/.test(c)).length;
  expect(correctCount).toBe(1);

  // Clicking a locked option after expiry must do nothing.
  const before = await page.locator(HEADING).innerText();
  await rows.nth(1).click({ force: true }).catch(() => {});
  await page.waitForTimeout(500);
  await expect(page.locator(HEADING)).toHaveText(before);
});
