import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { countInterviewSessions, isHarnessSpring, portOwner } from './support/backend-identity';
import {
  E2E_DATABASE_NAME,
  devDatabaseName,
  e2eDatabaseExists,
  fingerprintDevDatabase,
  sameFingerprint,
  type DatabaseFingerprint
} from './support/e2e-database';
import { NODE_API_BASE_URL, NODE_HEALTH_URL, NODE_PORT, SPRING_API_BASE_URL, SPRING_PORT } from './support/e2e-backends';
import { E2E_STATE_DIR } from './support/global-setup';

/**
 * Proves the harness writes to a throwaway database — and that the two-backend
 * architecture is the one under test.
 *
 * The app routes to TWO backends (src/app/shared/tokens/api-base-url.token.ts):
 *
 *   Topic Quiz + the Interview builder's topic list → Node   :3000
 *   Interview session lifecycle                     → Spring :8080
 *
 * Playwright starts BOTH, against ONE disposable `e2e_*` database (see
 * playwright.config.ts). The unit of isolation is a DATABASE on the developer's
 * Postgres server, not a file — so these assert on the database's identity, on
 * WHICH process answered each kind of request, on where Spring's writes landed,
 * and on the dev database's contents being unchanged.
 *
 * A port number alone would prove little: the developer's own Spring, on their
 * own database, answers on 8080 just as well. So the checks below use process
 * identity (what launched the listener) and behaviour (the session Spring
 * created is in the DISPOSABLE database and Node can read it back).
 *
 * Removal after teardown cannot be asserted from inside a test — teardown runs
 * later — so `global-teardown.ts` verifies it and throws, which fails the run.
 */

/** Production API origins. The E2E page must never contact one. */
const PRODUCTION_API_HOSTS = [
  'interview-api-c842.onrender.com',
  'interview-api-spring.marvinrusinek.com',
  'interview-api-spring.onrender.com'
];

/** Drives the Interview builder exactly as a user (and the other Interview specs) do. */
async function startInterview(page: Page): Promise<void> {
  await page.goto('/interview');
  await page.locator('.chip:has-text("Beginner")').first().click();
  const boxes = page.locator('.topic-check input[type="checkbox"]');
  await expect(boxes.first()).toBeVisible();
  await boxes.first().check({ force: true });
  await page.locator('.chip--button:has-text("10")').first().click();
  await page.locator('.start-interview-btn').click();
  await page.waitForURL(/\/interview\/session\/[^/?#]+/);
  await expect(page.locator('.interview-question-box')).toBeVisible();
}

test.describe('E2E database isolation', () => {
  test('the backend uses a throwaway database, not the development one', async ({ request }) => {
    // The suite has driven real interviews by now, so the database must exist.
    await request.get(NODE_HEALTH_URL);

    expect(E2E_DATABASE_NAME.startsWith('e2e_')).toBe(true);
    expect(E2E_DATABASE_NAME).not.toBe(devDatabaseName());
    expect(await e2eDatabaseExists()).toBe(true);
  });

  test('the backends on :3000 and :8080 are the harness\'s own — an uncontrolled Spring or Node cannot be the one answering', async ({ request }) => {
    // SPRING: a Java process running the jar the harness built out of tree. The developer's own
    // instance runs from backend-spring/target (or an IDE) and would fail this check.
    const spring = portOwner(SPRING_PORT);
    expect(isHarnessSpring(spring), 'the listener on :8080 is not the harness-launched Spring').toBe(true);

    // Spring has an actuator route Node does not, so the two cannot be mistaken for one another.
    const springActuator = await request.get(`http://localhost:${SPRING_PORT}/actuator/health`);
    const nodeActuator = await request.get(`http://localhost:${NODE_PORT}/actuator/health`);
    expect(springActuator.status()).toBe(200);
    expect(nodeActuator.status()).toBe(404);

    // NODE: it is a Node process, and it is serving THIS run's fixture bank — a development Node on
    // the developer's database would list real topics, not the synthetic `fixture-*` ones.
    expect(portOwner(NODE_PORT)?.name).toMatch(/^node(\.exe)?$/);
    const quizzes = (await (await request.get(`${NODE_API_BASE_URL}/quizzes`)).json()) as { quizzes?: { quizId: string }[] } | { quizId: string }[];
    const ids = (Array.isArray(quizzes) ? quizzes : quizzes.quizzes ?? []).map((q) => q.quizId);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => id.startsWith('fixture-'))).toBe(true);
  });

  test('builder/Topic traffic goes to Node; Interview traffic goes to Spring — never to Node — and lands in the throwaway database', async ({ page, request }) => {
    const seen: { method: string; host: string; path: string; status: number }[] = [];
    const hosts = new Set<string>();
    let created: { sessionId?: string; sessionToken?: string } | null = null;

    page.on('request', (req) => hosts.add(new URL(req.url()).host));
    page.on('response', async (res) => {
      const url = new URL(res.url());
      const entry = { method: res.request().method(), host: url.host, path: url.pathname, status: res.status() };
      seen.push(entry);
      if (entry.host === `localhost:${SPRING_PORT}` && entry.method === 'POST' && entry.path === '/api/interview-sessions') {
        created = await res.json().catch(() => null);
      }
    });

    const sessionsBefore = await countInterviewSessions();
    await startInterview(page);

    // Builder metadata: Node. Session creation: Spring, HTTP 201.
    const builder = seen.find((r) => r.method === 'GET' && r.path === '/api/quizzes');
    const create = seen.find((r) => r.method === 'POST' && r.path === '/api/interview-sessions');
    expect(builder?.host).toBe(`localhost:${NODE_PORT}`);
    expect(builder?.status).toBe(200);
    expect(create?.host).toBe(`localhost:${SPRING_PORT}`);
    expect(create?.status).toBe(201);

    // No Interview request fell back to Node, and no builder request went to Spring.
    const toNode = seen.filter((r) => r.host === `localhost:${NODE_PORT}`);
    const toSpring = seen.filter((r) => r.host === `localhost:${SPRING_PORT}`);
    expect(toNode.some((r) => r.path.startsWith('/api/interview-sessions'))).toBe(false);
    expect(toSpring.every((r) => r.path.startsWith('/api/interview-sessions') || r.path === '/api/health')).toBe(true);

    // Spring's write landed in THIS run's disposable database …
    expect(await countInterviewSessions()).toBe(sessionsBefore + 1);

    // … and Node reads it back from that same database: the shared-database contract.
    const session = created as { sessionId?: string; sessionToken?: string } | null;
    expect(session?.sessionId).toBeTruthy();
    const viaNode = await request.get(`${NODE_API_BASE_URL}/interview-sessions/${session?.sessionId}`, {
      headers: { authorization: `Bearer ${session?.sessionToken}` }
    });
    expect(viaNode.status()).toBe(200);
    expect(((await viaNode.json()) as { sessionId?: string }).sessionId).toBe(session?.sessionId);

    // Nothing left the machine for a production API.
    expect([...hosts].filter((h) => PRODUCTION_API_HOSTS.some((p) => h.includes(p)))).toEqual([]);
    expect(SPRING_API_BASE_URL).toBe(`http://localhost:${SPRING_PORT}/api`);
  });

  test('the development database is not opened or modified', async ({ page }) => {
    const snapshot = JSON.parse(
      readFileSync(join(E2E_STATE_DIR, 'dev-db-fingerprint.json'), 'utf8')
    ) as DatabaseFingerprint;

    // Create a session, which writes rows — to the temporary database only.
    await startInterview(page);

    expect(sameFingerprint(snapshot, await fingerprintDevDatabase())).toBe(true);
  });
});
