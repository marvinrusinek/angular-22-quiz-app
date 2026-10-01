import { createHash } from 'node:crypto';

import { normalizeEmail, type CertificateClaimRepository } from './certificate-claim.repository';
import { CertificateClaimError, type ClaimSubmissionResult, type EligibilitySnapshot } from './certificate-claim.types';
import type { NotificationDispatcher } from './certificate-notification-dispatcher';

/**
 * Orchestrates the certificate-claim flow. Thin on purpose — persistence
 * lives in the repository, delivery lives in the dispatcher, this module's
 * only job is validating input and sequencing calls to the two of them.
 *
 * ELIGIBILITY STAYS BROWSER-REPORTED. `eligibilitySnapshot` is passed
 * straight through to the repository for audit storage and is never
 * inspected, re-derived, or used to authorize anything here.
 */

const MAX_NAME_LENGTH = 80;
const MAX_EMAIL_LENGTH = 254;
// Deliberately simple: a real (not aspirationally RFC-5322-complete) shape
// check, matching this codebase's zero-extra-dependency ethos. Combined
// with the length cap and the control-character strip below, this is
// sufficient to reject garbage without pretending to validate
// deliverability.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Strips CR/LF/NUL/tab before anything touches a template value. Defense
 * in depth: email-sender.ts's structured-field design already makes header
 * injection structurally impossible, but a stray control character has no
 * legitimate reason to survive into a name or email either way.
 */
function sanitizeText(value: string): string {
  return value.replace(/[\r\n\t\0]/g, '').trim();
}

function validateName(raw: unknown): string {
  if (typeof raw !== 'string') throw new CertificateClaimError('VALIDATION', 'Name is required');
  const name = sanitizeText(raw);
  if (name.length === 0) throw new CertificateClaimError('VALIDATION', 'Name is required');
  if (name.length > MAX_NAME_LENGTH) {
    throw new CertificateClaimError('VALIDATION', `Name must be at most ${MAX_NAME_LENGTH} characters`);
  }
  return name;
}

function validateEmail(raw: unknown): string {
  if (typeof raw !== 'string') throw new CertificateClaimError('VALIDATION', 'A valid email address is required');
  const email = sanitizeText(raw);
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    throw new CertificateClaimError('VALIDATION', 'A valid email address is required');
  }
  return normalizeEmail(email);
}

function hashIdempotencyKey(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export interface SubmitClaimInput {
  readonly name: unknown;
  readonly email: unknown;
  readonly eligibilitySnapshot: EligibilitySnapshot;
  readonly idempotencyKey?: string | undefined;
}

export interface ConfirmedCertificate {
  readonly certificateId: string;
  readonly recipientName: string;
  readonly issuedAt: number;
  /** Returned ONCE, here, never stored by this service. The caller (route) is responsible for putting it only in a URL fragment, never a query string or a log line. */
  readonly retrievalToken: string;
}

export interface PreviewResult {
  readonly claimedName: string;
  readonly emailMasked: string;
}

export interface CertificateClaimServiceOptions {
  readonly repository: CertificateClaimRepository;
  readonly dispatcher: NotificationDispatcher;
  readonly now: () => number;
  readonly retrievalTokenTtlMs: number;
}

export class CertificateClaimService {
  constructor(private readonly options: CertificateClaimServiceOptions) {}

  async submitClaim(input: SubmitClaimInput): Promise<ClaimSubmissionResult> {
    const name = validateName(input.name);
    const email = validateEmail(input.email);
    const idempotencyKeyHash = input.idempotencyKey ? hashIdempotencyKey(input.idempotencyKey) : undefined;

    const outcome = await this.options.repository.createClaim({
      claimedName: name,
      emailNormalized: email,
      eligibilitySnapshot: input.eligibilitySnapshot,
      now: this.options.now(),
      idempotencyKeyHash
    });

    if (outcome.kind === 'idempotency_conflict') {
      throw new CertificateClaimError('VALIDATION', 'Idempotency-Key was already used for a different request');
    }

    if (outcome.kind === 'created' || outcome.kind === 'recovery_created') {
      await this.issueVerificationEmail(outcome.claim.id, { resend: false });
    }
    // 'already_pending' / 'idempotent_replay': a live token already exists
    // from the earlier submission — resendClaim exists for "I didn't get
    // it"; a second POST here does not mint another one automatically.

    // ALWAYS the same shape — this is the anti-enumeration guarantee. A
    // caller can never tell "new", "already pending", or "already
    // verified" apart from this response.
    return { status: 'pending_verification' };
  }

  async resendClaim(emailRaw: unknown): Promise<ClaimSubmissionResult> {
    const email = validateEmail(emailRaw);
    const claim = await this.options.repository.findPendingClaimByEmail(email);
    if (claim) {
      await this.issueVerificationEmail(claim.id, { resend: true });
    }
    // Identical response whether or not a pending claim actually existed.
    return { status: 'pending_verification' };
  }

  async previewToken(rawTokenRaw: unknown): Promise<PreviewResult> {
    const rawToken = requireTokenString(rawTokenRaw);
    const outcome = await this.options.repository.previewVerificationToken(rawToken, this.options.now());
    switch (outcome.kind) {
      case 'invalid':
        throw new CertificateClaimError('TOKEN_INVALID', 'This link is not valid');
      case 'expired':
        throw new CertificateClaimError('TOKEN_EXPIRED', 'This link has expired — request a new one');
      case 'already_used':
        throw new CertificateClaimError('TOKEN_ALREADY_USED', 'This link has already been used');
      case 'valid':
        return { claimedName: outcome.claimedName, emailMasked: outcome.emailMasked };
    }
  }

  /**
   * The ONE mutating step. Never called automatically on page load — the
   * route only calls this in response to an explicit user-triggered POST
   * (see certificate-claims.route.ts). Mints a retrieval credential and,
   * ONLY on a genuinely NEW issuance, notifies the owner — recovery never
   * generates a second owner notification.
   */
  async confirmToken(rawTokenRaw: unknown): Promise<ConfirmedCertificate> {
    const rawToken = requireTokenString(rawTokenRaw);
    const now = this.options.now();
    const outcome = await this.options.repository.confirmVerificationToken(rawToken, now);

    switch (outcome.kind) {
      case 'invalid':
        throw new CertificateClaimError('TOKEN_INVALID', 'This link is not valid');
      case 'expired':
        throw new CertificateClaimError('TOKEN_EXPIRED', 'This link has expired — request a new one');
      case 'already_used':
        throw new CertificateClaimError('TOKEN_ALREADY_USED', 'This link has already been used');
      case 'issued': {
        const { rawToken: retrievalToken } = await this.options.repository.mintRetrievalToken(
          outcome.certificate.id,
          this.options.retrievalTokenTtlMs,
          now
        );

        if (outcome.isNewIssuance) {
          await this.issueOwnerNotification(outcome.certificate.id);
        }

        return {
          certificateId: outcome.certificate.id,
          recipientName: outcome.certificate.recipientName,
          issuedAt: outcome.certificate.issuedAt,
          retrievalToken
        };
      }
    }
  }

  async getCertificateByRetrievalToken(rawTokenRaw: unknown): Promise<Omit<ConfirmedCertificate, 'retrievalToken'>> {
    const rawToken = requireTokenString(rawTokenRaw);
    const certificate = await this.options.repository.resolveRetrievalToken(rawToken, this.options.now());
    if (!certificate) throw new CertificateClaimError('RETRIEVAL_INVALID', 'Invalid or expired retrieval credential');
    return {
      certificateId: certificate.id,
      recipientName: certificate.recipientName,
      issuedAt: certificate.issuedAt
    };
  }

  private async issueVerificationEmail(claimId: string, opts: { resend: boolean }): Promise<void> {
    const now = this.options.now();
    const { generation } = opts.resend
      ? await this.options.repository.requeueForResend('claimant_verify', claimId, now)
      : await this.options.repository.enqueueNotification('claimant_verify', claimId, now);
    await this.options.dispatcher.attemptImmediately('claimant_verify', claimId, generation);
  }

  private async issueOwnerNotification(certificateId: string): Promise<void> {
    const now = this.options.now();
    const { generation } = await this.options.repository.enqueueNotification('owner_claim_notice', certificateId, now);
    await this.options.dispatcher.attemptImmediately('owner_claim_notice', certificateId, generation);
  }
}

function requireTokenString(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new CertificateClaimError('TOKEN_INVALID', 'This link is not valid');
  }
  return raw;
}
