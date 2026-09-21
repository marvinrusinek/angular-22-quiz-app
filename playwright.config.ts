import { defineConfig, devices } from '@playwright/test';

import {
  DEV_DATABASE_URL,
  E2E_ADMIN_DATABASE_URL,
  E2E_DATABASE_NAME,
  E2E_DATABASE_URL,
  devDatabaseName,
} from './e2e/support/e2e-database';
import { NODE_HEALTH_URL, SPRING_HEALTH_URL } from './e2e/support/e2e-backends';

/**
 * Playwright e2e config. These tests drive the app in a real browser to
 * catch the browser-only regressions (blank/stuck explanations, options
 * not rendering, shuffled-nav races) that Jest unit tests structurally
 * cannot. They are the safety net for decomposing handleOptionClick.
 *
 * The webServer block auto-starts `ng serve` and waits for it; locally it
 * reuses an already-running dev server if you have one.
 */
export default defineConfig({
  testDir: './e2e',
  // Support modules are helpers, not specs.
  testIgnore: ['support/**'],
  globalSetup: './e2e/support/global-setup.ts',
  globalTeardown: './e2e/support/global-teardown.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://localhost:4200',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',

    /**
     * Keep every page FOREGROUNDED and un-throttled.
     *
     * Without these, Chromium backgrounds or marks-occluded a page that is not
     * the frontmost window, which flips `document.visibilityState` to 'hidden'
     * and throttles timers to roughly once a minute. Both break this app's real
     * behaviour rather than merely slowing it down:
     *
     *   - `qqc-orch-explanation.service.ts:40` calls
     *     `resetExplanationStateOnHide()` when the page goes hidden, so a
     *     timer-expiry FET assertion sees the heading revert to question text.
     *   - Question timers are wall-clock dependent, so a throttled 30s timer
     *     never fires inside a 45s wait.
     *
     * That is why the TIMER/FET specs passed when run ALONE (one page, always
     * frontmost) yet failed in multi-file runs — a harness artefact, not a
     * product defect. The app's hidden-document guards are deliberate (they are
     * part of the FET-flicker fixes) and are NOT relaxed to suit the tests.
     *
     * Note this does NOT disable deliberate simulation: assessment-integrity
     * .spec.ts forces `document.visibilityState` via a property getter and
     * dispatches its own visibilitychange/blur events, which still work.
     */
    launchOptions: {
      args: [
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=CalculateNativeWinOcclusion',
      ],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  /**
   * THREE servers, started strictly in this order (Playwright runs its
   * webServer entries one after another and waits for each URL before the next):
   *
   *   1. Angular  :4200  the app under test (reused if you already run `ng serve`)
   *   2. Node     :3000  Topic Quiz + Interview-builder metadata. Creates, migrates
   *                      and seeds the disposable `e2e_*` database.
   *   3. Spring   :8080  Interview session lifecycle. Attaches to THAT SAME
   *                      database and only validates it (`ddl-auto=validate`) —
   *                      Node stays the only schema author, as in production.
   *
   * This mirrors the app's real routing (api-base-url.token.ts): Topic Quiz and the
   * Interview builder's topic list go to Node, session create/answer/review/submit
   * go to Spring. Both ports are FIXED — the app hard-codes them for a local dev
   * build and the page's CSP allows only them — so the harness has to OWN both.
   * See e2e/support/e2e-backends.js, the single definition of those ports.
   *
   * Both backends are NEVER reused: a server already answering on 3000 or 8080
   * could be the developer's own, wired to their real database, and E2E traffic
   * (which writes sessions and answers) must not reach it. If either port is
   * taken the run aborts before any test runs.
   */
  webServer: [
    {
      command: 'npm start',
      url: 'http://localhost:4200',
      timeout: 240_000,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // The throwaway database is created HERE, not in globalSetup: Playwright
      // launches webServer first, so a database created there would not exist
      // yet when the backend opens its pool.
      //
      // preflight-ports.js runs FIRST and checks BOTH controlled ports, so a
      // busy 8080 (the developer's Spring) aborts the run before a database is
      // created — Playwright would otherwise only notice when Spring's turn comes.
      command:
        'node ../e2e/support/preflight-ports.js && ' +
        'node ../e2e/support/ensure-e2e-database.js && npm run dev',
      cwd: 'backend',
      url: NODE_HEALTH_URL,
      timeout: 120_000,
      // NOT reused: an already-running backend would be pointed at the
      // developer's database, which is exactly what this isolation prevents.
      reuseExistingServer: false,
      env: {
        DATABASE_URL: E2E_DATABASE_URL,
        E2E_DATABASE_NAME,
        E2E_ADMIN_DATABASE_URL,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // Starts only AFTER Node is healthy, i.e. after the database exists, is
      // migrated and is seeded. launch-spring.js refuses to start unless its
      // datasource is THIS run's `e2e_*` database, builds the jar out of tree
      // (never in backend-spring/), and gives Spring an explicit environment —
      // nothing is inherited from the shell or read from `.env`.
      command: 'node e2e/support/launch-spring.js',
      url: SPRING_HEALTH_URL,
      // The first run builds the jar with Maven; later runs use the cached jar.
      timeout: 600_000,
      // NOT reused — see the note above.
      reuseExistingServer: false,
      env: {
        E2E_DATABASE_URL,
        E2E_DATABASE_NAME,
        E2E_DEV_DATABASE_NAME: DEV_DATABASE_URL.length > 0 ? devDatabaseName() : '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
