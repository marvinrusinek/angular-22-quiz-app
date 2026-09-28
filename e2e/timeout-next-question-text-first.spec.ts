import { test, expect } from '@playwright/test';
import { HEADING, NEXT_BTN, startQuizViaUi } from './helpers';

// After a question's timer expires (FET shown), navigating to the NEXT question
// must show that question's TEXT first — its FET may only appear once it is
// itself answered correctly or its own timer expires. Regression: the fresh
// question expired on arrival because elapsedTime$ replayed the previous
// (timed-out) question's max elapsed, firing the expiry filter immediately.
const FET_RE = /correct because/i;

test('timed-out question -> Next shows the next question TEXT first, not its FET', async ({ page }) => {
  test.setTimeout(180_000);
  // Public UI, not a direct goto — the Next clicks after each expiry need a
  // real attempt to persist their unlock (Root Cause A, direct-route P1;
  // found via Gate 5's static review — see verdict-check-recovery.spec.ts's
  // comment for why this was missed in the earlier diagnosis pass).
  await startQuizViaUi(page, 'fixture-gadgets', /fixture gadgets/i);
  const rows = page.locator('.option-row');
  await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

  // Q1 times out -> FET, Next enabled.
  await expect(page.locator(HEADING)).toContainText(FET_RE, { timeout: 45_000 });
  await page.locator(NEXT_BTN).click();
  await expect(page).toHaveURL(/\/2$/);
  await rows.first().waitFor({ state: 'visible' });

  // Q2 times out -> FET.
  await expect(page.locator(HEADING)).toContainText(FET_RE, { timeout: 45_000 });
  await page.locator(NEXT_BTN).click();
  await expect(page).toHaveURL(/\/3$/);
  await rows.first().waitFor({ state: 'visible' });

  // ON ARRIVAL at Q3: the heading must be the QUESTION, not the FET.
  await page.waitForTimeout(2500);
  await expect(page.locator(HEADING)).not.toContainText(FET_RE);

  // Q3's OWN timer must still expire and reveal the FET (no regression).
  await expect(page.locator(HEADING)).toContainText(FET_RE, { timeout: 45_000 });
});
