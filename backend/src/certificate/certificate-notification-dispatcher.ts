import { decryptOutboxPayload, encryptOutboxPayload } from './certificate-outbox-crypto';
import type { CertificateClaimRepository } from './certificate-claim.repository';
import type { EmailSender, OutboundEmail } from './email-sender';

/**
 * Transactional-outbox dispatcher for certificate-claim notifications.
 *
 * WHY AN OUTBOX AND NOT "just send it": a bare `await emailSender.send(...)`
 * called inline with the HTTP request that triggered it has no answer for
 * "the process crashes, or the provider call times out, between deciding
 * to send and the send actually completing" — the event is lost, silently.
 * The outbox row is inserted in the SAME DATABASE TRANSACTION as the event
 * it records (certificate-claim.service.ts enqueues it alongside the
 * confirming UPDATE/INSERT), so the event and the intent to notify about it
 * either both commit or neither does. Dispatch itself then happens
 * separately — immediately, best-effort, for low latency in the common
 * case, AND via this poller, for reliability in every other case.
 *
 * CONCURRENT WORKERS: claimDueNotifications uses
 * `SELECT ... FOR UPDATE SKIP LOCKED`, so two dispatcher instances (two
 * process replicas, or this poller racing an immediate-send attempt from
 * the request path) can run at once without ever both processing the same
 * row — one gets it, the other's SKIP LOCKED silently moves on. The row
 * lock by itself only lasts for that SELECT's own brief transaction,
 * though — it is released as soon as that transaction commits, long
 * before this row is actually sent and marked done. claimDueNotifications
 * closes that gap by also bumping next_attempt_at into the future (see
 * certificate-claim.repository.ts's NOTIFICATION_PROCESSING_LEASE_MS),
 * atomically with the same SELECT, so a claimed row is excluded from
 * every other caller's WHERE clause from the moment it is claimed, not
 * from the moment it is marked done. (An earlier version of this design
 * relied on the row lock alone and was proven wrong by its own real-
 * PostgreSQL concurrency test once this class's own async work — minting
 * a token, encrypting and persisting a payload — widened the window
 * enough for a second dispatcher to land inside it.) Verified directly
 * against real PostgreSQL (test/certificate-claim.test.ts's "real
 * PostgreSQL" describe block) — pg-mem's own pool emulation queues one
 * client at a time and cannot prove this by itself.
 *
 * THE IMPLEMENTED PROVIDER IS SMTP (smtp-email-sender.ts, Nodemailer —
 * built and verified against Winhost's mail service, confirmed via this
 * domain's own MX record and a direct STARTTLS handshake). This is a
 * DELIBERATE, DOCUMENTED CHANGE from this design's original target,
 * Resend's HTTP API: SMTP has NO idempotency-key concept of any kind. Once
 * a message is accepted (`250 OK`), there is no API to later ask "did you
 * already get this" — a retry is indistinguishable from a brand-new send
 * to the server. EVERY claim below about idempotency is therefore about
 * what THIS SYSTEM's own bookkeeping guarantees, never about the provider
 * suppressing a duplicate on its own.
 *
 * BYTE-IDENTICAL RETRIES ARE STILL PRESERVED, for a different reason than
 * originally designed: a claimant_verify row's FIRST attempt within a
 * generation mints a token and encrypts+persists the resulting payload
 * (via certificate-outbox-crypto.ts) to
 * certificate_notification_outbox.encrypted_payload BEFORE calling
 * emailSender.send() — see buildEmail below. Every subsequent attempt at
 * the SAME generation decrypts that stored payload and resends it
 * UNCHANGED. Over SMTP this no longer prevents a duplicate SEND (nothing
 * can, once the process crashes at the wrong instant — see below) — what
 * it still buys is a STABLE verification link: a claimant who received an
 * earlier retry's email and a later one sees the identical, still-valid
 * link rather than two different tokens, and MAX_OUTSTANDING_TOKENS_PER_
 * CLAIM is never needlessly consumed by retries alone. `generation` only
 * advances on a user-requested RESEND
 * (certificate-claim.repository.ts#requeueForResend, which also clears the
 * stored payload) — a genuine resend still gets a freshly minted
 * token/payload, never suppressed as a mere retry.
 *
 * THE RESIDUAL RISK THIS DESIGN DOES NOT AND CANNOT ELIMINATE: if this
 * process crashes after the SMTP server accepts a message but before
 * markNotificationSent's UPDATE persists that fact, the next retry WILL
 * send a second, genuinely duplicate physical email — there is no
 * provider-side mechanism left to prevent it. This system still
 * guarantees, unconditionally: exactly one outbox ROW, exactly one
 * certificate ever issued per email, and exactly one owner-notification
 * ROW (never a second one from a recovery). It does NOT, and this comment
 * deliberately does not claim it does, guarantee that a recipient's inbox
 * receives exactly one copy of a given email. The crash window this
 * depends on is kept as small as practically possible (markNotificationSent
 * is called immediately after send() resolves, with no intervening await),
 * but it cannot be closed to zero.
 *
 * owner_claim_notice rows never use the encrypted-payload mechanism at
 * all: their payload (claimedName/claimedEmail/certificateId) is read
 * fresh from durable rows on every attempt and is therefore ALREADY
 * byte-identical across retries without needing anything stored.
 */

export interface NotificationDispatcherOptions {
  readonly repository: CertificateClaimRepository;
  readonly emailSender: EmailSender;
  readonly now: () => number;
  /** Verification-token lifetime for a token minted at retry time. */
  readonly verificationTokenTtlMs: number;
  /** Builds the full verification URL for a freshly minted raw token. */
  readonly buildVerificationUrl: (rawToken: string) => string;
  /** Marvin's own inbox — the ONLY recipient of owner_claim_notice, never claimant-supplied. */
  readonly ownerNotificationEmail: string;
  /** How many rows one runOnce() call processes at most. */
  readonly batchSize?: number;
  /**
   * AES-256-GCM key for a claimant_verify row's stored retry payload — see
   * this class's own doc comment and certificate-outbox-crypto.ts. Exactly
   * 32 bytes; parseOutboxEncryptionKey() in that module validates a raw
   * CERTIFICATE_OUTBOX_ENCRYPTION_KEY env value into this shape.
   */
  readonly outboxEncryptionKey: Buffer;
}

export interface DispatchOutcome {
  readonly processed: number;
  readonly sent: number;
  readonly failed: number;
}

/**
 * Fixed, bounded backoff tiers — matches this codebase's "bounded, not
 * open-ended" retry philosophy (worst case across all
 * MAX_NOTIFICATION_ATTEMPTS attempts is roughly 11 hours before a row is
 * marked permanently 'failed'). These values were originally sized to stay
 * under Resend's 24-hour idempotency-key retention; that specific reason no
 * longer applies now that the implemented provider is SMTP (which has no
 * such window at all — see this class's own doc comment), but the bounded
 * values themselves remain a reasonable retry schedule on their own terms
 * and were kept rather than widened without a concrete reason to.
 */
const BACKOFF_MS_BY_ATTEMPT: readonly number[] = [
  60_000,        // 1 min
  5 * 60_000,    // 5 min
  30 * 60_000,   // 30 min
  2 * 60 * 60_000,  // 2 h
  8 * 60 * 60_000   // 8 h
];

function backoffFor(attemptsSoFar: number): number {
  const tier = BACKOFF_MS_BY_ATTEMPT[Math.min(attemptsSoFar, BACKOFF_MS_BY_ATTEMPT.length - 1)];
  return tier as number;
}

export class NotificationDispatcher {
  constructor(private readonly options: NotificationDispatcherOptions) {}

  /** Processes one batch of due rows. Safe to call concurrently with itself (SKIP LOCKED) and with an immediate-send attempt from the request path. */
  async runOnce(): Promise<DispatchOutcome> {
    const { repository, now } = this.options;
    const batchSize = this.options.batchSize ?? 20;
    const rows = await repository.claimDueNotifications(batchSize, now());

    let sent = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        const built = await this.buildEmail(row.kind, row.referenceId, row.generation, row.encryptedPayload);
        if (!built) {
          // The referenced claim/certificate no longer exists (should not
          // happen — ON DELETE CASCADE removes the outbox row with it —
          // but never assume). Mark sent rather than retrying forever.
          await repository.markNotificationSent(row.kind, row.referenceId, now());
          continue;
        }
        // Persist BEFORE sending, not after — see this class's own doc
        // comment on why this ordering is what makes a crash between the
        // provider's acceptance and markNotificationSent recoverable.
        if (built.payloadToPersist) {
          await repository.setNotificationPayload(row.kind, row.referenceId, row.generation, built.payloadToPersist);
        }
        const email = built.email;
        const result = await this.options.emailSender.send(email);
        if (result.delivered) {
          await repository.markNotificationSent(row.kind, row.referenceId, now());
          sent += 1;
        } else {
          await repository.markNotificationFailed(
            row.kind,
            row.referenceId,
            now() + backoffFor(row.attempts),
            'provider declined the send'
          );
          failed += 1;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        await repository.markNotificationFailed(row.kind, row.referenceId, now() + backoffFor(row.attempts), message);
        failed += 1;
      }
    }

    return { processed: rows.length, sent, failed };
  }

  /**
   * Attempts ONE row immediately, outside the poll cycle, for low latency
   * in the common case. Never throws — a failed immediate attempt just
   * leaves the row pending for the poller. `generation` must be the value
   * enqueueNotification/requeueForResend just returned for this exact
   * row, so the idempotency key matches what the poller would derive for
   * the same generation.
   */
  async attemptImmediately(
    kind: 'claimant_verify' | 'owner_claim_notice',
    referenceId: string,
    generation: number
  ): Promise<void> {
    const { repository, now } = this.options;
    try {
      const payload = await repository.getNotificationPayload(kind, referenceId, generation);
      const built = await this.buildEmail(kind, referenceId, generation, payload);
      if (!built) return;
      if (built.payloadToPersist) {
        await repository.setNotificationPayload(kind, referenceId, generation, built.payloadToPersist);
      }
      const result = await this.options.emailSender.send(built.email);
      if (result.delivered) {
        await repository.markNotificationSent(kind, referenceId, now());
      }
      // A non-delivered result is left 'pending' for the poller — no
      // markNotificationFailed here, since this was never claimed via
      // FOR UPDATE SKIP LOCKED and attempts/backoff belong to the poller's
      // own bookkeeping, not a best-effort side attempt.
    } catch {
      // Swallowed deliberately: the poller is the reliability guarantee.
      // An immediate attempt is pure latency optimization.
    }
  }

  /**
   * `payloadToPersist` is set ONLY when a NEW claimant_verify payload was
   * just minted (first attempt of a generation, or the decrypt-failure
   * fallback below) — the caller must persist it BEFORE calling
   * emailSender.send(), never after.
   */
  private async buildEmail(
    kind: 'claimant_verify' | 'owner_claim_notice',
    referenceId: string,
    generation: number,
    storedEncryptedPayload: string | null
  ): Promise<{ readonly email: OutboundEmail; readonly payloadToPersist: string | null } | null> {
    const idempotencyKey = `${kind}:${referenceId}:${generation}`;

    if (kind === 'owner_claim_notice') {
      // referenceId is the certificate id. The recipient is ALWAYS the
      // configured owner address — never the claimant's own email,
      // regardless of what the certificate record itself contains. This
      // payload is already fully reconstructible from durable rows, so
      // (unlike claimant_verify) it needs no stored copy to stay
      // byte-identical across retries.
      const certificate = await this.options.repository.findCertificateById(referenceId);
      if (!certificate) return null;
      return {
        email: {
          idempotencyKey,
          to: this.options.ownerNotificationEmail,
          kind: 'owner_claim_notice',
          templateData: {
            claimedName: certificate.recipientName,
            claimedEmail: certificate.emailNormalized,
            certificateId: certificate.id
          }
        },
        payloadToPersist: null
      };
    }

    // claimant_verify: referenceId is the claim id.
    if (storedEncryptedPayload) {
      const stored = decryptOutboxPayload<StoredClaimantPayload>(this.options.outboxEncryptionKey, storedEncryptedPayload);
      if (stored) {
        // A genuine retry of this SAME generation — resend the IDENTICAL
        // payload under the IDENTICAL key, so the claimant always sees the
        // SAME verification link across retries (see this class's own doc
        // comment for what this does and does not guarantee over SMTP).
        return {
          email: {
            idempotencyKey,
            to: stored.to,
            kind: 'claimant_verify',
            templateData: { recipientName: stored.recipientName, verificationUrl: stored.verificationUrl }
          },
          payloadToPersist: null
        };
      }
      // Decryption failed — almost certainly CERTIFICATE_OUTBOX_ENCRYPTION_
      // KEY was rotated while this row had a pending retry (see this
      // class's own doc comment and the migration 009 column comment).
      // The payload we WOULD resend is now unknowable, so the claimant
      // would otherwise get a dead link — mint a fresh payload under a
      // DISTINCT, FIXED fallback key (not a new random suffix each time)
      // so that if this fallback is hit again before the row resolves, IT
      // is byte-stable too.
      return this.mintFreshClaimantVerifyEmail(referenceId, `${idempotencyKey}:recovery`);
    }

    // No stored payload yet — this generation's first attempt.
    return this.mintFreshClaimantVerifyEmail(referenceId, idempotencyKey);
  }

  private async mintFreshClaimantVerifyEmail(
    claimId: string,
    idempotencyKey: string
  ): Promise<{ readonly email: OutboundEmail; readonly payloadToPersist: string | null } | null> {
    // Look up the claim DIRECTLY (real, unmasked email) — never reuse
    // previewVerificationToken here, which exists specifically to mask the
    // address for a claimant-facing confirmation page and would send
    // nowhere useful if reused for this.
    const claim = await this.options.repository.findClaimById(claimId);
    if (!claim) return null;

    // MAX_OUTSTANDING_TOKENS_PER_CLAIM bounds how many can accumulate
    // across retries/resends/fallbacks.
    const minted = await this.options.repository.mintVerificationToken(
      claimId,
      this.options.verificationTokenTtlMs,
      this.options.now()
    );
    if ('limitReached' in minted) return null;

    const verificationUrl = this.options.buildVerificationUrl(minted.rawToken);
    const stored: StoredClaimantPayload = { to: claim.emailNormalized, recipientName: claim.claimedName, verificationUrl };

    return {
      email: {
        idempotencyKey,
        to: claim.emailNormalized,
        kind: 'claimant_verify',
        templateData: { recipientName: claim.claimedName, verificationUrl }
      },
      payloadToPersist: encryptOutboxPayload(this.options.outboxEncryptionKey, stored)
    };
  }
}

/** What confirmVerificationToken's own hash-only storage cannot reconstruct — see this file's top doc comment. */
interface StoredClaimantPayload {
  readonly to: string;
  readonly recipientName: string;
  readonly verificationUrl: string;
}
