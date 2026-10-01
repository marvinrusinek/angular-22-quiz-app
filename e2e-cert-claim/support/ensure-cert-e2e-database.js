/**
 * Idempotent provisioning for the certificate-claims browser suite's
 * isolated Postgres — a Docker container, never a developer's own database
 * (Neon or local). Mirrors e2e/support/ensure-e2e-database.js's ROLE for the
 * main harness, but a genuinely separate, disposable container rather than a
 * throwaway database on a shared server: this suite needs nothing from the
 * developer's own Postgres at all, so it asks for nothing from it.
 *
 * WHY A HAND-ROLLED SELF-SIGNED CERT: openDatabase() (backend/src/db/
 * database.ts) hard-codes `ssl: { rejectUnauthorized: false }` for every
 * connection, because the real deployment target (Neon) requires TLS. A
 * vanilla `postgres:*-alpine` image has no TLS configured at all, so without
 * this step the backend cannot open a pool against it — confirmed directly
 * while building this suite. The certificate is generated INSIDE the
 * container (via a one-time `apk add openssl`), never copied in from the
 * host, specifically to avoid the Windows/Git-Bash path-mangling that makes
 * `docker cp` with POSIX paths unreliable there.
 *
 * Run standalone: `node e2e-cert-claim/support/ensure-cert-e2e-database.js`
 * Also invoked automatically by playwright.cert-e2e.config.ts's globalSetup.
 *
 * Requires Docker Desktop (or an equivalent local Docker daemon) running.
 */
const { execSync, execFileSync } = require('node:child_process');
const net = require('node:net');

const { DB_CONTAINER_NAME, DB_NAME, DB_PORT, DB_URL, NODE_PORT } = require('./cert-e2e-backends');

/**
 * FAIL CLOSED if :3000 is already taken — it could be a developer's own
 * Node backend, pointed at their real database. Mirrors
 * e2e/support/preflight-ports.js's same check for the main harness. Runs
 * here (globalSetup), which Playwright guarantees completes before any
 * webServer entry starts, so this suite never even attempts to bind a
 * second process to an occupied port.
 */
function assertNodePortFree() {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port: NODE_PORT, host: '127.0.0.1' }).setTimeout(700);
    socket.on('connect', () => {
      socket.destroy();
      reject(new Error(
        `[cert-e2e-preflight] :${NODE_PORT} is already in use — this suite needs to own it ` +
        `(the app's dev build hard-codes this as its Node API origin). If that is your own ` +
        `\`npm run dev\` backend, stop it first: this suite must not send claim-form traffic ` +
        `to your real database.`
      ));
    });
    socket.on('timeout', () => { socket.destroy(); resolve(); });
    socket.on('error', () => resolve());
  });
}

const PG_IMAGE = 'postgres:18-alpine';
const PGDATA = '/var/lib/postgresql/18/docker'; // this image's actual data directory — NOT /var/lib/postgresql/data

function sh(cmd, opts = {}) {
  return execSync(cmd, { stdio: opts.quiet ? 'pipe' : 'inherit', encoding: 'utf8', ...opts });
}

function dockerAvailable() {
  try {
    execSync('docker info', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function containerStatus() {
  try {
    const out = execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', DB_CONTAINER_NAME], { stdio: 'pipe', encoding: 'utf8' });
    return out.trim() === 'true' ? 'running' : 'stopped';
  } catch {
    return 'absent';
  }
}

function waitForReady(timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      execFileSync('docker', ['exec', DB_CONTAINER_NAME, 'pg_isready', '-U', 'postgres'], { stdio: 'pipe' });
      return;
    } catch {
      // not ready yet
    }
  }
  throw new Error(`[cert-e2e-db] ${DB_CONTAINER_NAME} did not become ready within ${timeoutMs}ms`);
}

function createAndConfigure() {
  console.log(`[cert-e2e-db] creating ${DB_CONTAINER_NAME} on :${DB_PORT}`);
  sh(
    `docker run -d --name ${DB_CONTAINER_NAME} ` +
    `-e POSTGRES_PASSWORD=cert_e2e_local_only -e POSTGRES_DB=${DB_NAME} ` +
    `-p ${DB_PORT}:5432 ${PG_IMAGE}`
  );
  waitForReady();

  console.log('[cert-e2e-db] enabling TLS (self-signed, generated in-container)');
  sh(`docker exec -u root ${DB_CONTAINER_NAME} apk add --no-cache openssl`, { quiet: true });
  sh(
    `docker exec -u root ${DB_CONTAINER_NAME} sh -c "` +
    `cd ${PGDATA} && ` +
    `openssl req -new -x509 -days 3650 -nodes -out server.crt -keyout server.key -subj '/CN=localhost' && ` +
    `chown postgres:postgres server.crt server.key && chmod 600 server.key && chmod 644 server.crt"`,
    { quiet: true }
  );
  sh(`docker exec ${DB_CONTAINER_NAME} psql -U postgres -c "ALTER SYSTEM SET ssl = on;"`, { quiet: true });
  sh(`docker restart ${DB_CONTAINER_NAME}`, { quiet: true });
  waitForReady();
  console.log('[cert-e2e-db] TLS enabled, container ready');
}

function migrateAndSeed() {
  console.log('[cert-e2e-db] migrating + seeding the synthetic quiz bank');
  execFileSync(
    process.execPath,
    [
      '--require', 'ts-node/register',
      'scripts/import-quiz-bank.ts',
      '--file', './test/helpers/synthetic-quiz-bank.json',
      '--database-url', DB_URL
    ],
    { cwd: require('node:path').resolve(__dirname, '..', '..', 'backend'), stdio: 'inherit' }
  );
}

async function main() {
  await assertNodePortFree();

  if (!dockerAvailable()) {
    console.error('[cert-e2e-db] Docker is not available (daemon not running?). Start Docker Desktop and try again.');
    process.exit(1);
  }

  const status = containerStatus();
  if (status === 'running') {
    console.log(`[cert-e2e-db] reusing already-running ${DB_CONTAINER_NAME}`);
  } else {
    if (status === 'stopped') sh(`docker rm -f ${DB_CONTAINER_NAME}`, { quiet: true });
    createAndConfigure();
  }

  migrateAndSeed();
  console.log(`[cert-e2e-db] ready: ${DB_URL.replace(/:[^:@/]+@/, ':***@')}`);
}

// Playwright's globalSetup requires the module itself to be a callable
// function (or `.default`) — exported directly, not nested, so it works
// both as a CLI entry point and as Playwright's globalSetup hook.
if (require.main === module) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
module.exports = main;
