import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { DEBUG_SENT_LOG_URL, DEBUG_MINT_EXPIRED_URL } from './support/cert-e2e-backends';

/**
 * Real-browser verification of the certificate-claim feature: eligible user
 * -> required name/email form -> submit -> open the captured fake
 * verification link -> explicit confirm -> certificate display -> refresh ->
 * recovery in a fresh browser context. Also covers: opening the link alone
 * must not issue anything, expired/reused links show useful messages,
 * recovery never duplicates the owner notification, legacy awards stay
 * clearly labelled, and quizzes stay registration-free.
 *
 * Backends are started and torn down by playwright.cert-e2e.config.ts (see
 * docs/certificate-claims-runbook.md) — this spec only drives the browser
 * and the debug side-channel that exposes what the fake (InMemoryEmailSender)
 * sender captured. That channel is TEST-ONLY — see
 * e2e-cert-claim/support/launch-cert-e2e-backend.js's own doc comment for
 * why it can never exist in a production process.
 */

const SCREENSHOT_DIR = resolve(__dirname, 'screenshots');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

interface SentMessage {
  readonly message: {
    readonly to: string;
    readonly kind: string;
    readonly templateData: { readonly verificationUrl?: string };
  };
}

async function fetchSentLog(): Promise<SentMessage[]> {
  const res = await fetch(DEBUG_SENT_LOG_URL);
  return res.json();
}

/** Polls the debug sent-log until a NEW claimant_verify email for `email` appears past `sinceIndex`, returns its raw token. */
async function waitForVerificationToken(email: string, sinceIndex: number): Promise<{ token: string; index: number }> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const log = await fetchSentLog();
    for (let i = sinceIndex; i < log.length; i++) {
      const entry = log[i];
      if (entry.message.kind === 'claimant_verify' && entry.message.to === email) {
        const url = entry.message.templateData.verificationUrl ?? '';
        const token = decodeURIComponent(url.split('#token=')[1] ?? '');
        if (token) return { token, index: i };
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`no verification email for ${email} arrived within timeout`);
}

async function countOwnerNotifications(): Promise<number> {
  const log = await fetchSentLog();
  return log.filter((e) => e.message.kind === 'owner_claim_notice').length;
}

/** Seeds localStorage with an eligible-but-unclaimed user BEFORE the app's first script runs. */
async function seedEligibleUser(page: Page): Promise<void> {
  const qualStart = '2026-01-01T00:00:00.000Z';
  const attempts = Array.from({ length: 5 }, (_, i) => ({
    id: `e2e-attempt-${i}`,
    completedAt: `2026-01-0${i + 2}T00:00:00.000Z`,
    score: 9,
    totalQuestions: 10,
    percentage: 90,
    completionReason: 'submitted',
    selectedTopicIds: ['components'],
    topicPerformance: []
  }));

  await page.addInitScript(
    ({ qualStart, attempts }) => {
      window.localStorage.setItem('quizAchievements', JSON.stringify([{ id: 'angular-explorer', earnedAt: qualStart }]));
      window.localStorage.setItem('interviewCertificateQualifiedAt:v1', JSON.stringify({ startedAt: qualStart }));
      window.localStorage.setItem('interviewAttemptHistory:v2', JSON.stringify({ version: 2, attempts }));
    },
    { qualStart, attempts }
  );
}

async function seedLegacyCertificate(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      'interviewCertificate:v1',
      JSON.stringify({
        version: 1,
        unlocked: true,
        unlockedAt: '2026-01-15T00:00:00.000Z',
        certificateId: 'AQ-2026-OLD0001',
        recipientName: 'Legacy Learner'
      })
    );
  });
}

/**
 * Chrome itself logs an "error" console entry for EVERY non-2xx XHR/fetch
 * response and for a refused connection, regardless of how gracefully the
 * app handles it — that is the browser's own network logging, not an
 * application defect, and several of this spec's own tests deliberately
 * exercise error paths (expired/reused tokens) that legitimately produce
 * one. Genuine application bugs show up as an uncaught `pageerror` or as
 * `console.error(...)` called BY app code with its own message, neither of
 * which matches this pattern.
 */
const BENIGN_CONSOLE_PATTERNS = [
  /^Failed to load resource:/,
  /^net::/,
  // NG02955 (NgOptimizedImage "priority" hint): a pre-existing, unrelated
  // performance hint on this app's hero image, not a certificate-claim
  // regression — out of scope to fix here.
  /NG02955/
];

function trackConsoleErrors(page: Page, bucket: string[]): void {
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (BENIGN_CONSOLE_PATTERNS.some((p) => p.test(text))) return;
    bucket.push(`[console] ${text}`);
  });
  page.on('pageerror', (err) => bucket.push(`[pageerror] ${err.message}`));
}

// Timestamped so re-running this spec against the SAME persistent isolated
// database (normal while iterating on the spec itself) never collides with a
// certificate a PREVIOUS run already issued for a fixed address — that would
// turn this run's "new claim" into a recovery of someone else's run.
const RUN_ID = Date.now();
const EMAIL = `ada.e2e.${RUN_ID}@example.com`;
let firstCertificateId = '';

test.describe('certificate claim — real browser', () => {
  test('eligible user: claim form -> submit -> open link -> confirm explicitly -> certificate -> refresh', async ({ page }) => {
    const consoleErrors: string[] = [];
    trackConsoleErrors(page, consoleErrors);
    await seedEligibleUser(page);

    await page.goto('/interview/certificate');
    await expect(page.getByRole('link', { name: /claim your certificate|send verification email/i }).or(page.locator('a[href*="/interview/certificate/claim"]'))).toBeVisible({ timeout: 10_000 });

    await page.goto('/interview/certificate/claim');
    await page.screenshot({ path: resolve(SCREENSHOT_DIR, '1-claim-form.png'), fullPage: true });

    await page.getByLabel(/your name/i).fill('Ada Lovelace');
    await page.getByLabel(/email address/i).fill(EMAIL);

    const beforeSubmitLogLen = (await fetchSentLog()).length;
    await page.getByRole('button', { name: /send verification email/i }).click();

    await expect(page.getByText(/check your email/i)).toBeVisible({ timeout: 10_000 });

    const { token } = await waitForVerificationToken(EMAIL, beforeSubmitLogLen);

    // Opening the link alone must NOT issue a certificate — preview only.
    await page.goto(`/interview/certificate/verify#token=${encodeURIComponent(token)}`);
    await expect(page.getByText(/confirm for/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /confirm and issue my certificate/i })).toBeVisible();
    await page.screenshot({ path: resolve(SCREENSHOT_DIR, '2-confirmation-page-preview.png'), fullPage: true });

    // Reloading the SAME link again still must not auto-confirm.
    await page.reload();
    await expect(page.getByRole('button', { name: /confirm and issue my certificate/i })).toBeVisible({ timeout: 10_000 });

    // The explicit, user-triggered step.
    await page.getByRole('button', { name: /confirm and issue my certificate/i }).click();
    await expect(page.getByRole('heading', { name: /certificate confirmed/i })).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: resolve(SCREENSHOT_DIR, '3-confirmed.png'), fullPage: true });

    await page.getByRole('link', { name: /view your certificate/i }).click();
    await expect(page.getByText('Ada Lovelace')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/legacy/i)).toHaveCount(0); // a VERIFIED certificate must never carry the legacy label
    await page.screenshot({ path: resolve(SCREENSHOT_DIR, '4-issued-certificate.png'), fullPage: true });

    const certIdText = await page.locator('body').innerText();
    const certIdMatch = /AQ-\d{4}-[A-Z0-9]+/.exec(certIdText);
    expect(certIdMatch).not.toBeNull();
    firstCertificateId = certIdMatch![0];

    // Refresh must still show the certificate (re-fetched via retrieval token).
    await page.reload();
    await expect(page.getByText('Ada Lovelace')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(firstCertificateId)).toBeVisible();

    // REUSE the already-confirmed link — must show a useful message, not a crash.
    await page.goto(`/interview/certificate/verify#token=${encodeURIComponent(token)}`);
    await expect(page.getByText(/already been used/i)).toBeVisible({ timeout: 10_000 });

    expect(consoleErrors, `unexpected console/page errors:\n${consoleErrors.join('\n')}`).toEqual([]);
  });

  test('expired link shows a useful message, not a crash', async ({ page }) => {
    const consoleErrors: string[] = [];
    trackConsoleErrors(page, consoleErrors);
    await seedEligibleUser(page);

    const email = `grace.expired.${RUN_ID}@example.com`;
    await page.goto('/interview/certificate/claim');
    await page.getByLabel(/your name/i).fill('Grace Hopper');
    await page.getByLabel(/email address/i).fill(email);
    const beforeLen = (await fetchSentLog()).length;
    await page.getByRole('button', { name: /send verification email/i }).click();
    await expect(page.getByText(/check your email/i)).toBeVisible({ timeout: 10_000 });
    await waitForVerificationToken(email, beforeLen); // ensure the claim row exists before minting an expired one directly

    const mintRes = await fetch(`${DEBUG_MINT_EXPIRED_URL}?email=${encodeURIComponent(email)}`);
    const { rawToken } = (await mintRes.json()) as { rawToken: string };

    await page.goto(`/interview/certificate/verify#token=${encodeURIComponent(rawToken)}`);
    await expect(page.getByText(/expired/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('link', { name: /request a new link/i })).toBeVisible();

    expect(consoleErrors, `unexpected console/page errors:\n${consoleErrors.join('\n')}`).toEqual([]);
  });

  test('recovery in a fresh browser context: same email, same certificate id/date, no second owner notification', async ({ browser }) => {
    const context = await browser.newContext(); // fresh storage — simulates a different device
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    trackConsoleErrors(page, consoleErrors);

    const ownerCountBefore = await countOwnerNotifications();

    await page.goto('/interview/certificate/claim');
    await page.getByRole('button', { name: /already have a certificate\? recover it/i }).click();
    await page.getByLabel(/your name/i).fill('Someone Typed A Different Name');
    await page.getByLabel(/email address/i).fill(EMAIL);
    const beforeLen = (await fetchSentLog()).length;
    await page.getByRole('button', { name: /send recovery link/i }).click();
    await expect(page.getByText(/check your email/i)).toBeVisible({ timeout: 10_000 });

    const { token } = await waitForVerificationToken(EMAIL, beforeLen);
    await page.goto(`/interview/certificate/verify#token=${encodeURIComponent(token)}`);
    await page.getByRole('button', { name: /confirm and issue my certificate/i }).click();
    await expect(page.getByRole('heading', { name: /certificate confirmed/i })).toBeVisible({ timeout: 10_000 });

    const bodyText = await page.locator('body').innerText();
    expect(bodyText).toContain(firstCertificateId); // SAME certificate id preserved — never a new one

    const ownerCountAfter = await countOwnerNotifications();
    expect(ownerCountAfter).toBe(ownerCountBefore); // recovery must NOT generate another owner notification

    expect(consoleErrors, `unexpected console/page errors:\n${consoleErrors.join('\n')}`).toEqual([]);
    await context.close();
  });

  test('a legacy, locally-issued certificate is preserved and clearly labelled', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    trackConsoleErrors(page, consoleErrors);
    await seedLegacyCertificate(page);

    await page.goto('/interview/certificate');
    await expect(page.getByText('Legacy Learner')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.ic-legacy-badge')).toContainText(/legacy certificate.*not email-verified/i);

    expect(consoleErrors, `unexpected console/page errors:\n${consoleErrors.join('\n')}`).toEqual([]);
    await context.close();
  });

  test('rendered print/PDF output: name/id/date present, Score/Readiness absent, controls hidden, long name wraps, print stays light even in dark theme', async ({ page }) => {
    const consoleErrors: string[] = [];
    trackConsoleErrors(page, consoleErrors);
    await seedEligibleUser(page);

    const email = `victoria.print.${RUN_ID}@example.com`;
    const longName = 'Victoria Alexandra Wintermere-Blackwood-Thistlewood the Third';
    await page.goto('/interview/certificate/claim');
    await page.getByLabel(/your name/i).fill(longName);
    await page.getByLabel(/email address/i).fill(email);
    const beforeLen = (await fetchSentLog()).length;
    await page.getByRole('button', { name: /send verification email/i }).click();
    await expect(page.getByText(/check your email/i)).toBeVisible({ timeout: 10_000 });

    const { token } = await waitForVerificationToken(email, beforeLen);
    await page.goto(`/interview/certificate/verify#token=${encodeURIComponent(token)}`);
    await page.getByRole('button', { name: /confirm and issue my certificate/i }).click();
    await page.getByRole('link', { name: /view your certificate/i }).click();
    await expect(page.locator('.ic-cert__name')).toContainText(longName, { timeout: 10_000 });

    // ── on-screen: Score/Readiness never rendered for a verified certificate ──
    await expect(page.getByText('Interview Readiness')).toHaveCount(0);
    await expect(page.getByText('Best Interview Score')).toHaveCount(0);
    await expect(page.getByText('Date Issued')).toBeVisible();
    const certIdText = await page.locator('.ic-cert__id strong').innerText();
    expect(certIdText).toMatch(/AQ-\d{4}-[A-Z0-9]+/);

    // ── long name: readable, not clipped (no introduced horizontal overflow) ──
    const nameOverflow = await page.locator('.ic-cert').evaluate((el) => ({
      scrollW: el.scrollWidth,
      clientW: el.clientWidth,
    }));
    expect(nameOverflow.scrollW).toBeLessThanOrEqual(nameOverflow.clientW + 2);

    // ── Print Certificate button wiring: native dialog stubbed, never actually opened ──
    let printInvoked = false;
    await page.exposeFunction('__printInvoked', () => { printInvoked = true; });
    await page.evaluate(() => { window.print = () => { (window as unknown as { __printInvoked: () => void }).__printInvoked(); }; });
    await page.getByRole('button', { name: 'Print Certificate' }).click();
    expect(printInvoked).toBe(true); // proves the button is wired; this is NOT a native-print-dialog verification

    // ── print-media rendering (not the native dialog): dark theme active, print must still be light/parchment ──
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('.ic-actions')).toBeHidden();
    await expect(page.getByRole('link', { name: /back to results/i })).toBeHidden();

    const printStyle = await page.evaluate(() => {
      const cert = document.querySelector('.ic-cert') as HTMLElement;
      const cs = getComputedStyle(cert);
      return { background: cs.backgroundColor, breakInside: cs.breakInside };
    });
    const luminance = (rgb: string): number => {
      const [r, g, b] = (rgb.match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map(Number).map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    expect(luminance(printStyle.background)).toBeGreaterThan(0.85); // white/parchment, not the dark theme's surface
    expect(printStyle.breakInside).toBe('avoid'); // page-break sanity: the card is never split across pages

    const pdf = await page.pdf({ format: 'A4' }); // a real print render, no dialog
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdf.length).toBeGreaterThan(5_000);
    writeFileSync(resolve(SCREENSHOT_DIR, '6-certificate.pdf'), pdf); // saved as a real artifact to inspect, not just byte-checked
    await page.screenshot({ path: resolve(SCREENSHOT_DIR, '5-print-long-name.png'), fullPage: true });

    await page.emulateMedia({ media: 'screen' });
    expect(consoleErrors, `unexpected console/page errors:\n${consoleErrors.join('\n')}`).toEqual([]);
  });

  test('quizzes remain registration-free: no certificate-claim gate blocks Quiz Selection', async ({ browser }) => {
    const context = await browser.newContext(); // fully unseeded — no eligibility, no claim state at all
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    trackConsoleErrors(page, consoleErrors);

    await page.goto('/');
    await expect(page.locator('body')).not.toContainText(/create an account|sign up|log in/i);
    await expect(page.locator('.quiz-tile, [class*="quiz-tile"], a[href*="/question/"]').first()).toBeVisible({ timeout: 10_000 });

    expect(consoleErrors, `unexpected console/page errors:\n${consoleErrors.join('\n')}`).toEqual([]);
    await context.close();
  });
});
