/**
 * Typed, validated configuration.
 *
 * `loadConfig` is a PURE function of an env-like record so tests can exercise
 * every branch without mutating `process.env`. It fails fast: a misconfigured
 * server that starts is worse than one that refuses to, because this process
 * holds the answer key.
 */

export type NodeEnv = 'development' | 'test' | 'production';

export interface AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly isProduction: boolean;
  readonly port: number;
  /** Exact origins allowed to call the API. Never a wildcard in production. */
  readonly allowedOrigins: readonly string[];
  /**
   * Postgres connection string for assessment sessions.
   *
   * REQUIRED in production and validated at startup: a server that boots
   * without a database would accept interviews it cannot store.
   */
  readonly databaseUrl: string;
  /**
   * HMAC key for Topic Quiz attempt receipts.
   *
   * REQUIRED in production. A weak or absent key would let a client forge its
   * own deadline, and an expired receipt authorizes an answer reveal — so this
   * is answer-key protection, not a nicety.
   */
  readonly topicQuizReceiptSecret: string;
}

/** Long enough that guessing is hopeless; short enough to be typeable. */
export const MIN_RECEIPT_SECRET_LENGTH = 32;

/**
 * A FIXED, PUBLIC development key.
 *
 * Deliberately obvious rather than random: a random per-boot key would
 * invalidate every receipt on restart and make local work confusing, and a
 * *plausible-looking* constant might get copied into production. This one
 * announces what it is.
 */
export const DEV_RECEIPT_SECRET = 'dev-only-insecure-topic-quiz-receipt-secret-000';

export class ConfigError extends Error {
  public override readonly name = 'ConfigError';
}

const VALID_ENVS: readonly NodeEnv[] = ['development', 'test', 'production'];

const DEFAULT_DEV_ORIGINS: readonly string[] = [
  'http://localhost:4200',
  'http://127.0.0.1:4200'
];

function parseNodeEnv(raw: string | undefined): NodeEnv {
  const value = (raw ?? 'development').trim();
  if (!VALID_ENVS.includes(value as NodeEnv)) {
    throw new ConfigError(
      `NODE_ENV must be one of ${VALID_ENVS.join(', ')} — received "${value}"`
    );
  }
  return value as NodeEnv;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 3000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be an integer 1-65535 — received "${raw}"`);
  }
  return port;
}

/**
 * Origins are an explicit allow-list. A wildcard is rejected outright rather
 * than downgraded with a warning: the frontend is hosted on a known origin, so
 * a wildcard here is always a mistake, and silently accepting one would defeat
 * the point of restricting the API at all.
 */
function parseAllowedOrigins(raw: string | undefined, isProduction: boolean): readonly string[] {
  const entries = (raw ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  if (entries.includes('*')) {
    throw new ConfigError('ALLOWED_ORIGINS must not contain "*" — list exact origins');
  }

  if (entries.length === 0) {
    if (isProduction) {
      throw new ConfigError('ALLOWED_ORIGINS is required in production');
    }
    return DEFAULT_DEV_ORIGINS;
  }

  for (const origin of entries) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new ConfigError(`ALLOWED_ORIGINS entry is not a valid URL: "${origin}"`);
    }
    // An Origin header is scheme + host + port only; a path would never match.
    if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
      throw new ConfigError(
        `ALLOWED_ORIGINS entry must be scheme://host[:port] with no path: "${origin}"`
      );
    }
    if (isProduction && parsed.protocol !== 'https:') {
      throw new ConfigError(`ALLOWED_ORIGINS must use https in production: "${origin}"`);
    }
  }

  return entries;
}

/**
 * The connection string is REQUIRED in production. In development it may be
 * omitted, and the server then fails when it tries to connect rather than
 * pretending to be configured.
 */
function parseDatabaseUrl(raw: string | undefined, isProduction: boolean): string {
  const value = (raw ?? '').trim();

  if (value.length === 0) {
    if (isProduction) throw new ConfigError('DATABASE_URL is required in production');
    return '';
  }
  if (!/^postgres(ql)?:\/\//i.test(value)) {
    throw new ConfigError('DATABASE_URL must be a postgres:// connection string');
  }
  return value;
}

/**
 * The receipt signing key. FAILS CLOSED in production.
 *
 * Outside production an omitted key falls back to a clearly-labelled
 * development constant, so `npm run dev` and the test suite work with no setup.
 * That fallback is scoped to non-production ONLY — a production server with no
 * key refuses to start rather than signing with something guessable.
 *
 * The VALUE is never returned in an error message or logged anywhere.
 */
function parseReceiptSecret(raw: string | undefined, isProduction: boolean): string {
  const value = (raw ?? '').trim();

  if (value.length === 0) {
    if (isProduction) {
      throw new ConfigError('TOPIC_QUIZ_RECEIPT_SECRET is required in production');
    }
    return DEV_RECEIPT_SECRET;
  }

  if (value.length < MIN_RECEIPT_SECRET_LENGTH) {
    // Reports the REQUIRED length, never the supplied value or its actual
    // length — the latter would narrow a brute-force search.
    throw new ConfigError(
      `TOPIC_QUIZ_RECEIPT_SECRET must be at least ${MIN_RECEIPT_SECRET_LENGTH} characters`
    );
  }

  if (isProduction && value === DEV_RECEIPT_SECRET) {
    throw new ConfigError(
      'TOPIC_QUIZ_RECEIPT_SECRET must not be the development default in production'
    );
  }

  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = parseNodeEnv(env['NODE_ENV']);
  const isProduction = nodeEnv === 'production';

  return {
    nodeEnv,
    isProduction,
    port: parsePort(env['PORT']),
    allowedOrigins: parseAllowedOrigins(env['ALLOWED_ORIGINS'], isProduction),
    databaseUrl: parseDatabaseUrl(env['DATABASE_URL'], isProduction),
    topicQuizReceiptSecret: parseReceiptSecret(env['TOPIC_QUIZ_RECEIPT_SECRET'], isProduction)
  };
}
