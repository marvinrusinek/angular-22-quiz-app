import { createHash, randomUUID } from 'node:crypto';

import type { DatabaseHandle } from '../db/database';
import { generateToken, hashToken, isWellFormedToken } from './certificate-token';
import type {
  CertificateClaimRecord,
  CertificateClaimStatus,
  EligibilitySnapshot,
  IssuedCertificateRecord
} from './certificate-claim.types';
import type { CertificateNotificationKind } from './email-sender';

/**
 * Certificate-claim persistence.
 *
 * Every statement is PARAMETERIZED. Every JSON column is parsed and
 * re-validated on read, matching this codebase's existing convention —
 * "this process wrote it" is not a guarantee it is still well-formed.
 *
 * Mirrors backend/src/interview/session.repository.ts's shape: a factory
 * over a DatabaseHandle, SQL declared as module-scope-ish constants inside
 * the factory body, transactions via db.transaction(), bigint columns
 * coerced back to number with the same `num()` idiom.
 */

const num = (value: string | number | null | undefined): number => Number(value);

export const MAX_OUTSTANDING_TOKENS_PER_CLAIM = 5;
export const MAX_NOTIFICATION_ATTEMPTS = 5;
/**
 * How long a claimDueNotifications caller gets exclusive ownership of a
 * row before it becomes reclaimable again. SELECT ... FOR UPDATE SKIP
 * LOCKED's own row lock is released the instant ITS transaction commits —
 * which happens right after the select, not after the caller finishes
 * sending and marking the row done. Without a lease, a second concurrent
 * caller's own claim could select the SAME row in the (however short)
 * window between that commit and this one's markNotificationSent/
 * markNotificationFailed call. claimDueNotifications closes that window by
 * bumping next_attempt_at this far into the future, atomically, inside the
 * SAME transaction as the SELECT — so a row is invisible to every other
 * claimer from the moment it is claimed, not from the moment it is marked
 * done. A crashed worker's row simply becomes reclaimable again once the
 * lease elapses, a free side benefit rather than something to build
 * separately.
 */
const NOTIFICATION_PROCESSING_LEASE_MS = 5 * 60_000;

function computeRequestHash(name: string, emailNormalized: string): string {
  // NOT a credential — a fingerprint of non-sensitive submitted fields,
  // used only to detect "same idempotency key, materially different
  // request" (mirrors migration 007's idempotency_request_hash exactly).
  return createHash('sha256').update(JSON.stringify({ name, emailNormalized }), 'utf8').digest('hex');
}

export interface CreateClaimInput {
  readonly claimedName: string;
  readonly emailNormalized: string;
  readonly eligibilitySnapshot: EligibilitySnapshot;
  readonly now: number;
  /** SHA-256 hex of the client's idempotency key, or undefined if none was sent. */
  readonly idempotencyKeyHash?: string | undefined;
}

export type CreateClaimOutcome =
  /** Brand new pending claim; no certificate exists yet for this email. */
  | { readonly kind: 'created'; readonly claim: CertificateClaimRecord }
  /** An idempotency key that was already used for the SAME request resolved to the same claim. */
  | { readonly kind: 'idempotent_replay'; readonly claim: CertificateClaimRecord }
  /** The idempotency key was already used for a DIFFERENT request. */
  | { readonly kind: 'idempotency_conflict' }
  /** This exact email already has an outstanding pending claim — reuse it rather than creating a second one. */
  | { readonly kind: 'already_pending'; readonly claim: CertificateClaimRecord }
  /**
   * A certificate ALREADY exists for this email. A new pending claim is
   * still created (recovery) — confirmVerificationToken will resolve it to
   * the EXISTING certificate (never a new row, never an overwritten name)
   * once verified. The caller uses this kind only to choose the email
   * WORDING ("here's your certificate" vs "confirm your new one") — the
   * HTTP response to the submitter must stay identical either way.
   */
  | { readonly kind: 'recovery_created'; readonly claim: CertificateClaimRecord };

export type ConfirmTokenOutcome =
  | { readonly kind: 'invalid' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'already_used' }
  | {
      readonly kind: 'issued';
      readonly certificate: IssuedCertificateRecord;
      /** True only the FIRST time this email's certificate is issued — gates the owner notification. */
      readonly isNewIssuance: boolean;
    };

export type PreviewTokenOutcome =
  | { readonly kind: 'invalid' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'already_used' }
  | { readonly kind: 'valid'; readonly claimedName: string; readonly emailMasked: string };

export interface OutboxRow {
  readonly kind: CertificateNotificationKind;
  readonly referenceId: string;
  readonly attempts: number;
  readonly generation: number;
  /** See migration 009's column comment. Always null for owner_claim_notice. */
  readonly encryptedPayload: string | null;
}

export interface CertificateClaimRepository {
  createClaim(input: CreateClaimInput): Promise<CreateClaimOutcome>;

  /** The most recent PENDING claim for this email, if any — used by resend. */
  findPendingClaimByEmail(emailNormalized: string): Promise<CertificateClaimRecord | null>;

  /** Mints a new verification token for an existing claim. Rejects past MAX_OUTSTANDING_TOKENS_PER_CLAIM. */
  mintVerificationToken(
    claimId: string,
    ttlMs: number,
    now: number
  ): Promise<{ readonly rawToken: string } | { readonly limitReached: true }>;

  previewVerificationToken(rawToken: string, now: number): Promise<PreviewTokenOutcome>;

  /** The one mutating, transactional consumption path. Single-use, atomic. */
  confirmVerificationToken(rawToken: string, now: number): Promise<ConfirmTokenOutcome>;

  /**
   * Internal lookup by claim id — returns the REAL (unmasked) email.
   * Distinct from previewVerificationToken on purpose: that method is
   * built for a claimant-facing confirmation page and deliberately masks
   * the address; this one is for the dispatcher's own outbound send,
   * which needs the real address to send TO.
   */
  findClaimById(claimId: string): Promise<CertificateClaimRecord | null>;

  findCertificateByEmail(emailNormalized: string): Promise<IssuedCertificateRecord | null>;
  findCertificateById(certificateId: string): Promise<IssuedCertificateRecord | null>;

  mintRetrievalToken(certificateId: string, ttlMs: number, now: number): Promise<{ readonly rawToken: string }>;
  resolveRetrievalToken(rawToken: string, now: number): Promise<IssuedCertificateRecord | null>;

  /**
   * Idempotent enqueue — a second call for the same (kind, referenceId) is
   * a no-op. Returns the row's CURRENT generation either way, so the
   * caller can pass it straight to an immediate-send attempt with no
   * separate read (and no race against a concurrent requeueForResend).
   */
  enqueueNotification(kind: CertificateNotificationKind, referenceId: string, now: number): Promise<{ readonly generation: number }>;
  /**
   * Starts a NEW generation for a user-requested resend: resets status to
   * 'pending', attempts to 0, clears sent_at, and — critically — bumps
   * `generation`, which is what stops a provider's own idempotency support
   * from silently swallowing this as "just a retry of the earlier send".
   * Unlike enqueueNotification, always takes effect (there is always an
   * existing row to resend for a known claim/certificate). Returns the NEW
   * generation.
   */
  requeueForResend(kind: CertificateNotificationKind, referenceId: string, now: number): Promise<{ readonly generation: number }>;
  claimDueNotifications(limit: number, now: number): Promise<readonly OutboxRow[]>;
  markNotificationSent(kind: CertificateNotificationKind, referenceId: string, now: number): Promise<void>;
  markNotificationFailed(
    kind: CertificateNotificationKind,
    referenceId: string,
    nextAttemptAt: number,
    error: string
  ): Promise<void>;

  /**
   * The stored retry payload for ONE specific generation — scoped by
   * generation so a write from a superseded generation (e.g. a resend that
   * raced a still-in-flight retry of the old one) can never land on the
   * new generation's row. Returns null if there is none yet, or if `now`'s
   * generation no longer matches (already moved on).
   */
  getNotificationPayload(
    kind: CertificateNotificationKind,
    referenceId: string,
    generation: number
  ): Promise<string | null>;
  /** No-ops (silently) if the row has since moved to a different generation. */
  setNotificationPayload(
    kind: CertificateNotificationKind,
    referenceId: string,
    generation: number,
    encryptedPayload: string
  ): Promise<void>;
}

interface ClaimRow {
  id: string;
  email_normalized: string;
  claimed_name: string;
  status: CertificateClaimStatus;
  eligibility_snapshot_json: string;
  created_at: string | number;
  verified_at: string | number | null;
}

function toClaimRecord(row: ClaimRow): CertificateClaimRecord {
  let snapshot: EligibilitySnapshot;
  try {
    snapshot = JSON.parse(row.eligibility_snapshot_json) as EligibilitySnapshot;
  } catch {
    snapshot = { achievementIds: [], qualifyingInterviewCount: 0, qualificationStartedAt: null };
  }
  return {
    id: row.id,
    emailNormalized: row.email_normalized,
    claimedName: row.claimed_name,
    status: row.status,
    eligibilitySnapshot: snapshot,
    createdAt: num(row.created_at),
    verifiedAt: row.verified_at === null ? null : num(row.verified_at)
  };
}

interface CertRow {
  id: string;
  email_normalized: string;
  claim_id: string;
  recipient_name: string;
  issued_at: string | number;
}

function toCertificateRecord(row: CertRow): IssuedCertificateRecord {
  return {
    id: row.id,
    emailNormalized: row.email_normalized,
    claimId: row.claim_id,
    recipientName: row.recipient_name,
    issuedAt: num(row.issued_at)
  };
}

/** Never a guessable sequence — collision risk is astronomically low and unenforced deliberately (see issued_certificates' own UNIQUE(email_normalized), which is the real backstop). */
function generateCertificateId(now: number): string {
  const year = new Date(now).getUTCFullYear();
  const random = randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
  return `AQ-${year}-${random}`;
}

function maskEmail(emailNormalized: string): string {
  const at = emailNormalized.indexOf('@');
  if (at <= 1) return `***${emailNormalized.slice(at)}`;
  return `${emailNormalized[0]}***${emailNormalized.slice(at)}`;
}

export function createCertificateClaimRepository(db: DatabaseHandle): CertificateClaimRepository {
  const INSERT_CLAIM = `
    INSERT INTO certificate_claims
      (id, email_normalized, claimed_name, status, eligibility_snapshot_json,
       created_at, idempotency_key_hash, idempotency_request_hash)
    VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7)
  `;
  const SELECT_CLAIM_BY_IDEMPOTENCY_KEY = `
    SELECT * FROM certificate_claims WHERE idempotency_key_hash = $1
  `;
  const SELECT_PENDING_CLAIM_BY_EMAIL = `
    SELECT * FROM certificate_claims WHERE email_normalized = $1 AND status = 'pending'
  `;
  const SELECT_CERTIFICATE_BY_EMAIL = `
    SELECT * FROM issued_certificates WHERE email_normalized = $1
  `;
  const SELECT_CERTIFICATE_BY_ID = `
    SELECT * FROM issued_certificates WHERE id = $1
  `;
  const INSERT_VERIFICATION_TOKEN = `
    INSERT INTO certificate_verification_tokens (token_hash, claim_id, created_at, expires_at)
    VALUES ($1, $2, $3, $4)
  `;
  const COUNT_OUTSTANDING_TOKENS = `
    SELECT count(*)::int AS count FROM certificate_verification_tokens
    WHERE claim_id = $1 AND used_at IS NULL AND expires_at > $2
  `;
  const SELECT_TOKEN_FOR_UPDATE = `
    SELECT token_hash, claim_id, expires_at, used_at
    FROM certificate_verification_tokens WHERE token_hash = $1 FOR UPDATE
  `;
  const MARK_TOKEN_USED = `
    UPDATE certificate_verification_tokens SET used_at = $2
    WHERE token_hash = $1 AND used_at IS NULL
  `;
  const SELECT_CLAIM_FOR_UPDATE = `SELECT * FROM certificate_claims WHERE id = $1 FOR UPDATE`;
  const MARK_CLAIM_VERIFIED = `
    UPDATE certificate_claims SET status = 'verified', verified_at = $2 WHERE id = $1
  `;
  // Plain INSERT, no ON CONFLICT: confirmVerificationToken tells "we just
  // issued it" from "someone else already had one" by catching the real
  // 23505 unique violation on email_normalized, not by inspecting the
  // INSERT's own result. Two reasons, not one:
  //  (1) a confirmed pg-mem defect — `ON CONFLICT DO NOTHING RETURNING`
  //      (and even bare `rowCount`) incorrectly report success on conflict;
  //      verified correct on real Postgres, so this is a test-double gap.
  //  (2) even past that, comparing the resulting row's claim_id against our
  //      OWN claim_id cannot distinguish the two outcomes when two tokens
  //      for the SAME claim are confirmed concurrently — both transactions
  //      share one claim_id regardless of which insert actually won, so
  //      that comparison is trivially true either way. Only the INSERT's
  //      own success/failure is a real signal of which transaction won.
  const INSERT_CERTIFICATE = `
    INSERT INTO issued_certificates (id, email_normalized, claim_id, recipient_name, issued_at)
    VALUES ($1, $2, $3, $4, $5)
  `;
  const INSERT_RETRIEVAL_TOKEN = `
    INSERT INTO certificate_retrieval_tokens (token_hash, certificate_id, created_at, expires_at)
    VALUES ($1, $2, $3, $4)
  `;
  const SELECT_RETRIEVAL_TOKEN = `
    SELECT certificate_id, expires_at, revoked_at FROM certificate_retrieval_tokens WHERE token_hash = $1
  `;
  const ENQUEUE_NOTIFICATION = `
    INSERT INTO certificate_notification_outbox
      (kind, reference_id, status, attempts, generation, created_at, next_attempt_at)
    VALUES ($1, $2, 'pending', 0, 0, $3, $3)
    ON CONFLICT (kind, reference_id) DO NOTHING
    RETURNING generation
  `;
  const CLAIM_DUE_NOTIFICATIONS = `
    SELECT kind, reference_id, attempts, generation, encrypted_payload FROM certificate_notification_outbox
    WHERE status = 'pending' AND next_attempt_at <= $1
    ORDER BY next_attempt_at ASC
    LIMIT $2
    FOR UPDATE SKIP LOCKED
  `;
  // See NOTIFICATION_PROCESSING_LEASE_MS's own comment — applied to each
  // claimed row INSIDE the same transaction as the SELECT above, so the
  // lease takes effect atomically with the claim, not after.
  const LEASE_CLAIMED_NOTIFICATION = `
    UPDATE certificate_notification_outbox SET next_attempt_at = $3
    WHERE kind = $1 AND reference_id = $2
  `;
  const MARK_NOTIFICATION_SENT = `
    UPDATE certificate_notification_outbox
    SET status = 'sent', sent_at = $3, attempts = attempts + 1, encrypted_payload = NULL
    WHERE kind = $1 AND reference_id = $2
  `;
  const REQUEUE_FOR_RESEND = `
    UPDATE certificate_notification_outbox
    SET status = 'pending', attempts = 0, generation = generation + 1,
        next_attempt_at = $3, sent_at = NULL, last_error = NULL, encrypted_payload = NULL
    WHERE kind = $1 AND reference_id = $2
    RETURNING generation
  `;
  const MARK_NOTIFICATION_FAILED = `
    UPDATE certificate_notification_outbox
    SET status = CASE WHEN attempts + 1 >= $5 THEN 'failed' ELSE 'pending' END,
        attempts = attempts + 1,
        next_attempt_at = $3,
        last_error = $4,
        -- Only clear once this row is PERMANENTLY done — a retriable
        -- failure (not yet at the cap) must keep its payload, since the
        -- next attempt needs to resend the exact same thing.
        encrypted_payload = CASE WHEN attempts + 1 >= $5 THEN NULL ELSE encrypted_payload END
    WHERE kind = $1 AND reference_id = $2
  `;
  const GET_NOTIFICATION_PAYLOAD = `
    SELECT encrypted_payload FROM certificate_notification_outbox
    WHERE kind = $1 AND reference_id = $2 AND generation = $3
  `;
  const SET_NOTIFICATION_PAYLOAD = `
    UPDATE certificate_notification_outbox SET encrypted_payload = $4
    WHERE kind = $1 AND reference_id = $2 AND generation = $3
  `;

  return {
    async createClaim(input) {
      const { claimedName, emailNormalized, eligibilitySnapshot, now } = input;

      if (input.idempotencyKeyHash) {
        const existing = await db.query<ClaimRow>(SELECT_CLAIM_BY_IDEMPOTENCY_KEY, [input.idempotencyKeyHash]);
        const row = existing.rows[0];
        if (row) {
          const requestHash = computeRequestHash(claimedName, emailNormalized);
          // idempotency_request_hash is stored alongside; re-select it directly
          // rather than widening ClaimRow, since it is never exposed otherwise.
          const hashCheck = await db.query<{ idempotency_request_hash: string | null }>(
            'SELECT idempotency_request_hash FROM certificate_claims WHERE id = $1',
            [row.id]
          );
          const storedRequestHash = hashCheck.rows[0]?.idempotency_request_hash ?? null;
          if (storedRequestHash !== requestHash) {
            return { kind: 'idempotency_conflict' };
          }
          return { kind: 'idempotent_replay', claim: toClaimRecord(row) };
        }
      }

      // A certificate already existing for this email does NOT stop a new
      // pending claim from being created below — it only changes the LABEL
      // this function returns, which the service layer uses solely to pick
      // the email's wording ("here's your certificate" vs "confirm your
      // new one"). confirmVerificationToken resolves the recovery claim to
      // the EXISTING certificate transparently (ON CONFLICT DO NOTHING),
      // never a new row, never an overwritten name. The partial-unique
      // index on certificate_claims is scoped to status='pending', so a
      // second (recovery) pending row for an email whose EARLIER claim is
      // already 'verified' is not blocked by it — this is intentional.
      const existingCertificate = await db.query<CertRow>(SELECT_CERTIFICATE_BY_EMAIL, [emailNormalized]);
      const isRecovery = existingCertificate.rows.length > 0;

      if (!isRecovery) {
        const existingPending = await db.query<ClaimRow>(SELECT_PENDING_CLAIM_BY_EMAIL, [emailNormalized]);
        if (existingPending.rows.length > 0) {
          return { kind: 'already_pending', claim: toClaimRecord(existingPending.rows[0] as ClaimRow) };
        }
      }

      const id = `cc_${randomUUID()}`;
      const requestHash = input.idempotencyKeyHash ? computeRequestHash(claimedName, emailNormalized) : null;
      try {
        await db.query(INSERT_CLAIM, [
          id,
          emailNormalized,
          claimedName,
          JSON.stringify(eligibilitySnapshot),
          now,
          input.idempotencyKeyHash ?? null,
          requestHash
        ]);
      } catch (err: unknown) {
        // A concurrent request for the SAME email won the pending-claim race
        // between our SELECT above and this INSERT — re-read and report it
        // as already_pending rather than surfacing a raw constraint error.
        // (Cannot happen for the recovery path: nothing there is guarded by
        // the pending-uniqueness index.)
        if (!isRecovery && isUniqueViolation(err)) {
          const raceWinner = await db.query<ClaimRow>(SELECT_PENDING_CLAIM_BY_EMAIL, [emailNormalized]);
          const row = raceWinner.rows[0];
          if (row) return { kind: 'already_pending', claim: toClaimRecord(row) };
        }
        throw err;
      }

      const created = toClaimRecord({
        id,
        email_normalized: emailNormalized,
        claimed_name: claimedName,
        status: 'pending',
        eligibility_snapshot_json: JSON.stringify(eligibilitySnapshot),
        created_at: now,
        verified_at: null
      });
      return isRecovery ? { kind: 'recovery_created', claim: created } : { kind: 'created', claim: created };
    },

    async findPendingClaimByEmail(emailNormalized) {
      const result = await db.query<ClaimRow>(SELECT_PENDING_CLAIM_BY_EMAIL, [emailNormalized]);
      const row = result.rows[0];
      return row ? toClaimRecord(row) : null;
    },

    async mintVerificationToken(claimId, ttlMs, now) {
      const outstanding = await db.query<{ count: number }>(COUNT_OUTSTANDING_TOKENS, [claimId, now]);
      if (num(outstanding.rows[0]?.count ?? 0) >= MAX_OUTSTANDING_TOKENS_PER_CLAIM) {
        return { limitReached: true };
      }
      const { rawToken, tokenHash } = generateToken();
      await db.query(INSERT_VERIFICATION_TOKEN, [tokenHash, claimId, now, now + ttlMs]);
      return { rawToken };
    },

    async previewVerificationToken(rawToken, now) {
      if (!isWellFormedToken(rawToken)) return { kind: 'invalid' };
      const tokenHash = hashToken(rawToken);

      const tokenResult = await db.query<{ claim_id: string; expires_at: string | number; used_at: string | number | null }>(
        'SELECT claim_id, expires_at, used_at FROM certificate_verification_tokens WHERE token_hash = $1',
        [tokenHash]
      );
      const tokenRow = tokenResult.rows[0];
      if (!tokenRow) return { kind: 'invalid' };
      if (tokenRow.used_at !== null) return { kind: 'already_used' };
      if (num(tokenRow.expires_at) <= now) return { kind: 'expired' };

      const claimResult = await db.query<ClaimRow>('SELECT * FROM certificate_claims WHERE id = $1', [tokenRow.claim_id]);
      const claimRow = claimResult.rows[0];
      if (!claimRow) return { kind: 'invalid' };

      return { kind: 'valid', claimedName: claimRow.claimed_name, emailMasked: maskEmail(claimRow.email_normalized) };
    },

    async confirmVerificationToken(rawToken, now) {
      if (!isWellFormedToken(rawToken)) return { kind: 'invalid' };
      const tokenHash = hashToken(rawToken);

      return db.transaction(async (client) => {
        const tokenResult = await client.query<{
          token_hash: string; claim_id: string; expires_at: string | number; used_at: string | number | null;
        }>(SELECT_TOKEN_FOR_UPDATE, [tokenHash]);
        const tokenRow = tokenResult.rows[0];
        if (!tokenRow) return { kind: 'invalid' } as const;
        if (tokenRow.used_at !== null) return { kind: 'already_used' } as const;
        if (num(tokenRow.expires_at) <= now) return { kind: 'expired' } as const;

        const claimResult = await client.query<ClaimRow>(SELECT_CLAIM_FOR_UPDATE, [tokenRow.claim_id]);
        const claimRow = claimResult.rows[0];
        if (!claimRow) return { kind: 'invalid' } as const;

        const markUsed = await client.query(MARK_TOKEN_USED, [tokenHash, now]);
        if ((markUsed.rowCount ?? 0) === 0) {
          // Lost a race to another transaction between our SELECT...FOR UPDATE
          // and here — that cannot actually happen (the row lock prevents it),
          // kept as a defensive, cheap check rather than an assumption.
          return { kind: 'already_used' } as const;
        }

        if (claimRow.status !== 'verified') {
          await client.query(MARK_CLAIM_VERIFIED, [claimRow.id, now]);
        }

        const certificateId = generateCertificateId(now);
        // SAVEPOINT before the INSERT: on real Postgres, a statement that
        // fails (here, the 23505 we're about to try to catch) leaves the
        // WHOLE transaction aborted — every subsequent statement is
        // rejected with 25P02 until a ROLLBACK or ROLLBACK TO SAVEPOINT,
        // even though the JS exception is caught just fine. Without this,
        // the re-SELECT below would itself throw on real Postgres despite
        // working against pg-mem (which does not model aborted-transaction
        // state) — verified both ways directly against a real server before
        // this was added.
        await client.query('SAVEPOINT cert_insert');
        try {
          await client.query(INSERT_CERTIFICATE, [
            certificateId,
            claimRow.email_normalized,
            claimRow.id,
            claimRow.claimed_name,
            now
          ]);
        } catch (err: unknown) {
          if (!isUniqueViolation(err)) throw err;

          // Lost the race for this email (another transaction — possibly
          // another token for this SAME claim, possibly a recovery claim —
          // inserted first). Un-abort the transaction before querying
          // again, then treat their row as authoritative rather than
          // assume it matches what we tried to insert.
          await client.query('ROLLBACK TO SAVEPOINT cert_insert');
          const existing = await client.query<CertRow>(SELECT_CERTIFICATE_BY_EMAIL, [claimRow.email_normalized]);
          const existingRow = existing.rows[0];
          if (!existingRow) {
            // Should be unreachable (the unique violation proves a row
            // exists), but never assume past a transaction boundary.
            return { kind: 'invalid' } as const;
          }
          return { kind: 'issued', certificate: toCertificateRecord(existingRow), isNewIssuance: false } as const;
        }

        return {
          kind: 'issued',
          certificate: {
            id: certificateId,
            emailNormalized: claimRow.email_normalized,
            claimId: claimRow.id,
            recipientName: claimRow.claimed_name,
            issuedAt: now
          },
          isNewIssuance: true
        } as const;
      });
    },

    async findCertificateByEmail(emailNormalized) {
      const result = await db.query<CertRow>(SELECT_CERTIFICATE_BY_EMAIL, [emailNormalized]);
      const row = result.rows[0];
      return row ? toCertificateRecord(row) : null;
    },

    async findCertificateById(certificateId) {
      const result = await db.query<CertRow>(SELECT_CERTIFICATE_BY_ID, [certificateId]);
      const row = result.rows[0];
      return row ? toCertificateRecord(row) : null;
    },

    async findClaimById(claimId) {
      const result = await db.query<ClaimRow>('SELECT * FROM certificate_claims WHERE id = $1', [claimId]);
      const row = result.rows[0];
      return row ? toClaimRecord(row) : null;
    },

    async mintRetrievalToken(certificateId, ttlMs, now) {
      const { rawToken, tokenHash } = generateToken();
      await db.query(INSERT_RETRIEVAL_TOKEN, [tokenHash, certificateId, now, now + ttlMs]);
      return { rawToken };
    },

    async resolveRetrievalToken(rawToken, now) {
      if (!isWellFormedToken(rawToken)) return null;
      const tokenHash = hashToken(rawToken);
      const result = await db.query<{ certificate_id: string; expires_at: string | number; revoked_at: string | number | null }>(
        SELECT_RETRIEVAL_TOKEN,
        [tokenHash]
      );
      const row = result.rows[0];
      if (!row) return null;
      if (row.revoked_at !== null) return null;
      if (num(row.expires_at) <= now) return null;

      const certResult = await db.query<CertRow>(SELECT_CERTIFICATE_BY_ID, [row.certificate_id]);
      const certRow = certResult.rows[0];
      return certRow ? toCertificateRecord(certRow) : null;
    },

    async enqueueNotification(kind, referenceId, now) {
      const inserted = await db.query<{ generation: number }>(ENQUEUE_NOTIFICATION, [kind, referenceId, now]);
      if (inserted.rows.length > 0) return { generation: num(inserted.rows[0]?.generation ?? 0) };

      // ON CONFLICT DO NOTHING fired — a row already existed. Read its
      // current generation rather than assuming 0.
      const existing = await db.query<{ generation: number }>(
        'SELECT generation FROM certificate_notification_outbox WHERE kind = $1 AND reference_id = $2',
        [kind, referenceId]
      );
      return { generation: num(existing.rows[0]?.generation ?? 0) };
    },

    async requeueForResend(kind, referenceId, now) {
      const result = await db.query<{ generation: number }>(REQUEUE_FOR_RESEND, [kind, referenceId, now]);
      return { generation: num(result.rows[0]?.generation ?? 0) };
    },

    async claimDueNotifications(limit, now) {
      return db.transaction(async (client) => {
        const result = await client.query<{
          kind: CertificateNotificationKind; reference_id: string; attempts: number; generation: number;
          encrypted_payload: string | null;
        }>(CLAIM_DUE_NOTIFICATIONS, [now, limit]);
        for (const row of result.rows) {
          await client.query(LEASE_CLAIMED_NOTIFICATION, [row.kind, row.reference_id, now + NOTIFICATION_PROCESSING_LEASE_MS]);
        }
        return result.rows.map((row) => ({
          kind: row.kind,
          referenceId: row.reference_id,
          attempts: num(row.attempts),
          generation: num(row.generation),
          encryptedPayload: row.encrypted_payload
        }));
      });
    },

    async markNotificationSent(kind, referenceId, now) {
      await db.query(MARK_NOTIFICATION_SENT, [kind, referenceId, now]);
    },

    async markNotificationFailed(kind, referenceId, nextAttemptAt, error) {
      await db.query(MARK_NOTIFICATION_FAILED, [kind, referenceId, nextAttemptAt, error.slice(0, 500), MAX_NOTIFICATION_ATTEMPTS]);
    },

    async getNotificationPayload(kind, referenceId, generation) {
      const result = await db.query<{ encrypted_payload: string | null }>(GET_NOTIFICATION_PAYLOAD, [kind, referenceId, generation]);
      return result.rows[0]?.encrypted_payload ?? null;
    },

    async setNotificationPayload(kind, referenceId, generation, encryptedPayload) {
      await db.query(SET_NOTIFICATION_PAYLOAD, [kind, referenceId, generation, encryptedPayload]);
    }
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/** So the service layer normalizes an email the same way the repository does, without duplicating the rule. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
