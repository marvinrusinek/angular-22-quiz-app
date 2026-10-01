import { HttpErrorResponse } from '@angular/common/http';

/**
 * Typed certificate-claim API errors — same discipline as
 * interview-api.errors.ts: backend messages are never shown to users
 * verbatim, each code carries a fixed, user-safe message.
 */

export type CertificateClaimApiErrorCode =
  | 'VALIDATION'
  | 'TOKEN_INVALID'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_ALREADY_USED'
  | 'RETRIEVAL_INVALID'
  | 'FEATURE_DISABLED'
  | 'BACKEND_UNAVAILABLE'
  | 'UNKNOWN';

const USER_MESSAGE: Record<CertificateClaimApiErrorCode, string> = {
  VALIDATION: 'Please check the name and email address and try again.',
  TOKEN_INVALID: 'This link is not valid.',
  TOKEN_EXPIRED: 'This link has expired — request a new one.',
  TOKEN_ALREADY_USED: 'This link has already been used.',
  RETRIEVAL_INVALID: 'This certificate link is invalid or has expired.',
  FEATURE_DISABLED: 'Certificate claiming is not available right now.',
  BACKEND_UNAVAILABLE: 'Cannot reach the server. Check your connection and try again.',
  UNKNOWN: 'Something went wrong. Please try again.'
};

export class CertificateClaimApiError extends Error {
  public override readonly name = 'CertificateClaimApiError';
  public readonly code: CertificateClaimApiErrorCode;
  public readonly userMessage: string;
  public readonly status: number;

  constructor(code: CertificateClaimApiErrorCode, status: number) {
    super(`CertificateClaimApiError(${code})`);
    this.code = code;
    this.status = status;
    this.userMessage = USER_MESSAGE[code];
  }
}

function readBackendMessage(error: HttpErrorResponse): string {
  const body = error.error as { error?: { message?: unknown } } | string | null;
  if (body && typeof body === 'object' && typeof body.error?.message === 'string') {
    return body.error.message;
  }
  return '';
}

export function toCertificateClaimApiError(error: unknown): CertificateClaimApiError {
  if (error instanceof CertificateClaimApiError) return error;
  if (!(error instanceof HttpErrorResponse)) return new CertificateClaimApiError('UNKNOWN', 0);
  if (error.status === 0) return new CertificateClaimApiError('BACKEND_UNAVAILABLE', 0);

  // The feature-disabled router answers 503 with a BAD_REQUEST body — detect
  // it by message rather than status alone, since 400 is also a genuine
  // validation failure.
  if (error.status === 503) return new CertificateClaimApiError('FEATURE_DISABLED', 503);

  switch (error.status) {
    case 400:
      return new CertificateClaimApiError('VALIDATION', 400);
    case 404:
      return readBackendMessage(error).toLowerCase().includes('retrieval')
        ? new CertificateClaimApiError('RETRIEVAL_INVALID', 404)
        : new CertificateClaimApiError('TOKEN_INVALID', 404);
    case 409:
      return new CertificateClaimApiError('TOKEN_ALREADY_USED', 409);
    case 410:
      return new CertificateClaimApiError('TOKEN_EXPIRED', 410);
    default:
      if (error.status >= 500) return new CertificateClaimApiError('BACKEND_UNAVAILABLE', error.status);
      return new CertificateClaimApiError('UNKNOWN', error.status);
  }
}
