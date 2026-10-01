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

  /**
   * The certificate-claim feature (email-verified certificate issuance).
   * DISABLED unless explicitly turned on — see parseCertificateClaims'
   * own doc comment for why every other field here is validated ONLY
   * when `enabled` is true.
   */
  readonly certificateClaims: CertificateClaimsConfig;
}

export type CertificateSmtpTlsMode = 'starttls' | 'tls';

/** No "insecure"/"none" tlsMode value exists in this type at all — see smtp-email-sender.ts. */
export interface CertificateSmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly tlsMode: CertificateSmtpTlsMode;
  readonly username: string;
  /** NEVER logged, NEVER included in a ConfigError message — see parseCertificateClaims' own care around this. */
  readonly password: string;
}

export type CertificateClaimsConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly emailFromAddress: string;
      readonly ownerNotificationEmail: string;
      readonly publicAppUrl: string;
      /**
       * Raw hex, exactly 64 characters (32 bytes) — AES-256-GCM key for a
       * claimant_verify outbox row's short-lived retry payload. See
       * certificate-outbox-crypto.ts and certificate-notification-
       * dispatcher.ts's doc comment for why this exists: so a retry resends
       * the exact original verification link rather than a freshly minted
       * one — still valuable for SMTP (a stable link, no excess token
       * proliferation) even though SMTP has no provider-side idempotency to
       * satisfy the way the originally-intended Resend adapter would have.
       */
      readonly outboxEncryptionKeyHex: string;
      /**
       * undefined ONLY outside production, and only when NONE of the five
       * SMTP variables are set — server.ts then wires InMemoryEmailSender
       * for local manual testing, with a loud startup warning. Any ONE
       * variable present forces all five to be validated (a partial SMTP
       * config is always a mistake, never a signal to fall back silently).
       * parseCertificateClaims makes this undefined IMPOSSIBLE in
       * production — see that function's own doc comment.
       */
      readonly smtp: CertificateSmtpConfig | undefined;
    };

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

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SMTP_VAR_NAMES = [
  'CERTIFICATE_SMTP_HOST',
  'CERTIFICATE_SMTP_PORT',
  'CERTIFICATE_SMTP_TLS_MODE',
  'CERTIFICATE_SMTP_USERNAME',
  'CERTIFICATE_SMTP_PASSWORD'
] as const;

/**
 * Parses the five CERTIFICATE_SMTP_* variables into a validated
 * CertificateSmtpConfig, or returns undefined when NONE of them are set at
 * all (the local-dev, fake-sender case). A PARTIAL set — some present, some
 * not — is always an error, in dev or production: that shape is far more
 * likely to be a typo'd variable name than a deliberate choice, and should
 * never be silently treated as "not configured."
 *
 * `required` forces all five even when none are set — passed `true` only
 * for production (see parseCertificateClaims).
 */
function parseSmtpConfig(env: NodeJS.ProcessEnv, required: boolean): CertificateSmtpConfig | undefined {
  const present = SMTP_VAR_NAMES.filter((name) => (env[name] ?? '').trim().length > 0);
  if (present.length === 0 && !required) return undefined;
  if (present.length > 0 && present.length < SMTP_VAR_NAMES.length) {
    const missing = SMTP_VAR_NAMES.filter((name) => !present.includes(name));
    throw new ConfigError(
      `Partial SMTP configuration: ${present.join(', ')} ${present.length === 1 ? 'is' : 'are'} set but ` +
      `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not. Set all five CERTIFICATE_SMTP_* ` +
      'variables together, or none at all.'
    );
  }
  if (present.length === 0 && required) {
    throw new ConfigError(
      `${SMTP_VAR_NAMES.join(', ')} are all required when CERTIFICATE_CLAIMS_ENABLED=true in production — ` +
      'no real EmailSender can be configured without them, and this feature must never silently fall back ' +
      'to InMemoryEmailSender there.'
    );
  }

  const host = (env['CERTIFICATE_SMTP_HOST'] ?? '').trim();
  if (host.length === 0) throw new ConfigError('CERTIFICATE_SMTP_HOST must not be blank');

  const portRaw = (env['CERTIFICATE_SMTP_PORT'] ?? '').trim();
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`CERTIFICATE_SMTP_PORT must be an integer 1-65535 — received "${portRaw}"`);
  }

  const tlsModeRaw = (env['CERTIFICATE_SMTP_TLS_MODE'] ?? '').trim().toLowerCase();
  if (tlsModeRaw !== 'starttls' && tlsModeRaw !== 'tls') {
    throw new ConfigError(
      `CERTIFICATE_SMTP_TLS_MODE must be "starttls" (recommended — port 587, upgrades after connecting) or ` +
      `"tls" (implicit TLS — typically port 465) — received "${tlsModeRaw}". There is no insecure option.`
    );
  }

  const username = (env['CERTIFICATE_SMTP_USERNAME'] ?? '').trim();
  if (username.length === 0) throw new ConfigError('CERTIFICATE_SMTP_USERNAME must not be blank');

  // The value itself is intentionally never inspected beyond "non-empty" —
  // no length/shape check, which would risk the error message implying
  // something about a real password's structure. Never logged either way.
  const password = env['CERTIFICATE_SMTP_PASSWORD'] ?? '';
  if (password.length === 0) throw new ConfigError('CERTIFICATE_SMTP_PASSWORD must not be blank');

  return { host, port, tlsMode: tlsModeRaw, username, password };
}

/**
 * SAFE ROLLOUT: disabled unless CERTIFICATE_CLAIMS_ENABLED is exactly
 * "true". This is the ONLY gate on requiring the other variables — while
 * disabled, every one of them may be absent, and this function never even
 * looks at them. A deployment with zero certificate-related env vars set
 * continues to boot and serve Topic Quiz / Interview Mode exactly as
 * before; missing email configuration can never break an unrelated,
 * already-shipping service.
 *
 * Once enabled, the non-SMTP variables become required and fail closed —
 * the same "name the missing variable, never accept a silent default"
 * discipline as parseReceiptSecret. The five SMTP variables are handled
 * separately by parseSmtpConfig: required in production, optional (but
 * all-or-nothing) outside it — see that function's own doc comment.
 *
 * PRODUCTION GUARD: server.ts's wireCertificateClaims now selects a real
 * SmtpEmailSender WHENEVER the five SMTP variables below are present and
 * valid (see smtp-email-sender.ts), falling back to InMemoryEmailSender
 * only when they are absent — which this function makes impossible in
 * production, by requiring them below exactly like every other
 * certificate-claim variable. A production deploy can therefore never
 * silently end up with the in-memory sender: either the five SMTP
 * variables are present and valid (real sending), or parsing throws here
 * before the process ever reaches server.ts's wiring at all. If a SECOND
 * real provider is ever added, replace this single required-SMTP-config
 * check with an explicit provider-selection variable (e.g.
 * EMAIL_SENDER_IMPL) instead of just adding a parallel set of fields —
 * production must still never have an ambiguous or silent fallback path.
 */
function parseCertificateClaims(env: NodeJS.ProcessEnv, isProduction: boolean): CertificateClaimsConfig {
  const enabledRaw = (env['CERTIFICATE_CLAIMS_ENABLED'] ?? '').trim().toLowerCase();
  if (enabledRaw !== 'true') {
    return { enabled: false };
  }

  const emailFromAddress = (env['EMAIL_FROM_ADDRESS'] ?? '').trim();
  if (!EMAIL_PATTERN.test(emailFromAddress)) {
    throw new ConfigError('EMAIL_FROM_ADDRESS must be a valid email address when CERTIFICATE_CLAIMS_ENABLED=true');
  }

  const ownerNotificationEmail = (env['OWNER_NOTIFICATION_EMAIL'] ?? '').trim();
  if (!EMAIL_PATTERN.test(ownerNotificationEmail)) {
    throw new ConfigError('OWNER_NOTIFICATION_EMAIL must be a valid email address when CERTIFICATE_CLAIMS_ENABLED=true');
  }

  const publicAppUrl = (env['CERTIFICATE_CLAIM_BASE_URL'] ?? '').trim();
  if (publicAppUrl.length === 0) {
    throw new ConfigError('CERTIFICATE_CLAIM_BASE_URL is required when CERTIFICATE_CLAIMS_ENABLED=true');
  }
  try {
    // eslint-disable-next-line no-new -- validation only, the URL itself is unused here
    new URL(publicAppUrl);
  } catch {
    throw new ConfigError('CERTIFICATE_CLAIM_BASE_URL must be a valid absolute URL');
  }

  const outboxEncryptionKeyHex = (env['CERTIFICATE_OUTBOX_ENCRYPTION_KEY'] ?? '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(outboxEncryptionKeyHex)) {
    throw new ConfigError(
      'CERTIFICATE_OUTBOX_ENCRYPTION_KEY is required when CERTIFICATE_CLAIMS_ENABLED=true and must be ' +
      'exactly 64 hex characters (32 bytes) — generate one with `openssl rand -hex 32`'
    );
  }

  const smtp = parseSmtpConfig(env, isProduction);

  return {
    enabled: true,
    emailFromAddress,
    ownerNotificationEmail,
    publicAppUrl,
    outboxEncryptionKeyHex,
    smtp
  };
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
    topicQuizReceiptSecret: parseReceiptSecret(env['TOPIC_QUIZ_RECEIPT_SECRET'], isProduction),
    certificateClaims: parseCertificateClaims(env, isProduction)
  };
}
