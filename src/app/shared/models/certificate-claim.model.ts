/**
 * The backend-verified certificate claim — fully separate from
 * InterviewCertificateRecord (interview-certificate.model.ts), which is now a
 * LEGACY, locally-issued-only record. See SK_CERTIFICATE_CLAIM's own comment
 * in session-keys.ts for why these two stores are never merged.
 */

export const CERTIFICATE_CLAIM_STATE_VERSION = 1 as const;

export type CertificateClaimStatus = 'none' | 'pending' | 'verified';

/** The verified certificate's own facts — mirrors backend IssuedCertificateRecord, minus emailNormalized/claimId (never needed client-side). */
export interface VerifiedCertificate {
  readonly certificateId: string;
  readonly recipientName: string;
  readonly issuedAt: string; // ISO 8601
}

/**
 * Persisted claim state. `retrievalToken` is a long-lived (90-day),
 * revocable credential for GET /certificates/me — NOT the single-use
 * verification token from the emailed link, which is never persisted
 * client-side at all (it lives only in the URL fragment of the email link
 * itself, exactly once, until consumed).
 */
export interface CertificateClaimState {
  readonly version: typeof CERTIFICATE_CLAIM_STATE_VERSION;
  readonly status: CertificateClaimStatus;
  readonly certificate?: VerifiedCertificate;
  readonly retrievalToken?: string;
}

export const EMPTY_CERTIFICATE_CLAIM_STATE: CertificateClaimState = {
  version: CERTIFICATE_CLAIM_STATE_VERSION,
  status: 'none'
};

/**
 * Validate an untrusted persisted claim state. Returns a clean state or the
 * empty one (never throws) — same discipline as
 * validateCertificateRecord() in interview-certificate.service.ts.
 */
export function validateCertificateClaimState(raw: unknown): CertificateClaimState {
  if (!raw || typeof raw !== 'object') return EMPTY_CERTIFICATE_CLAIM_STATE;
  const r = raw as Record<string, unknown>;
  const status = r['status'];
  if (status !== 'none' && status !== 'pending' && status !== 'verified') return EMPTY_CERTIFICATE_CLAIM_STATE;

  if (status !== 'verified') {
    return { version: CERTIFICATE_CLAIM_STATE_VERSION, status };
  }

  const cert = r['certificate'] as Record<string, unknown> | undefined;
  if (!cert || typeof cert['certificateId'] !== 'string' || cert['certificateId'].length === 0) {
    return EMPTY_CERTIFICATE_CLAIM_STATE;
  }
  if (typeof cert['recipientName'] !== 'string' || typeof cert['issuedAt'] !== 'string') {
    return EMPTY_CERTIFICATE_CLAIM_STATE;
  }
  const retrievalToken = typeof r['retrievalToken'] === 'string' ? r['retrievalToken'] : undefined;

  return {
    version: CERTIFICATE_CLAIM_STATE_VERSION,
    status: 'verified',
    certificate: {
      certificateId: cert['certificateId'],
      recipientName: cert['recipientName'],
      issuedAt: cert['issuedAt']
    },
    retrievalToken
  };
}
