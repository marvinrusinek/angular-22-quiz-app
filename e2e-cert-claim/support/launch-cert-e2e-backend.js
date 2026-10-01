/**
 * TEST-ONLY backend launcher for the certificate-claims browser suite.
 *
 * This is NOT server.ts and is never invoked by it, by any deployment
 * config (Dockerfile, render.yaml), or by any production code path — it
 * exists solely so Playwright can drive a real, running Node process over
 * real HTTP, the same way a real browser's HttpClient would, rather than
 * only exercising requests in-process (as the Jest supertest suite does).
 *
 * WHY A SEPARATE LAUNCHER AND NOT server.ts ITSELF: two things here must
 * NEVER exist in a production process:
 *   1. a debug channel that returns whatever the fake email sender
 *      "sent" (including raw, unhashed verification tokens) — the whole
 *      design elsewhere in this feature exists specifically to keep a raw
 *      token out of logs, storage and responses; exposing it over HTTP
 *      anywhere a real deployment could reach would undo that.
 *   2. an endpoint that mints an already-expired token on demand, for
 *      testing the expired-link path without waiting 24 hours for real.
 *
 * DEFENSE IN DEPTH, though this script is never deployed:
 *   - refuses to start under NODE_ENV=production;
 *   - the debug channel binds to 127.0.0.1 ONLY, on its own port, entirely
 *     separate from the real app's own router (:3000) — never mixed into
 *     createApp's own middleware, so it can never affect what the suite is
 *     actually testing against;
 *   - every debug route lives under the unmistakable path prefix
 *     `/__test_debug__/`.
 *
 * Run standalone: `node e2e-cert-claim/support/launch-cert-e2e-backend.js`
 * (after ensure-cert-e2e-database.js). Also started automatically by
 * playwright.cert-e2e.config.ts's webServer entry.
 */
const http = require('node:http');
const path = require('node:path');

// ts-node is a devDependency of backend/, not of the repo root. Node's
// require() resolves a bare specifier by walking up from THIS FILE's own
// directory, which has no path through backend/node_modules — so a plain
// `require('ts-node/register')` fails regardless of the process's cwd.
// Resolving the full path directly sidesteps that. TS_NODE_PROJECT must
// ALSO be forced explicitly: left to its own search, ts-node resolves
// backend/'s tsconfig.json relative to this file's location too, which
// finds the repo ROOT's tsconfig instead (Angular's own, a different
// module target) — confirmed directly: without this, requiring app.ts
// failed with ERR_MODULE_NOT_FOUND on an ordinary extensionless CJS
// require, exactly what happens under the wrong `module` setting.
process.env.TS_NODE_PROJECT = path.join(__dirname, '..', '..', 'backend', 'tsconfig.json');
require(path.join(__dirname, '..', '..', 'backend', 'node_modules', 'ts-node', 'register'));

const { createApp } = require(path.resolve(__dirname, '..', '..', 'backend', 'src', 'app.ts'));
const { loadConfig } = require(path.resolve(__dirname, '..', '..', 'backend', 'src', 'config.ts'));
const { openDatabase } = require(path.resolve(__dirname, '..', '..', 'backend', 'src', 'db', 'database.ts'));
const { migrate } = require(path.resolve(__dirname, '..', '..', 'backend', 'src', 'db', 'migrate.ts'));
const { createQuizRepositoryFromDatabase } = require(path.resolve(__dirname, '..', '..', 'backend', 'src', 'quiz', 'quiz.repository.ts'));
const { createCertificateClaimRepository } = require(path.resolve(__dirname, '..', '..', 'backend', 'src', 'certificate', 'certificate-claim.repository.ts'));
const { CertificateClaimService } = require(path.resolve(__dirname, '..', '..', 'backend', 'src', 'certificate', 'certificate-claim.service.ts'));
const { NotificationDispatcher } = require(path.resolve(__dirname, '..', '..', 'backend', 'src', 'certificate', 'certificate-notification-dispatcher.ts'));
const { InMemoryEmailSender } = require(path.resolve(__dirname, '..', '..', 'backend', 'src', 'certificate', 'email-sender.ts'));
const { parseOutboxEncryptionKey } = require(path.resolve(__dirname, '..', '..', 'backend', 'src', 'certificate', 'certificate-outbox-crypto.ts'));
const { generateToken } = require(path.resolve(__dirname, '..', '..', 'backend', 'src', 'certificate', 'certificate-token.ts'));

const { NODE_PORT, DEBUG_PORT, DB_URL, ANGULAR_URL } = require('./cert-e2e-backends');

if ((process.env.NODE_ENV || '').trim() === 'production') {
  console.error('[cert-e2e-backend] refusing to start: NODE_ENV=production. This launcher is test-only.');
  process.exit(1);
}

// A fixed, test-only key — never read from a real secret store, never
// reused by any production config. Exactly 32 bytes of 0xAB, deliberately
// recognizable as a placeholder rather than a plausible-looking fake.
const TEST_OUTBOX_KEY = parseOutboxEncryptionKey('ab'.repeat(32));

(async () => {
  const database = openDatabase({ databaseUrl: DB_URL });
  await migrate(database);
  const quizRepository = await createQuizRepositoryFromDatabase(database);

  const repository = createCertificateClaimRepository(database);
  const emailSender = new InMemoryEmailSender();
  const sentLog = [];
  const originalSend = emailSender.send.bind(emailSender);
  emailSender.send = async (message) => {
    const result = await originalSend(message);
    sentLog.push({ at: new Date().toISOString(), message, result });
    return result;
  };

  const now = () => Date.now();
  const dispatcher = new NotificationDispatcher({
    repository,
    emailSender,
    now,
    verificationTokenTtlMs: 24 * 60 * 60_000,
    buildVerificationUrl: (t) => `${ANGULAR_URL}/interview/certificate/verify#token=${t}`,
    ownerNotificationEmail: 'owner@example.test',
    outboxEncryptionKey: TEST_OUTBOX_KEY
  });
  const certificateClaimService = new CertificateClaimService({
    repository, dispatcher, now, retrievalTokenTtlMs: 90 * 24 * 60 * 60_000
  });

  const config = loadConfig({ ALLOWED_ORIGINS: ANGULAR_URL });
  const app = createApp(config, { quizRepository, certificateClaimService });

  // Bound on BOTH loopback families, never 0.0.0.0: `localhost` resolves to
  // ::1 first on this machine (confirmed directly — a health check against
  // 127.0.0.1 alone hung to its full timeout even with the server genuinely
  // up), so binding only 127.0.0.1 would make the server unreachable by its
  // own advertised URL. Two explicit server instances rather than a bare
  // `.listen(port)` (which would also accept 0.0.0.0) — loopback-only stays
  // the deliberate choice, just satisfied on both address families.
  const mainServerV4 = http.createServer(app).listen(NODE_PORT, '127.0.0.1');
  const mainServerV6 = http.createServer(app).listen(NODE_PORT, '::1', () =>
    console.log(`[cert-e2e-backend] Node backend listening on localhost:${NODE_PORT} (loopback only)`)
  );
  const pollTimer = setInterval(() => { dispatcher.runOnce().catch(() => {}); }, 1500);

  const debugHandler = async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${DEBUG_PORT}`);
    res.setHeader('Access-Control-Allow-Origin', ANGULAR_URL);

    if (url.pathname === '/__test_debug__/sent-log') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(sentLog));
      return;
    }
    if (url.pathname === '/__test_debug__/mint-expired-token') {
      const email = url.searchParams.get('email') ?? '';
      const pending = await repository.findPendingClaimByEmail(email);
      if (!pending) { res.statusCode = 404; res.end('no pending claim for that email'); return; }
      const { rawToken, tokenHash } = generateToken();
      await database.query(
        'INSERT INTO certificate_verification_tokens (token_hash, claim_id, created_at, expires_at) VALUES ($1,$2,$3,$4)',
        [tokenHash, pending.id, now() - 2000, now() - 1000]
      );
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ rawToken }));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  };
  // Loopback ONLY, both address families — never 0.0.0.0. This channel must
  // not be reachable from anywhere but this same machine's loopback
  // interface (see this file's own top doc comment for why it must never
  // exist in a production process at all).
  const debugServerV4 = http.createServer(debugHandler).listen(DEBUG_PORT, '127.0.0.1');
  const debugServerV6 = http.createServer(debugHandler).listen(DEBUG_PORT, '::1', () =>
    console.log(`[cert-e2e-backend] debug channel listening on localhost:${DEBUG_PORT} (loopback only)`)
  );

  const shutdown = () => {
    clearInterval(pollTimer);
    for (const server of [mainServerV4, mainServerV6, debugServerV4, debugServerV6]) server.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
})().catch((err) => {
  console.error('[cert-e2e-backend] failed to start:', err);
  process.exit(1);
});
