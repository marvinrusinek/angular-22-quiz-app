import { test, expect } from '@playwright/test';

/**
 * Confirms the new apiErrorInterceptor does not weaken fail-closed behavior:
 * when `/check` fails, the app must show no fabricated correctness (no
 * green/red reveal, no local answer-key fallback) — it must simply fail,
 * exactly as it did before the interceptor existed.
 */
test('an API /check failure produces NO fabricated correctness — the option never resolves to correct/incorrect', async ({ page }) => {
  await page.route('**/check**', (route) => route.fulfill({ status: 500, body: '{}' }));

  await page.goto('/quiz/question/fixture-widgets/1');
  const row = page.locator('.option-row').first();
  await row.waitFor({ state: 'visible', timeout: 20_000 });

  await row.click();
  await page.waitForTimeout(1500);

  const cls = (await row.getAttribute('class')) ?? '';
  expect(cls).not.toMatch(/\bcorrect-option\b/);
  expect(cls).not.toMatch(/\bincorrect-option\b/);
});
