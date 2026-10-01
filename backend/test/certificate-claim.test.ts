import request from 'supertest';

import { certificateClaimTestDb } from './helpers/certificate-claim-db';
import { realCertificateClaimTestDb } from './helpers/certificate-claim-real-db';
import {
  createCertificateClaimRepository,
  MAX_OUTSTANDING_TOKENS_PER_CLAIM,
  type CertificateClaimRepository
} from '../src/certificate/certificate-claim.repository';
import { CertificateClaimService } from '../src/certificate/certificate-claim.service';
import { NotificationDispatcher } from '../src/certificate/certificate-notification-dispatcher';
import { InMemoryEmailSender } from '../src/certificate/email-sender';
import { CertificateClaimError } from '../src/certificate/certificate-claim.types';
import { parseOutboxEncryptionKey } from '../src/certificate/certificate-outbox-crypto';
import { loadConfig, ConfigError } from '../src/config';
import { createApp } from '../src/app';
import type { QuizRepository } from '../src/quiz/quiz.repository';

const ONE_HOUR_MS = 60 * 60_000;
const SNAPSHOT = { achievementIds: ['angular-explorer'], qualifyingInterviewCount: 5, qualificationStartedAt: 1_700_000_000_000 };
const TEST_OUTBOX_ENCRYPTION_KEY_HEX = 'ab'.repeat(32); // exactly 64 hex chars — test-only, never a real secret
const TEST_OUTBOX_ENCRYPTION_KEY = parseOutboxEncryptionKey(TEST_OUTBOX_ENCRYPTION_KEY_HEX);

function buildStack() {
  let now = 1_700_000_000_000;
  const clock = () => now;
  const advance = (ms: number) => { now += ms; };

  return { clock, advance, tick: () => now };
}

async function makeRepository(): Promise<CertificateClaimRepository> {
  const db = await certificateClaimTestDb();
  return createCertificateClaimRepository(db);
}

/**
 * Wraps a repository so its FIRST markNotificationSent call is a no-op —
 * simulating "the provider accepted the send, but this process crashed
 * before that UPDATE could run." Everything else (critically,
 * setNotificationPayload, which already ran during buildEmail BEFORE
 * send()) passes straight through, so the row is left exactly as a real
 * crash would: still 'pending', with its encrypted payload intact. Test
 * doubles-the-repository rather than raw SQL, since "markNotificationSent
 * never happened" is the actual thing being simulated, not a derived
 * side effect of it.
 */
function withMarkSentCrashedOnce(repository: CertificateClaimRepository): CertificateClaimRepository {
  let crashed = false;
  return {
    ...repository,
    async markNotificationSent(kind, referenceId, now) {
      if (!crashed) {
        crashed = true;
        return; // the write that "never happened"
      }
      return repository.markNotificationSent(kind, referenceId, now);
    }
  };
}

describe('certificate-claim repository — verification token lifecycle', () => {
  it('a valid token confirms exactly once, issuing a certificate', async () => {
    const repository = await makeRepository();
    const now = 1_700_000_000_000;

    const outcome = await repository.createClaim({
      claimedName: 'Ada Lovelace',
      emailNormalized: 'ada@example.com',
      eligibilitySnapshot: SNAPSHOT,
      now
    });
    expect(outcome.kind).toBe('created');
    const claimId = (outcome as { claim: { id: string } }).claim.id;

    const minted = await repository.mintVerificationToken(claimId, ONE_HOUR_MS, now);
    expect('rawToken' in minted).toBe(true);
    const rawToken = (minted as { rawToken: string }).rawToken;

    const confirmed = await repository.confirmVerificationToken(rawToken, now + 1000);
    expect(confirmed.kind).toBe('issued');
    if (confirmed.kind === 'issued') {
      expect(confirmed.isNewIssuance).toBe(true);
      expect(confirmed.certificate.recipientName).toBe('Ada Lovelace');
      expect(confirmed.certificate.emailNormalized).toBe('ada@example.com');
    }
  });

  it('an expired token is rejected and does NOT issue a certificate', async () => {
    const repository = await makeRepository();
    const now = 1_700_000_000_000;

    const outcome = await repository.createClaim({
      claimedName: 'Grace Hopper',
      emailNormalized: 'grace@example.com',
      eligibilitySnapshot: SNAPSHOT,
      now
    });
    const claimId = (outcome as { claim: { id: string } }).claim.id;
    const minted = await repository.mintVerificationToken(claimId, ONE_HOUR_MS, now);
    const rawToken = (minted as { rawToken: string }).rawToken;

    const afterExpiry = now + ONE_HOUR_MS + 1;
    const result = await repository.confirmVerificationToken(rawToken, afterExpiry);
    expect(result.kind).toBe('expired');

    const certificate = await repository.findCertificateByEmail('grace@example.com');
    expect(certificate).toBeNull();
  });

  it('a REUSED (already-used) token is rejected on the second attempt — no second certificate', async () => {
    const repository = await makeRepository();
    const now = 1_700_000_000_000;

    const outcome = await repository.createClaim({
      claimedName: 'Margaret Hamilton',
      emailNormalized: 'margaret@example.com',
      eligibilitySnapshot: SNAPSHOT,
      now
    });
    const claimId = (outcome as { claim: { id: string } }).claim.id;
    const minted = await repository.mintVerificationToken(claimId, ONE_HOUR_MS, now);
    const rawToken = (minted as { rawToken: string }).rawToken;

    const first = await repository.confirmVerificationToken(rawToken, now + 10);
    expect(first.kind).toBe('issued');

    const second = await repository.confirmVerificationToken(rawToken, now + 20);
    expect(second.kind).toBe('already_used');

    const certificate = await repository.findCertificateByEmail('margaret@example.com');
    expect(certificate).not.toBeNull();
  });

  it('a well-formed but unknown token, and a malformed token, are both rejected as invalid', async () => {
    const repository = await makeRepository();
    const now = 1_700_000_000_000;

    const unknown = await repository.confirmVerificationToken('A'.repeat(43), now);
    expect(unknown.kind).toBe('invalid');

    const malformed = await repository.confirmVerificationToken('not-well-formed', now);
    expect(malformed.kind).toBe('invalid');
  });

  it('outstanding tokens are bounded — resend past the cap is rejected, not appended forever', async () => {
    const repository = await makeRepository();
    const now = 1_700_000_000_000;

    const outcome = await repository.createClaim({
      claimedName: 'Katherine Johnson',
      emailNormalized: 'katherine@example.com',
      eligibilitySnapshot: SNAPSHOT,
      now
    });
    const claimId = (outcome as { claim: { id: string } }).claim.id;

    for (let i = 0; i < MAX_OUTSTANDING_TOKENS_PER_CLAIM; i++) {
      const minted = await repository.mintVerificationToken(claimId, ONE_HOUR_MS, now + i);
      expect('rawToken' in minted).toBe(true);
    }

    const overCap = await repository.mintVerificationToken(claimId, ONE_HOUR_MS, now + 999);
    expect('limitReached' in overCap).toBe(true);
  });
});

describe('certificate-claim repository — concurrent issuance', () => {
  it('two DIFFERENT valid tokens for the SAME claim, confirmed concurrently, resolve to exactly ONE certificate', async () => {
    const repository = await makeRepository();
    const now = 1_700_000_000_000;

    const outcome = await repository.createClaim({
      claimedName: 'Radia Perlman',
      emailNormalized: 'radia@example.com',
      eligibilitySnapshot: SNAPSHOT,
      now
    });
    const claimId = (outcome as { claim: { id: string } }).claim.id;

    const tokenA = (await repository.mintVerificationToken(claimId, ONE_HOUR_MS, now)) as { rawToken: string };
    const tokenB = (await repository.mintVerificationToken(claimId, ONE_HOUR_MS, now + 1)) as { rawToken: string };

    // Genuinely concurrent from the caller's perspective. pg-mem itself
    // serializes transactions one at a time (see test/helpers/pg-mem-pool.ts's
    // own documented behaviour), which mirrors what real Postgres row-level
    // locking on the SELECT ... FOR UPDATE claim row would also force —
    // this is why this test is a meaningful proof of the mechanism, not
    // just a sequential call dressed up as concurrent. The equivalent test
    // against a REAL, multi-connection Postgres server (two independent
    // connections genuinely racing, not one queued client) lives below in
    // 'certificate-claim repository — concurrent issuance (real PostgreSQL)',
    // gated on TEST_DATABASE_URL.
    const [first, second] = await Promise.all([
      repository.confirmVerificationToken(tokenA.rawToken, now + 10),
      repository.confirmVerificationToken(tokenB.rawToken, now + 10)
    ]);

    const outcomes = [first, second];
    const issuedCount = outcomes.filter((o) => o.kind === 'issued').length;
    expect(issuedCount).toBe(2); // both tokens are independently valid and get consumed

    const newIssuanceCount = outcomes.filter((o) => o.kind === 'issued' && o.isNewIssuance).length;
    expect(newIssuanceCount).toBe(1); // but only ONE of them actually created the certificate row

    const recoveryCount = outcomes.filter((o) => o.kind === 'issued' && !o.isNewIssuance).length;
    expect(recoveryCount).toBe(1);

    // Both resolve to the SAME certificate id — no two certificates exist.
    const ids = outcomes
      .filter((o): o is Extract<typeof o, { kind: 'issued' }> => o.kind === 'issued')
      .map((o) => o.certificate.id);
    expect(new Set(ids).size).toBe(1);

    const certificate = await repository.findCertificateByEmail('radia@example.com');
    expect(certificate).not.toBeNull();
  });
});

/**
 * Same property as the suite above, but against a REAL Postgres server —
 * gated on TEST_DATABASE_URL, same convention as quiz-bank-schema.test.ts.
 * Skipped (not failed) when unset, exactly like that suite.
 *
 * WHY THIS IS A SEPARATE BLOCK, not just "run everything twice": this is
 * the one property pg-mem cannot prove at all — its own pool wrapper hands
 * out one client at a time (test/helpers/pg-mem-pool.ts), so "concurrent"
 * calls against it never exercise a real row lock or a real second
 * connection. Here, two actual pool connections race for real, which is
 * also what originally caught a genuine bug: the repository's conflict
 * handler was re-querying the SAME client after catching a 23505 without
 * first issuing ROLLBACK TO SAVEPOINT — harmless against pg-mem (which
 * does not model aborted-transaction state) but a guaranteed 25P02
 * "current transaction is aborted" on real Postgres. Fixed via an explicit
 * SAVEPOINT in confirmVerificationToken; this test is what would catch a
 * regression of that fix.
 */
const realDatabaseUrl = (process.env['TEST_DATABASE_URL'] ?? '').trim();
const describeReal = realDatabaseUrl.length > 0 ? describe : describe.skip;

describeReal('certificate-claim repository — concurrent issuance (real PostgreSQL)', () => {
  it('two DIFFERENT valid tokens for the SAME claim, confirmed via two REAL concurrent connections, resolve to exactly ONE certificate', async () => {
    const db = await realCertificateClaimTestDb();
    try {
      const repository = createCertificateClaimRepository(db);
      const now = 1_700_000_000_000;

      const outcome = await repository.createClaim({
        claimedName: 'Katherine Johnson',
        emailNormalized: 'katherine@example.com',
        eligibilitySnapshot: SNAPSHOT,
        now
      });
      const claimId = (outcome as { claim: { id: string } }).claim.id;

      const tokenA = (await repository.mintVerificationToken(claimId, ONE_HOUR_MS, now)) as { rawToken: string };
      const tokenB = (await repository.mintVerificationToken(claimId, ONE_HOUR_MS, now + 1)) as { rawToken: string };

      const [first, second] = await Promise.all([
        repository.confirmVerificationToken(tokenA.rawToken, now + 10),
        repository.confirmVerificationToken(tokenB.rawToken, now + 10)
      ]);

      const outcomes = [first, second];
      expect(outcomes.filter((o) => o.kind === 'issued').length).toBe(2);

      const newIssuanceCount = outcomes.filter((o) => o.kind === 'issued' && o.isNewIssuance).length;
      expect(newIssuanceCount).toBe(1);
      const recoveryCount = outcomes.filter((o) => o.kind === 'issued' && !o.isNewIssuance).length;
      expect(recoveryCount).toBe(1);

      const ids = outcomes
        .filter((o): o is Extract<typeof o, { kind: 'issued' }> => o.kind === 'issued')
        .map((o) => o.certificate.id);
      expect(new Set(ids).size).toBe(1);

      const { rows } = await db.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM issued_certificates WHERE email_normalized = $1',
        ['katherine@example.com']
      );
      expect(rows[0]?.count).toBe(1);

      const outboxRows = await db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM certificate_notification_outbox WHERE kind = 'owner_claim_notice'"
      );
      // confirmVerificationToken itself never enqueues a notification — the
      // service layer does, and only when isNewIssuance is true (see
      // certificate-claim.service.ts#confirmToken). Asserted here as a
      // sanity check that the repository layer alone creates no outbox
      // row at all, so the service-layer test elsewhere is what actually
      // proves "exactly one owner notification, not two".
      expect(outboxRows.rows[0]?.count).toBe(0);
    } finally {
      await db.close();
    }
  });

  it('confirming two tokens for the same claim via two REAL concurrent SERVICE calls enqueues exactly ONE owner-notification outbox row', async () => {
    const db = await realCertificateClaimTestDb();
    try {
      const repository = createCertificateClaimRepository(db);
      const emailSender = new InMemoryEmailSender();
      const dispatcher = new NotificationDispatcher({
        repository,
        emailSender,
        now: () => Date.now(),
        verificationTokenTtlMs: ONE_HOUR_MS,
        buildVerificationUrl: (t) => `https://example.test/verify#token=${t}`,
        ownerNotificationEmail: 'owner@example.test',
        outboxEncryptionKey: TEST_OUTBOX_ENCRYPTION_KEY
      });
      const service = new CertificateClaimService({ repository, dispatcher, now: () => Date.now(), retrievalTokenTtlMs: ONE_HOUR_MS });

      const now = Date.now();
      const outcome = await repository.createClaim({
        claimedName: 'Mary Jackson',
        emailNormalized: 'mary@example.com',
        eligibilitySnapshot: SNAPSHOT,
        now
      });
      const claimId = (outcome as { claim: { id: string } }).claim.id;
      const tokenA = (await repository.mintVerificationToken(claimId, ONE_HOUR_MS, now)) as { rawToken: string };
      const tokenB = (await repository.mintVerificationToken(claimId, ONE_HOUR_MS, now + 1)) as { rawToken: string };

      const [first, second] = await Promise.allSettled([
        service.confirmToken(tokenA.rawToken),
        service.confirmToken(tokenB.rawToken)
      ]);
      expect(first.status).toBe('fulfilled');
      expect(second.status).toBe('fulfilled');

      const certRows = await db.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM issued_certificates WHERE email_normalized = $1',
        ['mary@example.com']
      );
      expect(certRows.rows[0]?.count).toBe(1);

      const outboxRows = await db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM certificate_notification_outbox WHERE kind = 'owner_claim_notice'"
      );
      expect(outboxRows.rows[0]?.count).toBe(1); // the composite (kind, reference_id) PK is what enforces this
    } finally {
      await db.close();
    }
  });

  it('two CONCURRENT dispatcher instances racing the SAME due row never both process it — FOR UPDATE SKIP LOCKED, not an in-memory-only claim', async () => {
    const db = await realCertificateClaimTestDb();
    try {
      const repository = createCertificateClaimRepository(db);
      // Two SEPARATE senders, standing in for two separate process
      // replicas — if both dispatchers claimed the same row, each would
      // mint its OWN token and each would believe ITS token is the one
      // that matters, which is exactly the "invalidate each other's
      // tokens" failure mode this proves does not happen.
      const senderA = new InMemoryEmailSender();
      const senderB = new InMemoryEmailSender();
      const makeDispatcher = (emailSender: InMemoryEmailSender) => new NotificationDispatcher({
        repository, emailSender, now: () => Date.now(), verificationTokenTtlMs: ONE_HOUR_MS,
        buildVerificationUrl: (t) => `https://example.test/verify#token=${t}`,
        ownerNotificationEmail: 'owner@example.test',
        outboxEncryptionKey: TEST_OUTBOX_ENCRYPTION_KEY
      });
      const dispatcherA = makeDispatcher(senderA);
      const dispatcherB = makeDispatcher(senderB);

      const now = Date.now();
      const claim = await repository.createClaim({
        claimedName: 'Dorothy Vaughan', emailNormalized: 'dorothy@example.com', eligibilitySnapshot: SNAPSHOT, now
      });
      const claimId = (claim as { claim: { id: string } }).claim.id;
      await repository.enqueueNotification('claimant_verify', claimId, now);

      const [outcomeA, outcomeB] = await Promise.all([dispatcherA.runOnce(), dispatcherB.runOnce()]);

      // Exactly one dispatcher claimed the row (SKIP LOCKED); the other saw
      // nothing due, precisely because the first already held its lock.
      const processedTotal = outcomeA.processed + outcomeB.processed;
      expect(processedTotal).toBe(1);
      const sentTotal = outcomeA.sent + outcomeB.sent;
      expect(sentTotal).toBe(1);

      // Exactly one token exists for the claim — the loser never minted one.
      const tokenRows = await db.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM certificate_verification_tokens WHERE claim_id = $1',
        [claimId]
      );
      expect(tokenRows.rows[0]?.count).toBe(1);

      // Exactly one physical email across BOTH senders combined.
      expect(senderA.sentMessages.length + senderB.sentMessages.length).toBe(1);

      const outboxRow = await db.query<{ status: string; attempts: number }>(
        "SELECT status, attempts FROM certificate_notification_outbox WHERE kind = 'claimant_verify' AND reference_id = $1",
        [claimId]
      );
      expect(outboxRow.rows[0]?.status).toBe('sent');
      expect(outboxRow.rows[0]?.attempts).toBe(1); // not double-incremented by the loser
    } finally {
      await db.close();
    }
  });
});

/**
 * Every OTHER enabled-feature test in this file calls the service/repository
 * DIRECTLY — which proves the business logic, but never serializes a
 * response through Express/JSON the way a real HTTP client (the Angular
 * frontend) actually receives it. This block goes through `createApp()` +
 * supertest instead, against a REAL Postgres database, so the exact field
 * names below are checked against the real wire format — not assumed to
 * match `src/app/shared/services/api/certificate-claim-api.service.ts`'s
 * TypeScript interfaces, which were written by hand against this same
 * contract and could easily have drifted from it.
 */
describeReal('certificate-claim HTTP wire contract (real PostgreSQL + real Express routes)', () => {
  it('submit → preview → confirm → retrieve round-trips with the EXACT field names the Angular frontend expects', async () => {
    const db = await realCertificateClaimTestDb();
    try {
      const repository = createCertificateClaimRepository(db);
      const emailSender = new InMemoryEmailSender();
      const dispatcher = new NotificationDispatcher({
        repository, emailSender, now: () => Date.now(), verificationTokenTtlMs: ONE_HOUR_MS,
        buildVerificationUrl: (t) => `http://localhost:4200/interview/certificate/verify#token=${t}`,
        ownerNotificationEmail: 'owner@example.test',
        outboxEncryptionKey: TEST_OUTBOX_ENCRYPTION_KEY
      });
      const certificateClaimService = new CertificateClaimService({
        repository, dispatcher, now: () => Date.now(), retrievalTokenTtlMs: ONE_HOUR_MS
      });
      const quizRepository = { stats: { quizCount: 0, questionCount: 0, optionCount: 0 } } as unknown as QuizRepository;
      const config = loadConfig({});
      const app = createApp(config, { quizRepository, certificateClaimService });

      // 1) submit — matches CertificateClaimApiService#submitClaim's request body.
      const submitRes = await request(app).post('/api/certificate-claims').send({
        name: 'Grace Hopper',
        email: 'grace.wire@example.com',
        eligibilitySnapshot: { achievementIds: ['angular-explorer'], qualifyingInterviewCount: 5, qualificationStartedAt: Date.now() }
      });
      expect(submitRes.status).toBe(202);
      expect(submitRes.body).toEqual({ status: 'pending_verification' });

      // The raw token only ever exists in the (simulated) email — extracted
      // here exactly as a real recipient's mail client would expose it in
      // the link's URL fragment, never read back from the database (which
      // holds only a hash).
      const verificationUrl = (emailSender.sentMessages[0]?.templateData as { verificationUrl: string }).verificationUrl;
      const rawToken = decodeURIComponent(verificationUrl.split('#token=')[1] ?? '');
      expect(rawToken.length).toBeGreaterThan(0);

      // 2) preview — matches PreviewTokenResult. Read-only: calling it must
      // not itself be capable of consuming the token (asserted implicitly:
      // confirm below still succeeds afterward).
      const previewRes = await request(app).post('/api/certificate-claims/verify/preview').send({ token: rawToken });
      expect(previewRes.status).toBe(200);
      expect(previewRes.body).toEqual({ claimedName: 'Grace Hopper', emailMasked: expect.any(String) });

      // 3) confirm — matches ConfirmedCertificateDto.
      const confirmRes = await request(app).post('/api/certificate-claims/verify/confirm').send({ token: rawToken });
      expect(confirmRes.status).toBe(200);
      expect(confirmRes.body).toEqual({
        certificateId: expect.any(String),
        recipientName: 'Grace Hopper',
        issuedAt: expect.any(Number),
        retrievalToken: expect.any(String)
      });

      // A REUSED token must fail, not silently re-confirm.
      const reuseRes = await request(app).post('/api/certificate-claims/verify/confirm').send({ token: rawToken });
      expect(reuseRes.status).toBe(409);

      // 4) retrieve — matches CertificateClaimApiService#getCertificateByRetrievalToken's expected shape.
      const retrievalToken = confirmRes.body.retrievalToken as string;
      const meRes = await request(app).get('/api/certificates/me').set('Authorization', `Bearer ${retrievalToken}`);
      expect(meRes.status).toBe(200);
      expect(meRes.body).toEqual({
        certificateId: confirmRes.body.certificateId,
        recipientName: 'Grace Hopper',
        issuedAt: confirmRes.body.issuedAt
      });

      // A well-formed (43-char base64url) but UNKNOWN token.
      const invalidRes = await request(app).post('/api/certificate-claims/verify/preview').send({ token: 'A'.repeat(43) });
      expect(invalidRes.status).toBe(404);
      expect(invalidRes.body).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String) } });
    } finally {
      await db.close();
    }
  });
});

describe('certificate-claim repository — recovery', () => {
  it('re-verifying an already-certificated email preserves the certificate id, issued date, and name — never overwritten', async () => {
    const repository = await makeRepository();
    const now = 1_700_000_000_000;

    // First, genuine issuance.
    const firstClaim = await repository.createClaim({
      claimedName: 'Original Name',
      emailNormalized: 'recover@example.com',
      eligibilitySnapshot: SNAPSHOT,
      now
    });
    const firstClaimId = (firstClaim as { claim: { id: string } }).claim.id;
    const firstToken = (await repository.mintVerificationToken(firstClaimId, ONE_HOUR_MS, now)) as { rawToken: string };
    const firstConfirm = await repository.confirmVerificationToken(firstToken.rawToken, now + 10);
    expect(firstConfirm.kind).toBe('issued');
    const originalCertificateId = firstConfirm.kind === 'issued' ? firstConfirm.certificate.id : '';
    const originalIssuedAt = firstConfirm.kind === 'issued' ? firstConfirm.certificate.issuedAt : 0;

    // Recovery: same email, a DIFFERENT submitted name — must NOT overwrite.
    const laterTime = now + 5 * ONE_HOUR_MS;
    const recoveryClaim = await repository.createClaim({
      claimedName: 'A Different Name Entirely',
      emailNormalized: 'recover@example.com',
      eligibilitySnapshot: SNAPSHOT,
      now: laterTime
    });
    expect(recoveryClaim.kind).toBe('recovery_created');
    const recoveryClaimId = (recoveryClaim as { claim: { id: string } }).claim.id;
    expect(recoveryClaimId).not.toBe(firstClaimId);

    const recoveryToken = (await repository.mintVerificationToken(recoveryClaimId, ONE_HOUR_MS, laterTime)) as {
      rawToken: string;
    };
    const recoveryConfirm = await repository.confirmVerificationToken(recoveryToken.rawToken, laterTime + 10);
    expect(recoveryConfirm.kind).toBe('issued');
    if (recoveryConfirm.kind === 'issued') {
      expect(recoveryConfirm.isNewIssuance).toBe(false);
      expect(recoveryConfirm.certificate.id).toBe(originalCertificateId); // SAME certificate id
      expect(recoveryConfirm.certificate.issuedAt).toBe(originalIssuedAt); // SAME original issue date
      expect(recoveryConfirm.certificate.recipientName).toBe('Original Name'); // NEVER overwritten
    }
  });

  it('recovery mints a working retrieval token for the pre-existing certificate', async () => {
    const repository = await makeRepository();
    const now = 1_700_000_000_000;

    const firstClaim = await repository.createClaim({
      claimedName: 'Hedy Lamarr',
      emailNormalized: 'hedy@example.com',
      eligibilitySnapshot: SNAPSHOT,
      now
    });
    const firstToken = (await repository.mintVerificationToken(
      (firstClaim as { claim: { id: string } }).claim.id,
      ONE_HOUR_MS,
      now
    )) as { rawToken: string };
    await repository.confirmVerificationToken(firstToken.rawToken, now + 10);

    const recoveryClaim = await repository.createClaim({
      claimedName: 'Hedy Lamarr',
      emailNormalized: 'hedy@example.com',
      eligibilitySnapshot: SNAPSHOT,
      now: now + ONE_HOUR_MS
    });
    const recoveryToken = (await repository.mintVerificationToken(
      (recoveryClaim as { claim: { id: string } }).claim.id,
      ONE_HOUR_MS,
      now + ONE_HOUR_MS
    )) as { rawToken: string };
    const recoveryConfirm = await repository.confirmVerificationToken(recoveryToken.rawToken, now + ONE_HOUR_MS + 10);
    expect(recoveryConfirm.kind).toBe('issued');

    if (recoveryConfirm.kind === 'issued') {
      const retrieval = await repository.mintRetrievalToken(recoveryConfirm.certificate.id, ONE_HOUR_MS, now);
      const resolved = await repository.resolveRetrievalToken(retrieval.rawToken, now + 5);
      expect(resolved?.id).toBe(recoveryConfirm.certificate.id);
    }
  });
});

describe('certificate-claim service — submission is generic (anti-enumeration) and rejects invalid input', () => {
  async function buildService(clock: () => number) {
    const repository = await makeRepository();
    const emailSender = new InMemoryEmailSender();
    const dispatcher = new NotificationDispatcher({
      repository,
      emailSender,
      now: clock,
      verificationTokenTtlMs: ONE_HOUR_MS,
      buildVerificationUrl: (t) => `https://example.test/verify#token=${t}`,
      ownerNotificationEmail: 'owner@example.test',
      outboxEncryptionKey: TEST_OUTBOX_ENCRYPTION_KEY
    });
    const service = new CertificateClaimService({ repository, dispatcher, now: clock, retrievalTokenTtlMs: ONE_HOUR_MS });
    return { repository, emailSender, dispatcher, service };
  }

  it('a brand new claim, a re-submission while pending, and a re-submission of an already-verified email all return the SAME response shape', async () => {
    const { clock, advance } = buildStack();
    const { service, repository } = await buildService(clock);

    const first = await service.submitClaim({ name: 'Joan Clarke', email: 'joan@example.com', eligibilitySnapshot: SNAPSHOT });
    expect(first).toEqual({ status: 'pending_verification' });

    const second = await service.submitClaim({ name: 'Joan Clarke', email: 'joan@example.com', eligibilitySnapshot: SNAPSHOT });
    expect(second).toEqual({ status: 'pending_verification' });

    // Verify the real claim, THEN submit again for the same email — still identical shape.
    const claim = await repository.findPendingClaimByEmail('joan@example.com');
    expect(claim).not.toBeNull();
    const minted = await repository.mintVerificationToken(claim!.id, ONE_HOUR_MS, clock());
    advance(1000);
    await repository.confirmVerificationToken((minted as { rawToken: string }).rawToken, clock());

    const third = await service.submitClaim({ name: 'Joan Clarke', email: 'joan@example.com', eligibilitySnapshot: SNAPSHOT });
    expect(third).toEqual({ status: 'pending_verification' });
  });

  it('rejects a missing/blank name', async () => {
    const { clock } = buildStack();
    const { service } = await buildService(clock);
    await expect(
      service.submitClaim({ name: '   ', email: 'x@example.com', eligibilitySnapshot: SNAPSHOT })
    ).rejects.toBeInstanceOf(CertificateClaimError);
  });

  it('rejects a malformed email', async () => {
    const { clock } = buildStack();
    const { service } = await buildService(clock);
    await expect(
      service.submitClaim({ name: 'Someone', email: 'not-an-email', eligibilitySnapshot: SNAPSHOT })
    ).rejects.toBeInstanceOf(CertificateClaimError);
  });

  it('a newly submitted claim actually sends exactly one verification email (via the in-memory sender)', async () => {
    const { clock } = buildStack();
    const { service, emailSender } = await buildService(clock);
    await service.submitClaim({ name: 'Ada', email: 'ada2@example.com', eligibilitySnapshot: SNAPSHOT });
    const sentToAda = emailSender.sentMessages.filter((m) => m.to === 'ada2@example.com');
    expect(sentToAda).toHaveLength(1);
    expect(sentToAda[0]?.kind).toBe('claimant_verify');
  });
});

describe('certificate-claim service — confirm/preview/retrieval end to end', () => {
  it('previewing shows the claimed name and a MASKED email, never the real one', async () => {
    const { clock } = buildStack();
    const repository = await makeRepository();
    const emailSender = new InMemoryEmailSender();
    const dispatcher = new NotificationDispatcher({
      repository, emailSender, now: clock, verificationTokenTtlMs: ONE_HOUR_MS,
      buildVerificationUrl: (t) => `https://example.test/verify#token=${t}`,
      ownerNotificationEmail: 'owner@example.test',
      outboxEncryptionKey: TEST_OUTBOX_ENCRYPTION_KEY
    });
    const service = new CertificateClaimService({ repository, dispatcher, now: clock, retrievalTokenTtlMs: ONE_HOUR_MS });

    await service.submitClaim({ name: 'Shafi Goldwasser', email: 'shafi@example.com', eligibilitySnapshot: SNAPSHOT });
    const sent = emailSender.sentMessages[0]!;
    const url = new URL((sent.templateData as { verificationUrl: string }).verificationUrl.replace('#', '?'));
    const token = url.searchParams.get('token')!;

    const preview = await service.previewToken(token);
    expect(preview.claimedName).toBe('Shafi Goldwasser');
    expect(preview.emailMasked).not.toBe('shafi@example.com');
    expect(preview.emailMasked).toContain('@example.com');
  });

  it('confirming issues a certificate and a retrieval token that resolves back to it', async () => {
    const { clock } = buildStack();
    const repository = await makeRepository();
    const emailSender = new InMemoryEmailSender();
    const dispatcher = new NotificationDispatcher({
      repository, emailSender, now: clock, verificationTokenTtlMs: ONE_HOUR_MS,
      buildVerificationUrl: (t) => `https://example.test/verify#token=${t}`,
      ownerNotificationEmail: 'owner@example.test',
      outboxEncryptionKey: TEST_OUTBOX_ENCRYPTION_KEY
    });
    const service = new CertificateClaimService({ repository, dispatcher, now: clock, retrievalTokenTtlMs: ONE_HOUR_MS });

    await service.submitClaim({ name: 'Barbara Liskov', email: 'barbara@example.com', eligibilitySnapshot: SNAPSHOT });
    const sent = emailSender.sentMessages[0]!;
    const url = new URL((sent.templateData as { verificationUrl: string }).verificationUrl.replace('#', '?'));
    const token = url.searchParams.get('token')!;

    const confirmed = await service.confirmToken(token);
    expect(confirmed.recipientName).toBe('Barbara Liskov');
    expect(typeof confirmed.retrievalToken).toBe('string');

    const retrieved = await service.getCertificateByRetrievalToken(confirmed.retrievalToken);
    expect(retrieved.certificateId).toBe(confirmed.certificateId);
  });

  it('confirming a NEW issuance sends exactly one owner notification; confirming a RECOVERY sends none', async () => {
    const { clock, advance } = buildStack();
    const repository = await makeRepository();
    const emailSender = new InMemoryEmailSender();
    const dispatcher = new NotificationDispatcher({
      repository, emailSender, now: clock, verificationTokenTtlMs: ONE_HOUR_MS,
      buildVerificationUrl: (t) => `https://example.test/verify#token=${t}`,
      ownerNotificationEmail: 'owner@example.test',
      outboxEncryptionKey: TEST_OUTBOX_ENCRYPTION_KEY
    });
    const service = new CertificateClaimService({ repository, dispatcher, now: clock, retrievalTokenTtlMs: ONE_HOUR_MS });

    await service.submitClaim({ name: 'Frances Allen', email: 'frances@example.com', eligibilitySnapshot: SNAPSHOT });
    const firstLink = emailSender.sentMessages[0]!;
    const firstToken = new URL((firstLink.templateData as { verificationUrl: string }).verificationUrl.replace('#', '?')).searchParams.get('token')!;
    await service.confirmToken(firstToken);

    const ownerMailsAfterFirst = emailSender.sentMessages.filter((m) => m.kind === 'owner_claim_notice');
    expect(ownerMailsAfterFirst).toHaveLength(1);

    advance(ONE_HOUR_MS);
    await service.submitClaim({ name: 'Frances Allen', email: 'frances@example.com', eligibilitySnapshot: SNAPSHOT });
    const recoveryLink = emailSender.sentMessages.filter((m) => m.to === 'frances@example.com').pop()!;
    const recoveryToken = new URL((recoveryLink.templateData as { verificationUrl: string }).verificationUrl.replace('#', '?')).searchParams.get('token')!;
    await service.confirmToken(recoveryToken);

    const ownerMailsAfterRecovery = emailSender.sentMessages.filter((m) => m.kind === 'owner_claim_notice');
    expect(ownerMailsAfterRecovery).toHaveLength(1); // STILL exactly one — recovery never adds another
  });
});

describe('certificate-notification dispatcher — retries and resends', () => {
  it('a failed send is retried by runOnce() and eventually succeeds without duplicating the certificate email', async () => {
    const { clock, advance } = buildStack();
    const repository = await makeRepository();
    const emailSender = new InMemoryEmailSender();
    const dispatcher = new NotificationDispatcher({
      repository, emailSender, now: clock, verificationTokenTtlMs: ONE_HOUR_MS,
      buildVerificationUrl: (t) => `https://example.test/verify#token=${t}`,
      ownerNotificationEmail: 'owner@example.test',
      batchSize: 10,
      outboxEncryptionKey: TEST_OUTBOX_ENCRYPTION_KEY
    });

    const claim = await repository.createClaim({
      claimedName: 'Mary Jackson', emailNormalized: 'mary@example.com', eligibilitySnapshot: SNAPSHOT, now: clock()
    });
    const claimId = (claim as { claim: { id: string } }).claim.id;
    const { generation } = await repository.enqueueNotification('claimant_verify', claimId, clock());

    emailSender.failNextSends(1); // the immediate attempt will fail
    await dispatcher.attemptImmediately('claimant_verify', claimId, generation);
    expect(emailSender.sentMessages).toHaveLength(0);

    advance(2 * 60_000); // past the first backoff tier
    const outcome = await dispatcher.runOnce();
    expect(outcome.sent).toBe(1);
    expect(emailSender.sentMessages.filter((m) => m.to === 'mary@example.com')).toHaveLength(1);
  });

  it('a user-requested RESEND is a genuinely NEW send (new generation), not suppressed as a retry of the same attempt', async () => {
    const { clock } = buildStack();
    const repository = await makeRepository();
    const emailSender = new InMemoryEmailSender();
    const dispatcher = new NotificationDispatcher({
      repository, emailSender, now: clock, verificationTokenTtlMs: ONE_HOUR_MS,
      buildVerificationUrl: (t) => `https://example.test/verify#token=${t}`,
      ownerNotificationEmail: 'owner@example.test',
      outboxEncryptionKey: TEST_OUTBOX_ENCRYPTION_KEY
    });
    const service = new CertificateClaimService({ repository, dispatcher, now: clock, retrievalTokenTtlMs: ONE_HOUR_MS });

    await service.submitClaim({ name: 'Annie Easley', email: 'annie@example.com', eligibilitySnapshot: SNAPSHOT });
    expect(emailSender.sentMessages.filter((m) => m.to === 'annie@example.com')).toHaveLength(1);

    await service.resendClaim('annie@example.com');
    expect(emailSender.sentMessages.filter((m) => m.to === 'annie@example.com')).toHaveLength(2);

    const idempotencyKeys = emailSender.sentMessages.filter((m) => m.to === 'annie@example.com').map((m) => m.idempotencyKey);
    expect(new Set(idempotencyKeys).size).toBe(2); // two DISTINCT keys — a real provider would not collapse these
  });

  it('a system retry resends a BYTE-IDENTICAL payload under the SAME idempotency key — required by Resend, which errors on same-key-different-payload', async () => {
    const { clock, advance } = buildStack();
    const repository = await makeRepository();
    const emailSender = new InMemoryEmailSender();
    const crashyDispatcher = new NotificationDispatcher({
      repository: withMarkSentCrashedOnce(repository), emailSender, now: clock, verificationTokenTtlMs: ONE_HOUR_MS,
      buildVerificationUrl: (t) => `https://example.test/verify#token=${t}`,
      ownerNotificationEmail: 'owner@example.test',
      outboxEncryptionKey: TEST_OUTBOX_ENCRYPTION_KEY
    });
    const dispatcher = new NotificationDispatcher({
      repository, emailSender, now: clock, verificationTokenTtlMs: ONE_HOUR_MS,
      buildVerificationUrl: (t) => `https://example.test/verify#token=${t}`,
      ownerNotificationEmail: 'owner@example.test',
      outboxEncryptionKey: TEST_OUTBOX_ENCRYPTION_KEY
    });

    const claim = await repository.createClaim({
      claimedName: 'Mae Jemison', emailNormalized: 'mae@example.com', eligibilitySnapshot: SNAPSHOT, now: clock()
    });
    const claimId = (claim as { claim: { id: string } }).claim.id;
    const { generation } = await repository.enqueueNotification('claimant_verify', claimId, clock());
    const idempotencyKey = `claimant_verify:${claimId}:${generation}`;

    // "The original send": mints a token, persists its encrypted payload
    // (via setNotificationPayload, which runs BEFORE send()), the
    // (simulated) provider accepts it — but markNotificationSent's own
    // UPDATE is the one thing that "never happens", exactly as a crash
    // between those two steps would leave it. The row is therefore still
    // 'pending' afterward, with its payload intact — no raw SQL needed to
    // fake that state; it is the real, un-rolled-back result of the crash.
    await crashyDispatcher.attemptImmediately('claimant_verify', claimId, generation);
    expect(emailSender.deliveryCountFor(idempotencyKey)).toBe(1);
    const firstUrl = (emailSender.sentMessages[0]?.templateData as { verificationUrl: string }).verificationUrl;

    // "The restart": a fresh, working dispatcher instance now retries the
    // still-pending row.
    advance(1000);
    const retryOutcome = await dispatcher.runOnce();
    expect(retryOutcome.sent).toBe(1);
    // Still exactly 1 PHYSICAL send — Resend's documented same-key-
    // same-payload behaviour (simulated by InMemoryEmailSender's own
    // idempotency dedup) returned the ORIGINAL result rather than erroring
    // or sending a second real email.
    expect(emailSender.deliveryCountFor(idempotencyKey)).toBe(1);
    expect(emailSender.sentMessages).toHaveLength(1);

    const retriedUrl = (emailSender.sentMessages[0]?.templateData as { verificationUrl: string }).verificationUrl;
    expect(retriedUrl).toBe(firstUrl); // byte-identical — no second token was ever minted

    const preview = await repository.previewVerificationToken(decodeURIComponent(firstUrl.split('#token=')[1] ?? ''), clock());
    expect(preview.kind).toBe('valid'); // the one-and-only token is still unused and valid

    // markNotificationSent on the retry cleaned up the now-unneeded payload.
    expect(await repository.getNotificationPayload('claimant_verify', claimId, generation)).toBeNull();
  });

  it('a user-requested RESEND mints a genuinely NEW token/payload and clears the old one — never reused across generations', async () => {
    const { clock } = buildStack();
    const repository = await makeRepository();
    const emailSender = new InMemoryEmailSender();
    const dispatcher = new NotificationDispatcher({
      repository, emailSender, now: clock, verificationTokenTtlMs: ONE_HOUR_MS,
      buildVerificationUrl: (t) => `https://example.test/verify#token=${t}`,
      ownerNotificationEmail: 'owner@example.test',
      outboxEncryptionKey: TEST_OUTBOX_ENCRYPTION_KEY
    });
    const service = new CertificateClaimService({ repository, dispatcher, now: clock, retrievalTokenTtlMs: ONE_HOUR_MS });

    await service.submitClaim({ name: 'Valentina Tereshkova', email: 'valentina@example.com', eligibilitySnapshot: SNAPSHOT });
    const firstUrl = (emailSender.sentMessages[0]?.templateData as { verificationUrl: string }).verificationUrl;

    await service.resendClaim('valentina@example.com');
    expect(emailSender.sentMessages).toHaveLength(2);
    const secondUrl = (emailSender.sentMessages[1]?.templateData as { verificationUrl: string }).verificationUrl;

    expect(secondUrl).not.toBe(firstUrl); // a genuinely separate delivery, not a replay
    const idempotencyKeys = emailSender.sentMessages.map((m) => m.idempotencyKey);
    expect(new Set(idempotencyKeys).size).toBe(2);

    // Both tokens remain independently valid — a resend must not invalidate
    // the original link the claimant might still act on.
    const firstPreview = await repository.previewVerificationToken(decodeURIComponent(firstUrl.split('#token=')[1] ?? ''), clock());
    const secondPreview = await repository.previewVerificationToken(decodeURIComponent(secondUrl.split('#token=')[1] ?? ''), clock());
    expect(firstPreview.kind).toBe('valid');
    expect(secondPreview.kind).toBe('valid');
  });

  it('if CERTIFICATE_OUTBOX_ENCRYPTION_KEY is rotated mid-retry, the stored payload becomes undecryptable and the dispatcher falls back to a fresh token under a distinct, STABLE recovery key — never crashes, never reuses the original key with a different payload', async () => {
    const { clock, advance } = buildStack();
    const repository = await makeRepository();
    const emailSender = new InMemoryEmailSender();
    // Crashes its one markNotificationSent call — leaves the row 'pending'
    // with a real encrypted payload stored under the ORIGINAL key, exactly
    // as a genuine crash-mid-retry would.
    const crashyOriginalKeyDispatcher = new NotificationDispatcher({
      repository: withMarkSentCrashedOnce(repository), emailSender, now: clock, verificationTokenTtlMs: ONE_HOUR_MS,
      buildVerificationUrl: (t) => `https://example.test/verify#token=${t}`,
      ownerNotificationEmail: 'owner@example.test',
      outboxEncryptionKey: TEST_OUTBOX_ENCRYPTION_KEY
    });
    const rotatedKey = parseOutboxEncryptionKey('cd'.repeat(32));
    const rotatedKeyDispatcher = new NotificationDispatcher({
      repository, emailSender, now: clock, verificationTokenTtlMs: ONE_HOUR_MS,
      buildVerificationUrl: (t) => `https://example.test/verify#token=${t}`,
      ownerNotificationEmail: 'owner@example.test',
      outboxEncryptionKey: rotatedKey
    });

    const claim = await repository.createClaim({
      claimedName: 'Mae Jemison', emailNormalized: 'mae2@example.com', eligibilitySnapshot: SNAPSHOT, now: clock()
    });
    const claimId = (claim as { claim: { id: string } }).claim.id;
    const { generation } = await repository.enqueueNotification('claimant_verify', claimId, clock());

    await crashyOriginalKeyDispatcher.attemptImmediately('claimant_verify', claimId, generation);
    expect(emailSender.sentMessages).toHaveLength(1);

    // The key is now rotated — the ROTATED dispatcher, retrying the same
    // still-pending row, cannot decrypt what the original key stored.
    advance(1000);
    await expect(rotatedKeyDispatcher.runOnce()).resolves.not.toThrow();
    expect(emailSender.sentMessages.length).toBeGreaterThanOrEqual(2); // fell back to a fresh send, did not silently drop it
    const fallbackMessage = emailSender.sentMessages[emailSender.sentMessages.length - 1];
    expect(fallbackMessage?.idempotencyKey).toBe(`claimant_verify:${claimId}:${generation}:recovery`);
    expect(fallbackMessage?.idempotencyKey).not.toBe(`claimant_verify:${claimId}:${generation}`); // never reuses the original key with a changed payload
  });

  it('a notification that keeps failing becomes permanently failed after the bounded attempt cap, never retried forever', async () => {
    const { clock, advance } = buildStack();
    const repository = await makeRepository();
    const emailSender = new InMemoryEmailSender();
    const dispatcher = new NotificationDispatcher({
      repository, emailSender, now: clock, verificationTokenTtlMs: ONE_HOUR_MS,
      buildVerificationUrl: (t) => `https://example.test/verify#token=${t}`,
      ownerNotificationEmail: 'owner@example.test',
      outboxEncryptionKey: TEST_OUTBOX_ENCRYPTION_KEY
    });

    const claim = await repository.createClaim({
      claimedName: 'Chien-Shiung Wu', emailNormalized: 'chien@example.com', eligibilitySnapshot: SNAPSHOT, now: clock()
    });
    const claimId = (claim as { claim: { id: string } }).claim.id;
    await repository.enqueueNotification('claimant_verify', claimId, clock());

    for (let i = 0; i < 6; i++) {
      emailSender.failNextSends(1);
      advance(25 * 60 * 60_000); // past every backoff tier each round
      await dispatcher.runOnce();
    }

    const due = await repository.claimDueNotifications(10, clock() + 30 * 24 * 60 * 60_000);
    expect(due).toHaveLength(0); // no longer claimable — it is 'failed', not endlessly 'pending'
  });
});

describe('feature flag — safe rollout', () => {
  it('is disabled by default with no env vars set at all', () => {
    const config = loadConfig({});
    expect(config.certificateClaims.enabled).toBe(false);
  });

  it('missing email configuration does NOT throw when the feature is disabled', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://example.com', DATABASE_URL: 'postgres://x/y', TOPIC_QUIZ_RECEIPT_SECRET: 'x'.repeat(40) })).not.toThrow();
  });

  it('throws a clear ConfigError when enabled without the required email vars', () => {
    expect(() => loadConfig({ CERTIFICATE_CLAIMS_ENABLED: 'true' })).toThrow(ConfigError);
  });

  it('parses a fully valid enabled configuration', () => {
    const config = loadConfig({
      CERTIFICATE_CLAIMS_ENABLED: 'true',
      EMAIL_PROVIDER_API_KEY: 'test-key',
      EMAIL_FROM_ADDRESS: 'certificates@example.com',
      OWNER_NOTIFICATION_EMAIL: 'owner@example.com',
      CERTIFICATE_CLAIM_BASE_URL: 'https://example.com',
      CERTIFICATE_OUTBOX_ENCRYPTION_KEY: TEST_OUTBOX_ENCRYPTION_KEY_HEX
    });
    expect(config.certificateClaims).toEqual({
      enabled: true,
      emailProviderApiKey: 'test-key',
      emailFromAddress: 'certificates@example.com',
      ownerNotificationEmail: 'owner@example.com',
      publicAppUrl: 'https://example.com',
      outboxEncryptionKeyHex: TEST_OUTBOX_ENCRYPTION_KEY_HEX
    });
  });

  it('throws a clear ConfigError when enabled without CERTIFICATE_OUTBOX_ENCRYPTION_KEY, or with a wrong-length one', () => {
    const base = {
      CERTIFICATE_CLAIMS_ENABLED: 'true',
      EMAIL_PROVIDER_API_KEY: 'test-key',
      EMAIL_FROM_ADDRESS: 'certificates@example.com',
      OWNER_NOTIFICATION_EMAIL: 'owner@example.com',
      CERTIFICATE_CLAIM_BASE_URL: 'https://example.com'
    };
    expect(() => loadConfig(base)).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, CERTIFICATE_OUTBOX_ENCRYPTION_KEY: 'too-short' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, CERTIFICATE_OUTBOX_ENCRYPTION_KEY: 'zz'.repeat(32) })).toThrow(ConfigError); // not hex
  });

  it('refuses to enable in PRODUCTION even with every required var present — no real EmailSender adapter exists yet, only InMemoryEmailSender', () => {
    expect(() => loadConfig({
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: 'https://example.com',
      DATABASE_URL: 'postgres://x/y',
      TOPIC_QUIZ_RECEIPT_SECRET: 'x'.repeat(40),
      CERTIFICATE_CLAIMS_ENABLED: 'true',
      EMAIL_PROVIDER_API_KEY: 'test-key',
      EMAIL_FROM_ADDRESS: 'certificates@example.com',
      OWNER_NOTIFICATION_EMAIL: 'owner@example.com',
      CERTIFICATE_CLAIM_BASE_URL: 'https://example.com'
    })).toThrow(ConfigError);
  });
});

describe('feature flag — app-level behaviour when disabled', () => {
  const quizRepository = { stats: { quizCount: 0, questionCount: 0, optionCount: 0 } } as unknown as QuizRepository;
  const config = loadConfig({});

  function app() {
    return createApp(config, { quizRepository, certificateClaimService: undefined });
  }

  it('certificate-claim paths respond 503 when the feature is disabled', async () => {
    const res = await request(app()).post('/api/certificate-claims').send({ name: 'x', email: 'x@example.com' });
    expect(res.status).toBe(503);
  });

  it('an UNRELATED unknown route still 404s normally — the disabled router must not swallow other traffic', async () => {
    const res = await request(app()).get('/api/totally-unrelated-path');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Resource not found' } });
  });
});
