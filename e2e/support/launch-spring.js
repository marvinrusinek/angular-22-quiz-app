#!/usr/bin/env node
/**
 * Starts the Playwright-CONTROLLED Spring Boot backend (Interview Mode).
 *
 *   node e2e/support/launch-spring.js                 start on the fixed port (8080)
 *   node e2e/support/launch-spring.js --check-only    validate the datasource, start nothing
 *   node e2e/support/launch-spring.js --port=NNNN     STANDALONE PROOFS ONLY — Playwright never passes it
 *
 * playwright.config.ts lists this AFTER the Node backend, and Playwright starts
 * its servers strictly in order. By the time this runs, Node has created the
 * disposable `e2e_*` database, migrated it and seeded the synthetic fixture bank
 * — Node stays the ONLY schema author. Spring then attaches to that same
 * database and only VALIDATES it (`ddl-auto=validate`), exactly like production
 * where both backends share one Postgres.
 *
 * SAFETY, in the order it happens:
 *
 *   1. The datasource is derived from the run's E2E_DATABASE_URL and refused
 *      unless it names THIS run's `e2e_*` database (spring-datasource.js). This
 *      is checked before Maven or Java is even looked for. Nothing here reads
 *      `.env`, DATABASE_URL or any default.
 *   2. Spring's environment is built from scratch: every inherited SPRING_*,
 *      SERVER_*, PORT, DATABASE_URL, JVM-options variable is removed and the
 *      critical settings are set explicitly, so a development datasource
 *      exported in the shell can never reach this process.
 *   3. The jar is built OUT OF TREE — from a copy of the sources under
 *      `.e2e-db/`, never inside `backend-spring/`. The developer's own Spring
 *      instance runs from `backend-spring/target`; `clean`, `package` or any
 *      other write there could delete or lock files it is using. This script
 *      never touches that directory.
 *   4. Java runs with its working directory in `.e2e-db/spring-run`, so no
 *      `application.properties` / `config/` next to the source can be picked up.
 *   5. Output is redacted; the password and secrets never reach a log.
 */
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { ANGULAR_ORIGINS, SPRING_PORT } = require('./e2e-backends');
const {
  E2E_RECEIPT_SECRET,
  SpringDatasourceError,
  buildSpringEnv,
  describeDatasource,
  makeRedactor,
  resolveLauncherDatasource
} = require('./spring-datasource');

const ROOT = path.resolve(__dirname, '..', '..');
const SPRING_SOURCE = path.join(ROOT, 'backend-spring');
const STATE_DIR = path.join(ROOT, '.e2e-db');
const BUILD_ROOT = path.join(STATE_DIR, 'spring-build');
const JAR_CACHE = path.join(STATE_DIR, 'spring-jar');
const RUN_DIR = path.join(STATE_DIR, 'spring-run');

const BUILD_TIMEOUT_MS = 10 * 60_000;

const log = (message) => console.log(`[e2e-spring] ${message}`);

/** Refuses to write, copy into or delete anything that is not inside `.e2e-db/`. */
function assertInsideState(target) {
  const resolved = path.resolve(target);
  const inside = resolved === STATE_DIR || resolved.startsWith(STATE_DIR + path.sep);
  const insideSpringSource = resolved === SPRING_SOURCE || resolved.startsWith(SPRING_SOURCE + path.sep);
  if (!inside || insideSpringSource) {
    throw new Error(`refusing to touch "${resolved}" — the launcher only ever writes under ${STATE_DIR}`);
  }
  return resolved;
}

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full, base) : [path.relative(base, full).split(path.sep).join('/')];
  });
}

/** What the build depends on: the POM, the wrapper's Maven version and every source file. */
function sourceHash() {
  const hash = crypto.createHash('sha1');
  const inputs = ['pom.xml', '.mvn/wrapper/maven-wrapper.properties'];
  for (const rel of inputs) {
    hash.update(`${rel}\0`).update(fs.readFileSync(path.join(SPRING_SOURCE, rel)));
  }
  const srcDir = path.join(SPRING_SOURCE, 'src');
  for (const rel of listFiles(srcDir).sort()) {
    hash.update(`src/${rel}\0`).update(fs.readFileSync(path.join(srcDir, rel)));
  }
  return hash.digest('hex').slice(0, 12);
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

function runMaven(cwd) {
  const isWindows = process.platform === 'win32';
  const wrapper = path.join(cwd, isWindows ? 'mvnw.cmd' : 'mvnw');
  if (!isWindows) fs.chmodSync(wrapper, 0o755);
  // Tests are skipped AND not compiled: the E2E jar needs the application only.
  const result = spawnSync(wrapper, ['-B', '-q', '-Dmaven.test.skip=true', 'package'], {
    cwd,
    stdio: 'inherit',
    shell: isWindows,
    timeout: BUILD_TIMEOUT_MS
  });
  if (result.status !== 0) {
    throw new Error(`the Spring build failed (exit ${result.status ?? result.signal}) — see the Maven output above`);
  }
}

/** The jar for the CURRENT sources, built out of tree the first time and cached by content hash. */
function ensureJar() {
  const hash = sourceHash();
  const cached = path.join(assertInsideState(path.join(JAR_CACHE, hash)), 'app.jar');
  if (fs.existsSync(cached)) {
    log(`using the cached jar for the current sources (${hash})`);
    return cached;
  }

  const buildDir = assertInsideState(path.join(BUILD_ROOT, hash));
  log(`building the Spring jar out of tree (${hash}); this is a one-off per source change`);
  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(buildDir, { recursive: true });
  for (const name of ['pom.xml', 'mvnw', 'mvnw.cmd']) {
    fs.copyFileSync(path.join(SPRING_SOURCE, name), path.join(buildDir, name));
  }
  copyTree(path.join(SPRING_SOURCE, '.mvn'), path.join(buildDir, '.mvn'));
  copyTree(path.join(SPRING_SOURCE, 'src'), path.join(buildDir, 'src'));

  runMaven(buildDir);

  const targetDir = path.join(buildDir, 'target');
  const jar = fs
    .readdirSync(targetDir)
    .find((f) => f.endsWith('.jar') && !f.endsWith('.jar.original') && !/(sources|javadoc)/.test(f));
  if (!jar) throw new Error('the build produced no runnable jar');

  fs.mkdirSync(path.dirname(cached), { recursive: true });
  fs.copyFileSync(path.join(targetDir, jar), cached);
  fs.rmSync(buildDir, { recursive: true, force: true });
  log('build complete');
  return cached;
}

function javaBinary() {
  const home = process.env.JAVA_HOME;
  if (home) {
    const candidate = path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'java';
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

function parseArgs(argv) {
  const args = { checkOnly: false, port: SPRING_PORT };
  for (const arg of argv) {
    if (arg === '--check-only') args.checkOnly = true;
    else if (arg.startsWith('--port=')) args.port = Number(arg.slice('--port='.length));
    else throw new Error(`unknown argument "${arg}"`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  // 1. The guard. Nothing below runs unless the target is provably this run's e2e_* database.
  const datasource = resolveLauncherDatasource(process.env);
  const env = buildSpringEnv(process.env, datasource, { port: args.port, allowedOrigins: ANGULAR_ORIGINS });
  log(`datasource accepted: ${describeDatasource(datasource)}; port ${args.port}; ddl-auto=validate`);

  if (args.checkOnly) {
    log('--check-only: nothing was built or started');
    return;
  }

  // 3. Out-of-tree jar.
  const jar = ensureJar();

  // 4/5. Run it, redacted, from a directory with no configuration files.
  fs.mkdirSync(assertInsideState(RUN_DIR), { recursive: true });
  const redact = makeRedactor([datasource.password, datasource.username, E2E_RECEIPT_SECRET]);
  const child = spawn(javaBinary(), ['-XX:TieredStopAtLevel=1', '-jar', jar], {
    cwd: RUN_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const pipe = (stream, sink) => {
    stream.setEncoding('utf8');
    let buffered = '';
    stream.on('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) sink(`[spring] ${redact(line.replace(/\r$/, ''))}\n`);
    });
  };
  pipe(child.stdout, (text) => process.stdout.write(text));
  pipe(child.stderr, (text) => process.stderr.write(text));

  child.on('error', (err) => {
    console.error(`[e2e-spring] could not start Java: ${err.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    log(`Spring exited (${code ?? signal})`);
    process.exit(code ?? 0);
  });

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
    process.on(signal, () => {
      killTree(child);
      setTimeout(() => process.exit(0), 300);
    });
  }
  process.on('exit', () => killTree(child));
}

try {
  main();
} catch (err) {
  // Datasource refusals are the EXPECTED failure mode; anything else is reported plainly.
  const label = err instanceof SpringDatasourceError ? '' : 'unexpected error: ';
  console.error(`[e2e-spring] ${label}${err.message}`);
  process.exit(1);
}
