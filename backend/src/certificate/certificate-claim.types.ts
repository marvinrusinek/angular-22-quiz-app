/**
 * Shared types for the certificate-claim feature.
 *
 * ELIGIBILITY IS BROWSER-REPORTED, NOT BACKEND-VERIFIED. EligibilitySnapshot
 * is stored for audit purposes only (so a suspicious claim can be looked at
 * later) and is never read back to authorize a claim, a verification, or a
 * certificate issuance. Nothing in this module re-derives "5 completed
 * interviews" — that would require a persistent claimant identity bound to
 * interview_sessions from the start of each session, which does not exist
 * and is out of scope.
 */

export interface EligibilitySnapshot {
  readonly achievementIds: readonly string[];
  readonly qualifyingInterviewCount: number;
  readonly qualificationStartedAt: number | null;
}

export type CertificateClaimStatus = 'pending' | 'verified';

export interface CertificateClaimRecord {
  readonly id: string;
  readonly emailNormalized: string;
  readonly claimedName: string;
  readonly status: CertificateClaimStatus;
  readonly eligibilitySnapshot: EligibilitySnapshot;
  readonly createdAt: number;
  readonly verifiedAt: number | null;
}

export interface IssuedCertificateRecord {
  readonly id: string;
  readonly emailNormalized: string;
  readonly claimId: string;
  readonly recipientName: string;
  readonly issuedAt: number;
}

export type CertificateClaimErrorCode =
  | 'VALIDATION'
  | 'FEATURE_DISABLED'
  | 'TOKEN_INVALID'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_ALREADY_USED'
  | 'TOKEN_LIMIT_REACHED'
  | 'RETRIEVAL_INVALID';

export class CertificateClaimError extends Error {
  public override readonly name = 'CertificateClaimError';
  public readonly code: CertificateClaimErrorCode;

  constructor(code: CertificateClaimErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * The ONE response shape for POST /certificate-claims and
 * POST /certificate-claims/resend — deliberately identical whether the
 * email is new, already pending, or already has an issued certificate.
 * This is the anti-enumeration measure: a caller can never distinguish
 * "you just created a claim" from "this email already has a certificate"
 * from the response alone.
 */
export interface ClaimSubmissionResult {
  readonly status: 'pending_verification';
}
