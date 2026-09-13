#!/usr/bin/env node
'use strict';

/**
 * Node/Spring cross-runtime contract-parity suite.
 *
 * Automates what used to be a manual compatibility check: both backends are
 * started for real, pointed at ONE disposable PostgreSQL container seeded
 * with the existing synthetic quiz-bank fixture, and a battery of black-box
 * HTTP scenarios proves they agree on metadata, Topic Quiz receipts/answer
 * checks, Interview Mode session lifecycle, and HTTP/security behavior —
 * while Node remains the production rollback service this migration is
 * measured against (see lib/compare.js).
 *
 * Isolation, by construction:
 *   - Postgres is a locally-built, disposable image (docker/postgres-ssl.
 *     Dockerfile), never pushed anywhere, torn down in `finally` below.
 *   - Every port (Postgres, Node, Spring) is allocated dynamically
 *     (lib/ports.js / Docker's own -P), so concurrent runs on the same host
 *     never collide — and on GitHub Actions each run gets its own VM anyway.
 *   - No .env file is ever read (backend/.env exists for the developer's own
 *     local use and is deliberately never referenced here — every env var
 *     the two processes need is passed explicitly).
 *   - Neon/production credentials are never read: DATABASE_URL/
 *     SPRING_DATASOURCE_* always point at the disposable container.
 *
 * Why Node needs an SSL-enabled Postgres and Spring doesn't: see the top
 * comment in docker/postgres-ssl.Dockerfile — verified directly against a
 * vanilla postgres:18-alpine container before writing that file.
 */

const { spawn, execSync } = require('node:child_process');
const { readdirSync, chmodSync } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const { findFreePort } = require('./lib/ports');
const { waitForHttpOk } = require('./lib/wait');
const { printReport } = require('./lib/report');
const { runMetadataScenario, runTopicQuizScenario } = require('./scenarios');
const { runInterviewScenario } = require('./scenarios-interview');
const { runSecurityScenario, ALLOWED_ORIGIN } = require('./scenarios-security');

const ROOT = path.resolve(__dirname, '..', '..');
const BACKEND_DIR = path.join(ROOT, 'backend');
const SPRING_DIR = path.join(ROOT, 'backend-spring');
const FIXTURE_PATH = path.join(BACKEND_DIR, 'test', 'helpers', 'synthetic-quiz-bank.json');

// Clearly synthetic, >=32 chars, shared by BOTH runtimes so a receipt issued
// by one is verifiable by the other (same HMAC-SHA256 secret).
const RECEIPT_SECRET = 'parity-harness-synthetic-receipt-secret-do-not-use-in-prod';

const RUN_ID = `${Date.now().toString(36)}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
const PG_CONTAINER_NAME = `parity-pg-${RUN_ID}`;
const PG_IMAGE_TAG = 'parity-postgres-ssl:local';
const PG_USER = 'parity';
const PG_PASSWORD = 'parity-disposable-pw';
const PG_DATABASE = 'parity';

const cleanupTasks = [];
// Cleanup failure must be visible AND must not silently turn into a passing
// run — see main()'s use of this flag.
let cleanupFailed = false;
async function runCleanup() {
  // LIFO: tear down in reverse of how things were started.
  while (cleanupTasks.length > 0) {
    const task = cleanupTasks.pop();
    try {
      await task();
    } catch (err) {
      cleanupFailed = true;
      console.error(`[parity] CLEANUP FAILURE (a container or process may be left behind): ${err.message}`);
    }
  }
}

// Every process this script starts is bounded — a hung `docker build`, a
// dependency-resolution stall in `mvnw`, or a wedged import script must
// surface as a real failure instead of hanging the suite (and the CI job)
// forever.
function sh(command, args, opts = {}) {
  const { timeoutMs = 5 * 60_000, ...spawnOpts } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...spawnOpts });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`));
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// Known synthetic values that must never reach CI logs verbatim, even
// though neither is a real secret (see the constants below) — belt and
// suspenders on top of the app's own logging never including them.
function redactKnownSecrets(line) {
  return line.split(PG_PASSWORD).join('[REDACTED]').split(RECEIPT_SECRET).join('[REDACTED]');
}

function spawnLongRunning(name, command, args, opts) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  const prefix = `[${name}] `;
  const pipe = (stream) => {
    stream.setEncoding('utf8');
    let buffered = '';
    stream.on('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) console.log(prefix + redactKnownSecrets(line));
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  return child;
}

async function killProcess(child, name) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const onExit = () => resolve();
    child.once('exit', onExit);
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('exit', resolve);
    } else {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 5000);
    }
    setTimeout(resolve, 8000); // don't hang cleanup forever on a stuck process
  });
  console.log(`[parity] stopped ${name}`);
}

async function waitForPostgres(port) {
  const deadline = Date.now() + 30_000;
  let lastError = null;
  while (Date.now() < deadline) {
    const pool = new Pool({
      host: '127.0.0.1',
      port,
      user: PG_USER,
      password: PG_PASSWORD,
      database: PG_DATABASE,
      connectionTimeoutMillis: 2000
    });
    try {
      await pool.query('SELECT 1');
      await pool.end();
      return;
    } catch (err) {
      lastError = err;
      await pool.end().catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`Postgres never became ready on port ${port}: ${lastError?.message}`);
}

async function main() {
  console.log(`[parity] run id: ${RUN_ID}`);

  // ── 1. Build the disposable SSL-enabled Postgres image (local only, never
  // pushed). Generous timeout: a cold CI runner pulls postgres:18-alpine
  // fresh, no local layer cache to rely on. ──
  await sh('docker', ['build', '-f', path.join('scripts', 'parity', 'docker', 'postgres-ssl.Dockerfile'), '-t', PG_IMAGE_TAG, path.join('scripts', 'parity', 'docker')], { cwd: ROOT, timeoutMs: 8 * 60_000 });

  // ── 2. Start it, with a dynamically-assigned host port ──
  await sh('docker', [
    'run', '-d', '--name', PG_CONTAINER_NAME,
    '-e', `POSTGRES_USER=${PG_USER}`,
    '-e', `POSTGRES_PASSWORD=${PG_PASSWORD}`,
    '-e', `POSTGRES_DB=${PG_DATABASE}`,
    '-p', '127.0.0.1:0:5432',
    PG_IMAGE_TAG
  ], { timeoutMs: 30_000 });
  cleanupTasks.push(() => sh('docker', ['rm', '-f', PG_CONTAINER_NAME], { timeoutMs: 30_000 }));

  const portMapping = execSync(`docker port ${PG_CONTAINER_NAME} 5432`, { timeout: 10_000 }).toString().trim();
  const pgPort = Number(portMapping.split(':').pop());
  console.log(`[parity] disposable Postgres on 127.0.0.1:${pgPort}`);
  await waitForPostgres(pgPort);

  const nodeDatabaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${pgPort}/${PG_DATABASE}`;
  const springDatasourceUrl = `jdbc:postgresql://127.0.0.1:${pgPort}/${PG_DATABASE}`;

  // ── 3. Seed schema + the existing synthetic quiz-bank fixture (one call
  // does both — see backend/scripts/import-quiz-bank.ts). Inherits the full
  // parent environment (safe: no --env-file flag is ever passed, so
  // backend/.env is never read regardless of what else is inherited) with
  // only --database-url overriding where the script connects.
  await sh(
    'node',
    ['--require', 'ts-node/register', path.join('scripts', 'import-quiz-bank.ts'), '--file', FIXTURE_PATH, '--database-url', nodeDatabaseUrl],
    { cwd: BACKEND_DIR }
  );
  console.log('[parity] fixture imported (schema + synthetic quiz-bank data)');

  // ── 4. Start Node, pointed at the disposable database ──
  const nodePort = await findFreePort();
  const nodeChild = spawnLongRunning('node', 'node', ['--require', 'ts-node/register', path.join('src', 'server.ts')], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(nodePort),
      DATABASE_URL: nodeDatabaseUrl,
      ALLOWED_ORIGINS: ALLOWED_ORIGIN,
      TOPIC_QUIZ_RECEIPT_SECRET: RECEIPT_SECRET
    }
  });
  cleanupTasks.push(() => killProcess(nodeChild, 'node'));
  const nodeBase = `http://127.0.0.1:${nodePort}`;
  await waitForHttpOk(`${nodeBase}/api/health`);
  console.log(`[parity] Node ready at ${nodeBase}`);

  // ── 5. Build (skip tests — already covered by backend-spring-ci.yml) and start Spring ──
  // Same cross-platform wrapper choice as scripts/dev.js: on the Linux CI
  // runner, mvnw's own shebang (#!/bin/sh) lets it run directly once the
  // exec bit is set (no bash dependency); on Windows, mvnw.cmd via a shell
  // (Node refuses to spawn a .cmd directly). `clean` first: a fresh CI
  // runner has no stale target/, but a repeated LOCAL run of this same
  // script must not risk picking up a leftover artifact from a previous run.
  const isWindows = process.platform === 'win32';
  if (!isWindows) chmodSync(path.join(SPRING_DIR, 'mvnw'), 0o755);
  // Absolute path on both platforms — a bare "mvnw.cmd" under shell:true
  // is not reliably resolved against `cwd` by cmd.exe (confirmed directly:
  // it reported "not recognized"), so this doesn't rely on PATH/cwd lookup.
  const mvnwPath = path.join(SPRING_DIR, isWindows ? 'mvnw.cmd' : 'mvnw');
  await sh(isWindows ? mvnwPath : `.${path.sep}mvnw`, ['-B', 'clean', '-DskipTests', 'package'], {
    cwd: SPRING_DIR,
    timeoutMs: 10 * 60_000,
    shell: isWindows
  });
  const targetDir = path.join(SPRING_DIR, 'target');
  const jarName = readdirSync(targetDir).find((f) => f.endsWith('.jar') && !f.includes('sources') && !f.includes('javadoc'));
  if (!jarName) throw new Error('Could not find built Spring jar in backend-spring/target');

  const springPort = await findFreePort();
  const springChild = spawnLongRunning('spring', 'java', ['-jar', jarName], {
    cwd: targetDir,
    env: {
      ...process.env,
      PORT: String(springPort),
      SPRING_DATASOURCE_URL: springDatasourceUrl,
      SPRING_DATASOURCE_USERNAME: PG_USER,
      SPRING_DATASOURCE_PASSWORD: PG_PASSWORD,
      TOPIC_QUIZ_RECEIPT_SECRET: RECEIPT_SECRET,
      ALLOWED_ORIGINS: ALLOWED_ORIGIN
    }
  });
  cleanupTasks.push(() => killProcess(springChild, 'spring'));
  const springBase = `http://127.0.0.1:${springPort}`;
  await waitForHttpOk(`${springBase}/api/health`, { timeoutMs: 60_000 });
  console.log(`[parity] Spring ready at ${springBase}`);

  // ── 6. Run every scenario ──
  const fixture = require(FIXTURE_PATH);
  const ctx = { nodeBase, springBase, fixture };

  const results = [];
  results.push(await runMetadataScenario(ctx));
  results.push(await runTopicQuizScenario(ctx));
  results.push(await runInterviewScenario(ctx));
  results.push(await runSecurityScenario(ctx));

  const allPassed = printReport(results);
  return allPassed;
}

let passed = false;
main()
  .then((result) => {
    passed = result;
  })
  .catch((err) => {
    console.error('[parity] FAILED:', err.stack ?? err.message);
    passed = false;
  })
  .finally(async () => {
    await runCleanup();
    // A cleanup failure (a container or process left behind) is itself a
    // real problem — a resource that can collide with a later run — so it
    // must never be masked by an otherwise-passing scenario result.
    if (cleanupFailed) console.error('[parity] exiting non-zero: cleanup did not complete cleanly (see CLEANUP FAILURE above)');
    process.exit(passed && !cleanupFailed ? 0 : 1);
  });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n[parity] ${signal} received — cleaning up`);
    runCleanup().finally(() => process.exit(1));
  });
}
