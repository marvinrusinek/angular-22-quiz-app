import { test, expect, Request } from '@playwright/test';

/**
 * The countdown must end at or after the deadline the server signed.
 *
 * This is the regression that broke timeout reveals. The client started a local
 * 30-second timer as soon as a question rendered, but the receipt authorizing a
 * timeout only came into existence at the first `/check` — which, for a question
 * nobody answered, IS the timeout reveal. So the server's window opened at the
 * instant the client's closed. The reveal landed roughly 30 seconds before its
 * own deadline, `/check` answered `incomplete`, and nothing painted.
 *
 * Measured here rather than reasoned about, because the failure was entirely a
 * matter of ordering in real wall-clock time. The invariant:
 *
 *     the timeout /check must not arrive before the signed deadline
 *
 * Nothing sensitive is captured — only when requests happened, and the server's
 * own `startedAt`/`expiresAt`. The receipt itself is never read or printed.
 */

const TIMER = '.scoreboard-timer .scoreboard';

interface Evidence {
  startResponseAt: number;
  startedAt: number;
  expiresAt: number;
  checkAt: number;
  checkStatus: string;
}

test.describe('timer — signed deadline is the timing authority', () => {
  test('the timeout check never arrives before the deadline it is checking against', async ({ page }) => {
    test.setTimeout(90_000);

    const evidence: Partial<Evidence> = {};
    let firstStartSeen = false;

    page.on('response', async (res) => {
      const url = res.url();

      if (url.includes('/questions/start') && !firstStartSeen) {
        firstStartSeen = true;
        evidence.startResponseAt = Date.now();
        const body = await res.json().catch(() => null);
        if (body) {
          evidence.startedAt = body.startedAt;
          evidence.expiresAt = body.expiresAt;
        }
        return;
      }

      if (url.endsWith('/check') && evidence.checkAt == null) {
        evidence.checkAt = Date.now();
        const body = await res.json().catch(() => null);
        if (body) evidence.checkStatus = body.status;
      }
    });

    const startRequests: Request[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/questions/start')) startRequests.push(req);
    });

    await page.goto('/quiz/intro/typescript');
    await page.locator('.start-btn').click();
    await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 20_000 });

    // The window must be authorized BEFORE the countdown can mean anything.
    await expect.poll(() => evidence.expiresAt, { timeout: 20_000 }).toBeDefined();

    // Let it run out. Do not answer.
    await expect
      .poll(async () => {
        const t = (await page.locator(TIMER).textContent()) ?? '';
        const m = t.match(/(\d+):(\d+)/);
        return m ? Number(m[2]) : NaN;
      }, { timeout: 50_000 })
      .toBe(0);

    await expect.poll(() => evidence.checkAt, { timeout: 15_000 }).toBeDefined();

    // The server's deadline, expressed on this machine's clock. The client
    // anchors the server's DURATION to the moment the response arrived, so the
    // two clocks never have to agree for the ordering to hold.
    const durationMs = evidence.expiresAt! - evidence.startedAt!;
    const localDeadline = evidence.startResponseAt! + durationMs;

    // THE invariant. Previously this was ~30 seconds negative.
    expect(evidence.checkAt! - localDeadline).toBeGreaterThanOrEqual(0);

    // And the server agreed the question was over.
    expect(evidence.checkStatus).toBe('expired');

    // One window for the question, not one per render.
    expect(startRequests.length).toBe(1);
  });
});
