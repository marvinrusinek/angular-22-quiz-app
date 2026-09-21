/**
 * Turns the run's disposable-database URL into the datasource configuration for
 * the Playwright-controlled Spring Boot process — and refuses anything that is
 * not provably that disposable database.
 *
 * WHY THIS IS A GUARD AND NOT A CONVENIENCE
 *
 * Spring runs with `ddl-auto=validate`, so it cannot alter a schema, but it
 * WRITES: every Interview session, answer and flag an E2E run creates goes
 * through it. Pointed at the developer's real database, a test run would quietly
 * fill it with synthetic sessions. So Spring may only ever be given a database
 * whose name begins with `e2e_`, and this module is the single place that
 * decides — before any Java process exists.
 *
 * It is deliberately pure and offline (no network, no filesystem, no process),
 * so its refusals are unit-tested against the exact function the launcher calls.
 *
 * SECRETS
 *
 * The password is never part of the JDBC URL (Spring takes it as a separate
 * property), and it is defined NON-ENUMERABLE on the result so an accidental
 * `console.log(datasource)` / `JSON.stringify(datasource)` cannot print it. Error
 * messages name the database and host only.
 */

const E2E_PREFIX = 'e2e_';

/** Generated names are `e2e_<base36 stamp>_<pid>_<random>`: lowercase letters, digits, underscores. */
const DATABASE_NAME_PATTERN = /^e2e_[a-z0-9_]+$/;

/** A DNS name. Rejects anything that could smuggle a path, query or second host into the JDBC URL. */
const HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

class SpringDatasourceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SpringDatasourceError';
  }
}

function fail(message) {
  throw new SpringDatasourceError(`refusing to configure Spring: ${message}`);
}

function safeDecode(value, what) {
  try {
    return decodeURIComponent(value);
  } catch {
    return fail(`${what} in the database URL is not valid percent-encoding`);
  }
}

/**
 * @param {unknown} databaseUrl  the run's `postgres://user:pass@host/e2e_...` URL
 * @param {{ expectedName?: string, devDatabaseName?: string }} [options]
 *   expectedName    — when given, the database MUST be exactly this run's database
 *   devDatabaseName — when given, that database is refused outright
 * @returns {{ jdbcUrl: string, username: string, password: string, databaseName: string, host: string }}
 */
function deriveSpringDatasource(databaseUrl, options = {}) {
  const { expectedName, devDatabaseName } = options;

  if (typeof databaseUrl !== 'string' || databaseUrl.trim().length === 0) {
    fail('the E2E database URL is missing');
  }

  let parsed;
  try {
    parsed = new URL(databaseUrl.trim());
  } catch {
    return fail('the E2E database URL is malformed');
  }

  if (!/^postgres(ql)?:$/i.test(parsed.protocol)) {
    fail('the E2E database URL is not a postgres:// URL');
  }

  const host = parsed.hostname;
  if (host.length === 0 || !HOST_PATTERN.test(host)) {
    fail('the E2E database URL has a missing or unsupported host');
  }

  if (parsed.port !== '') {
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail('the E2E database URL has an invalid port');
  }

  // The name lives in the PATH and nowhere else — exactly one segment.
  const rawName = parsed.pathname.replace(/^\//, '');
  if (rawName.length === 0 || rawName.includes('/')) {
    fail('the E2E database URL does not name exactly one database');
  }
  const databaseName = safeDecode(rawName, 'the database name');

  if (typeof devDatabaseName === 'string' && devDatabaseName.length > 0 && databaseName === devDatabaseName) {
    fail(`"${databaseName}" is the development database`);
  }
  if (!databaseName.startsWith(E2E_PREFIX) || !DATABASE_NAME_PATTERN.test(databaseName)) {
    fail(`"${databaseName}" is not an ${E2E_PREFIX}* throwaway database`);
  }
  if (typeof expectedName === 'string' && expectedName.length > 0 && databaseName !== expectedName) {
    fail(`"${databaseName}" is not this run's database "${expectedName}"`);
  }

  const username = safeDecode(parsed.username, 'the user name');
  const password = safeDecode(parsed.password, 'the password');
  if (username.length === 0) fail('the E2E database URL has no user name');
  if (password.length === 0) fail('the E2E database URL has no password');

  const hostAndPort = parsed.port === '' ? host : `${host}:${parsed.port}`;

  // sslmode=require is the same posture Node has for Neon: TLS required, no
  // certificate-chain validation (see application.properties). It is set here
  // rather than copied from the source URL, so the result never depends on what
  // extra query parameters (channel_binding, sslmode=…) the source carried.
  const result = {
    jdbcUrl: `jdbc:postgresql://${hostAndPort}/${databaseName}?sslmode=require`,
    username,
    databaseName,
    host
  };
  Object.defineProperty(result, 'password', { value: password, enumerable: false });
  return result;
}

/** Safe to print: names the database and host, never a credential. */
function describeDatasource(datasource) {
  return `${datasource.databaseName} on ${datasource.host}`;
}

/**
 * Environment variables Spring (or the JVM) could take configuration from. They
 * are REMOVED from the inherited environment before the explicit values are set,
 * so a `SPRING_DATASOURCE_URL` exported in the developer's shell for their own
 * Spring instance can never reach the E2E one — not even as a fallback.
 */
const STRIPPED_ENV_PATTERNS = [
  /^SPRING_/i,             // datasource, profiles, config locations, SPRING_APPLICATION_JSON, JPA…
  /^SERVER_/i,             // SERVER_PORT and friends
  /^MANAGEMENT_/i,         // actuator exposure
  /^CORS_/i,               // relaxed binding for cors.allowed-origins
  /^TOPICQUIZ/i,           // relaxed binding for topicquiz.receipt-secret
  /^TOPIC_QUIZ_/i,
  /^ALLOWED_ORIGINS$/i,
  /^PORT$/i,
  /^DATABASE_URL$/i,       // Node's variable; Spring must not see the dev URL under any name
  /^JAVA_TOOL_OPTIONS$/i,  // can inject -D system properties that beat every property file
  /^_JAVA_OPTIONS$/i,
  /^JDK_JAVA_OPTIONS$/i
];

/**
 * A synthetic value, never a real secret. Long enough for TopicQuizReceiptSecret's
 * own minimum. Topic Quiz receipts are issued and checked by Node in E2E, so this
 * only has to be present and valid — Spring refuses to start without one.
 */
const E2E_RECEIPT_SECRET = 'e2e-harness-synthetic-receipt-secret-not-for-production';

/**
 * @param {NodeJS.ProcessEnv} baseEnv  usually process.env
 * @param {ReturnType<typeof deriveSpringDatasource>} datasource
 * @param {{ port: number, allowedOrigins: readonly string[] }} options
 */
function buildSpringEnv(baseEnv, datasource, options) {
  const { port, allowedOrigins } = options;
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('the Spring port is invalid');
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) fail('no allowed origins were supplied');

  const env = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (STRIPPED_ENV_PATTERNS.some((pattern) => pattern.test(key))) continue;
    env[key] = value;
  }

  env.PORT = String(port);
  env.SPRING_DATASOURCE_URL = datasource.jdbcUrl;
  env.SPRING_DATASOURCE_USERNAME = datasource.username;
  env.SPRING_DATASOURCE_PASSWORD = datasource.password;
  env.TOPIC_QUIZ_RECEIPT_SECRET = E2E_RECEIPT_SECRET;
  env.ALLOWED_ORIGINS = allowedOrigins.join(',');
  // Already the default in application.properties. Stated again so Spring can
  // never become a second migration owner even if that file changes: Node owns
  // the schema.
  env.SPRING_JPA_HIBERNATE_DDL_AUTO = 'validate';
  return env;
}

/**
 * The launcher's whole decision, in one pure function: environment in, either a
 * refusal or the datasource out. `E2E_DATABASE_URL` and `E2E_DATABASE_NAME` are
 * supplied EXPLICITLY by playwright.config.ts — nothing is read from `.env`,
 * from DATABASE_URL, or from a default.
 *
 * @param {NodeJS.ProcessEnv} env
 */
function resolveLauncherDatasource(env) {
  const expectedName = (env.E2E_DATABASE_NAME || '').trim();
  if (expectedName.length === 0) fail('E2E_DATABASE_NAME is not set');

  return deriveSpringDatasource(env.E2E_DATABASE_URL, {
    expectedName,
    devDatabaseName: (env.E2E_DEV_DATABASE_NAME || '').trim() || undefined
  });
}

/** Replaces every secret (and any user:password@ pair in a URL) in a log line. */
function makeRedactor(secrets) {
  const needles = secrets.filter((s) => typeof s === 'string' && s.length >= 6);
  return (line) => {
    let out = String(line).replace(/(:\/\/[^\s:/@]+):[^\s@/]+@/g, '$1:[REDACTED]@');
    for (const secret of needles) out = out.split(secret).join('[REDACTED]');
    return out;
  };
}

module.exports = {
  E2E_PREFIX,
  E2E_RECEIPT_SECRET,
  STRIPPED_ENV_PATTERNS,
  SpringDatasourceError,
  deriveSpringDatasource,
  describeDatasource,
  buildSpringEnv,
  resolveLauncherDatasource,
  makeRedactor
};
