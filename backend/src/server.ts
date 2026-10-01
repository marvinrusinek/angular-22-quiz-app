import { createApp } from './app';
import { ConfigError, loadConfig, type AppConfig } from './config';
import { createQuizRepositoryFromDatabase, describeBank, type QuizRepository } from './quiz/quiz.repository';
import { openDatabase, type DatabaseHandle } from './db/database';
import { migrate } from './db/migrate';
import { createSessionRepository } from './interview/session.repository';
import { InterviewSessionService } from './interview/session.service';
import { createCertificateClaimRepository } from './certificate/certificate-claim.repository';
import { CertificateClaimService, CertificateRetrievalService } from './certificate/certificate-claim.service';
import { NotificationDispatcher } from './certificate/certificate-notification-dispatcher';
import { InMemoryEmailSender, type EmailSender } from './certificate/email-sender';
import { describeSmtpConfig, SmtpEmailSender } from './certificate/smtp-email-sender';
import { describePostmarkConfig, PostmarkEmailSender } from './certificate/postmark-email-sender';
import { parseOutboxEncryptionKey } from './certificate/certificate-outbox-crypto';

/**
 * Process entry point. Kept separate from `createApp` so tests never bind a
 * port and never open a real database.
 *
 * Startup order is deliberate:
 *   1. configuration
 *   2. private quiz bank (validated)
 *   3. database opened + PRAGMAs
 *   4. migrations
 *   5. dependencies
 *   6. app
 *   7. listen
 *
 * Any failure exits BEFORE listening. A server that accepts requests it cannot
 * serve is worse than one that never started, and this process holds the
 * answer key.
 */
async function main(): Promise<void> {
  const config = loadConfigOrExit();

  // ORDER MATTERS: the quiz bank now lives in PostgreSQL, so the database must
  // be open and migrated before the bank can be read. It is no longer loaded
  // from a file, and there is no fallback to one.
  const database = openDatabaseOrExit(config);
  await runMigrationsOrExit(database, config);

  const quizRepository = await loadQuizRepositoryOrExit(database, config);
  console.log(`[quiz] ${describeBank(quizRepository.stats)}`);

  // Constructed here so route code never touches database lifecycle.
  const sessionRepository = createSessionRepository(database);
  const interviewSessionService = new InterviewSessionService({
    quizRepository,
    sessionRepository,
    now: () => Date.now()
  });

  const certificateClaims = wireCertificateClaims(database, config);

  const app = createApp(config, {
    quizRepository,
    sessionRepository,
    interviewSessionService,
    certificateClaimService: certificateClaims.actions?.service,
    certificateRetrievalService: certificateClaims.retrievalService
  });

  const server = app.listen(config.port, () => {
    console.log(`[server] listening on :${config.port} (${config.nodeEnv})`);
    console.log(`[server] allowed origins: ${config.allowedOrigins.join(', ')}`);
  });

  const certificateDispatcher = certificateClaims.actions?.dispatcher;
  const certificateClaimsPoller = certificateDispatcher
    ? setInterval(() => {
        certificateDispatcher.runOnce().catch((err: unknown) => {
          console.error('[certificate-claims] outbox poll failed:', err instanceof Error ? err.message : err);
        });
      }, 30_000)
    : null;

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;   // a second signal must not double-close
    shuttingDown = true;
    console.log(`[server] ${signal} received, closing`);
    if (certificateClaimsPoller) clearInterval(certificateClaimsPoller);
    server.close(() => {
      database.close();   // idempotent
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

function loadConfigOrExit(): AppConfig {
  try {
    return loadConfig(process.env);
  } catch (err: unknown) {
    if (err instanceof ConfigError) {
      console.error(`[config] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

/**
 * Load the bank from PostgreSQL. FAILS CLOSED.
 *
 * An empty or unreadable bank exits before listening. There is no fallback to
 * `data/quiz.json`: a server that silently served a stale file would defeat the
 * point of making the database authoritative, and in production that file is
 * not supposed to exist at all.
 */
async function loadQuizRepositoryOrExit(
  database: DatabaseHandle,
  config: AppConfig
): Promise<QuizRepository> {
  try {
    return await createQuizRepositoryFromDatabase(database);
  } catch (err: unknown) {
    await database.close();
    console.error(safeStartupMessage('quiz', 'quiz data failed to load', err, config));
    process.exit(1);
  }
}

/**
 * Constructs the certificate-claim feature's two INDEPENDENT halves.
 *
 * `actions` (submit/resend/verify preview+confirm, plus the outbox
 * dispatcher and poller) is present only when config.certificateClaims.enabled
 * is true. `retrievalService` (GET /certificates/me) is present whenever
 * config.certificateClaims.retrievalEnabled is true — which includes the
 * case where `enabled` is false but CERTIFICATE_RETRIEVAL_ENABLED=true was
 * set explicitly (see config.ts#parseCertificateClaims and
 * docs/certificate-claims-runbook.md §7.3). Both absent (the default) means
 * server.ts never touches the certificate module again, and createApp's
 * router responds 503 to every certificate-claim path on its own (see
 * certificate-claims.route.ts) — this is the actual mechanism behind
 * "missing email configuration must not break existing quiz services when
 * the feature is disabled": if both halves are off, this function never
 * even reads any certificate-claim variable, so their absence is a complete
 * non-event.
 *
 * CertificateRetrievalService needs only the repository and a clock — no
 * email sender, no provider configuration — so it is always constructible
 * from the database alone, independent of which (if any) email provider is
 * configured. This is what lets retrieval keep working through an
 * email-provider outage or a deliberate rollback of new issuance, with the
 * exact same token validation (expiry + revocation) either way.
 *
 * EMAIL SENDER SELECTION (only reached when `actions` is being built):
 * switches on config.certificateClaims.emailProvider — 'smtp' selects
 * SmtpEmailSender (Nodemailer), 'postmark' selects PostmarkEmailSender
 * (Postmark's HTTP Email API), and `undefined` selects InMemoryEmailSender.
 * config.ts's parseCertificateClaims makes `emailProvider` undefined
 * IMPOSSIBLE in production (see its own doc comment) — so this function
 * never needs a separate production check of its own. Outside production,
 * `emailProvider` being undefined is a deliberate, supported local-dev
 * choice (manual testing with the fake sender), hence the loud warning
 * rather than a thrown error. The two real senders exist side by side
 * specifically because the production Node service runs on Render's free
 * tier, which blocks outbound SMTP ports entirely but not outbound HTTPS —
 * see docs/certificate-claims-runbook.md.
 */
function wireCertificateClaims(
  database: DatabaseHandle,
  config: AppConfig
): {
  readonly actions?: { readonly service: CertificateClaimService; readonly dispatcher: NotificationDispatcher } | undefined;
  readonly retrievalService?: CertificateRetrievalService | undefined;
} {
  const claimsConfig = config.certificateClaims;
  if (!claimsConfig.enabled && !claimsConfig.retrievalEnabled) return {};

  const now = () => Date.now();
  const repository = createCertificateClaimRepository(database);
  const retrievalService = claimsConfig.retrievalEnabled
    ? new CertificateRetrievalService({ repository, now })
    : undefined;

  if (!claimsConfig.enabled) {
    console.log(
      '[certificate-claims] new submissions/resend/verification and the outbox dispatcher are DISABLED ' +
      '(CERTIFICATE_CLAIMS_ENABLED is not "true"); GET /certificates/me stays available because ' +
      'CERTIFICATE_RETRIEVAL_ENABLED=true — see docs/certificate-claims-runbook.md §7.3.'
    );
    return { retrievalService };
  }

  let emailSender: EmailSender;
  if (claimsConfig.emailProvider === 'smtp') {
    console.log(`[certificate-claims] sending via SMTP: ${describeSmtpConfig(claimsConfig.smtp)}`);
    emailSender = new SmtpEmailSender({ smtp: claimsConfig.smtp, fromAddress: claimsConfig.emailFromAddress });
  } else if (claimsConfig.emailProvider === 'postmark') {
    console.log(`[certificate-claims] sending via Postmark: ${describePostmarkConfig(claimsConfig.postmark)}`);
    emailSender = new PostmarkEmailSender({ postmark: claimsConfig.postmark, fromAddress: claimsConfig.emailFromAddress });
  } else {
    console.warn(
      '[certificate-claims] ENABLED, but no CERTIFICATE_EMAIL_PROVIDER is set — ' +
      'using an IN-MEMORY sender that delivers nothing. This is only ever reached outside ' +
      'production (parseCertificateClaims requires an explicit provider there); fine for local ' +
      'manual testing, never acceptable for a real deployment.'
    );
    emailSender = new InMemoryEmailSender();
  }

  // Comfortably longer than the dispatcher's own worst-case retry span
  // (~11 hours across all attempts — see BACKOFF_MS_BY_ATTEMPT) so a link
  // that is still being retried is never expired by the time it finally
  // sends.
  const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60_000; // 24 hours
  const RETRIEVAL_TOKEN_TTL_MS = 90 * 24 * 60 * 60_000; // 90 days

  const buildVerificationUrl = (rawToken: string): string =>
    `${claimsConfig.publicAppUrl.replace(/\/$/, '')}/interview/certificate/verify#token=${encodeURIComponent(rawToken)}`;

  const dispatcher = new NotificationDispatcher({
    repository,
    emailSender,
    now,
    verificationTokenTtlMs: VERIFICATION_TOKEN_TTL_MS,
    buildVerificationUrl,
    ownerNotificationEmail: claimsConfig.ownerNotificationEmail,
    outboxEncryptionKey: parseOutboxEncryptionKey(claimsConfig.outboxEncryptionKeyHex)
  });

  const service = new CertificateClaimService({
    repository,
    dispatcher,
    now,
    retrievalTokenTtlMs: RETRIEVAL_TOKEN_TTL_MS
  });

  return { actions: { service, dispatcher }, retrievalService };
}

function openDatabaseOrExit(config: AppConfig): DatabaseHandle {
  try {
    return openDatabase({ databaseUrl: config.databaseUrl });
  } catch (err: unknown) {
    console.error(safeStartupMessage('db', 'database could not be opened', err, config));
    process.exit(1);
  }
}

async function runMigrationsOrExit(database: DatabaseHandle, config: AppConfig): Promise<void> {
  try {
    const applied = await migrate(database);
    console.log(
      applied.length === 0
        ? '[db] schema up to date'
        : `[db] applied migration(s): ${applied.join(', ')}`
    );
  } catch (err: unknown) {
    // The database is already open — close it before exiting.
    database.close();
    console.error(safeStartupMessage('db', 'migrations failed', err, config));
    process.exit(1);
  }
}

/**
 * Local runs get the detail; production gets a fixed line. Loader, migration
 * and database messages are already path-free, but production output is kept
 * deliberately blunt rather than relying on that.
 */
function safeStartupMessage(
  scope: string,
  summary: string,
  err: unknown,
  config: AppConfig
): string {
  if (config.isProduction) return `[${scope}] ${summary} — refusing to start`;
  const detail = err instanceof Error ? err.message : String(err);
  return `[${scope}] ${detail}`;
}

main();
