import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { catchError, map, type Observable } from 'rxjs';

import { API_BASE_URL } from '@shared/tokens/api-base-url.token';
import type { VerifiedCertificate } from '@shared/models/certificate-claim.model';
import { CertificateClaimApiError, toCertificateClaimApiError } from './certificate-claim-api.errors';

/**
 * The ONLY place certificate-claim HTTP calls are made. Node-owned, like
 * every migration (see migration 009's own doc comment) — this service
 * injects `API_BASE_URL`, never `INTERVIEW_API_BASE_URL` (Spring).
 *
 * Thin by design: build the request, map the response, map the error. No
 * validation, storage, or navigation logic lives here — that is
 * certificate-claim.service.ts's job.
 */

interface EligibilitySnapshotDto {
  readonly achievementIds: readonly string[];
  readonly qualifyingInterviewCount: number;
  readonly qualificationStartedAt: number | null;
}

export interface PreviewTokenResult {
  readonly claimedName: string;
  readonly emailMasked: string;
}

export interface ConfirmedCertificateDto {
  readonly certificateId: string;
  readonly recipientName: string;
  readonly issuedAt: number;
  readonly retrievalToken: string;
}

@Service()
export class CertificateClaimApiService {
  private readonly http = inject(HttpClient);
  private readonly apiBaseUrl = inject(API_BASE_URL);

  /**
   * True when a Node origin is configured for this build — mirrors
   * InterviewApiService's own `configured` getter. Certificate-claims is
   * Node-owned, so this reuses API_BASE_URL rather than a second check.
   */
  get configured(): boolean {
    return this.apiBaseUrl.trim().length > 0;
  }

  /**
   * Submits a new claim (or a resend-free re-submission, which the backend
   * treats identically whether the email is new, already pending, or
   * already has a certificate — see certificate-claim.service.ts's own
   * anti-enumeration doc comment). ALWAYS resolves to the same shape; a
   * caller must not try to distinguish "new" from "already exists" from
   * this response — there is nothing to distinguish.
   */
  submitClaim(name: string, email: string, eligibilitySnapshot: EligibilitySnapshotDto): Observable<void> {
    const url = `${this.apiBaseUrl}/certificate-claims`;
    return this.http.post(url, { name, email, eligibilitySnapshot }).pipe(
      map(() => undefined),
      catchError((err: unknown) => { throw toCertificateClaimApiError(err); })
    );
  }

  /** Same request/response shape as submitClaim's initial call — see resendClaim's own anti-enumeration guarantee server-side. */
  resendClaim(email: string): Observable<void> {
    const url = `${this.apiBaseUrl}/certificate-claims/resend`;
    return this.http.post(url, { email }).pipe(
      map(() => undefined),
      catchError((err: unknown) => { throw toCertificateClaimApiError(err); })
    );
  }

  /** Read-only. Never consumes the token — see this app's confirmation-page design (no auto-verify on load). */
  previewToken(token: string): Observable<PreviewTokenResult> {
    const url = `${this.apiBaseUrl}/certificate-claims/verify/preview`;
    return this.http.post<PreviewTokenResult>(url, { token }).pipe(
      catchError((err: unknown) => { throw toCertificateClaimApiError(err); })
    );
  }

  /** The ONE mutating step — only ever called from an explicit user-triggered button click, never on page load. */
  confirmToken(token: string): Observable<ConfirmedCertificateDto> {
    const url = `${this.apiBaseUrl}/certificate-claims/verify/confirm`;
    return this.http.post<ConfirmedCertificateDto>(url, { token }).pipe(
      catchError((err: unknown) => { throw toCertificateClaimApiError(err); })
    );
  }

  /** Re-fetches the certificate by its long-lived retrieval credential — used on page load/refresh once verified. */
  getCertificateByRetrievalToken(retrievalToken: string): Observable<VerifiedCertificate> {
    const url = `${this.apiBaseUrl}/certificates/me`;
    return this.http
      .get<{ certificateId: string; recipientName: string; issuedAt: number }>(url, {
        headers: { Authorization: `Bearer ${retrievalToken}` }
      })
      .pipe(
        map((dto) => ({
          certificateId: dto.certificateId,
          recipientName: dto.recipientName,
          issuedAt: new Date(dto.issuedAt).toISOString()
        })),
        catchError((err: unknown) => { throw toCertificateClaimApiError(err); })
      );
  }
}

export { CertificateClaimApiError };
