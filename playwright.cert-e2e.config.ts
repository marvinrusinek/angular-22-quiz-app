import { defineConfig } from '@playwright/test';

import { NODE_HEALTH_URL, ANGULAR_URL } from './e2e-cert-claim/support/cert-e2e-backends';

/**
 * Real-browser regression coverage for the certificate-claims feature:
 * eligible user -> required name/email form -> submit -> open the captured
 * fake verification link -> explicit confirm -> certificate display ->
 * refresh -> recovery in a fresh browser context. See
 * docs/certificate-claims-runbook.md for what this proves, its isolated
 * database, and why the fake email sender is safe to use here.
 *
 * ONE command runs the whole thing: `npm run e2e:certificate`. Needs Docker
 * Desktop (or an equivalent local daemon) running; nothing else.
 *
 * Deliberately NOT built on playwright.config.ts: that harness always starts
 * Spring too (Interview Mode's session lifecycle), which this feature never
 * touches — adding an unrelated, heavyweight (Maven-built) dependency to
 * this suite's startup would cost minutes for zero coverage benefit.
 */
export default defineConfig({
  testDir: './e2e-cert-claim',
  testIgnore: ['support/**'],
  // NOT globalSetup: Playwright starts webServer entries BEFORE globalSetup
  // runs (confirmed directly, and documented the same way by the main
  // harness's own ensure-e2e-database.js) — a database provisioned there
  // would not exist yet when the backend below opens its pool. Chained into
  // the webServer command itself instead, same convention as the main
  // harness.
  globalTeardown: './e2e-cert-claim/support/global-teardown.js',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: ANGULAR_URL,
    trace: 'retain-on-failure',
    screenshot: 'off' // the spec takes its own, deliberately placed screenshots
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: [
    {
      // Reused if you already run `ng serve` yourself — never killed or
      // restarted by this suite, same convention as the main e2e harness.
      command: 'npm start',
      url: ANGULAR_URL,
      timeout: 240_000,
      reuseExistingServer: true,
      stdout: 'pipe',
      stderr: 'pipe'
    },
    {
      // NOT reused — an already-running Node backend on :3000 could be a
      // developer's own, pointed at their real database; this suite must
      // never send claim-form traffic there. The database is provisioned
      // HERE, as the first step of this command, before the backend tries
      // to open a pool against it — see ensure-cert-e2e-database.js's own
      // doc comment for why this can't be a separate globalSetup step.
      command: 'node e2e-cert-claim/support/ensure-cert-e2e-database.js && node e2e-cert-claim/support/launch-cert-e2e-backend.js',
      url: NODE_HEALTH_URL,
      timeout: 90_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe'
    }
  ]
});
