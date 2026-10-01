import { computed, inject, Service, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import {
  CertificateClaimState,
  EMPTY_CERTIFICATE_CLAIM_STATE,
  validateCertificateClaimState,
  type VerifiedCertificate
} from '@shared/models/certificate-claim.model';
import { SK_CERTIFICATE_CLAIM } from '@shared/constants/session-keys';
import { readLocalJson, writeLocalJson } from '@shared/utils/local-storage';
import {
  CertificateClaimApiService,
  type PreviewTokenResult
} from '@shared/services/api/certificate-claim-api.service';
import { CertificateClaimApiError } from '@shared/services/api/certificate-claim-api.errors';
import { AchievementService } from '@shared/services/achievements/achievement.service';
import { InterviewCertificateService } from './interview-certificate.service';

/**
 * Owns the BACKEND-VERIFIED certificate claim — the new, email-verified
 * replacement for automatic local issuance. Fully separate from
 * InterviewCertificateService, which now only ever serves a LEGACY record
 * (see that service's own updated doc comment): this service never reads
 * or writes SK_INTERVIEW_CERTIFICATE, and InterviewCertificateService never
 * reads or writes SK_CERTIFICATE_CLAIM.
 *
 * ELIGIBILITY STAYS BROWSER-REPORTED — unchanged, computed by
 * InterviewCertificateService.progress exactly as before. This service only
 * changes what happens ONCE eligible: instead of silently unlocking a local
 * record, the UI now offers to claim a verified certificate, and this
 * service's job is submitting that claim, confirming the emailed token (on
 * an explicit user action only — never on page load), and persisting the
 * resulting state.
 */
@Service()
export class CertificateClaimService {
  private readonly api = inject(CertificateClaimApiService);
  private readonly legacyCert = inject(InterviewCertificateService);
  private readonly achievements = inject(AchievementService);

  private readonly _state = signal<CertificateClaimState>(this.load());
  private readonly _submitError = signal<string | null>(null);
  private readonly _busy = signal(false);

  readonly state = this._state.asReadonly();
  readonly status = computed(() => this._state().status);
  readonly certificate = computed(() => this._state().certificate);
  readonly submitError = this._submitError.asReadonly();
  readonly busy = this._busy.asReadonly();

  /** True when the Node API is configured for this build — callers hide claim UI otherwise rather than let every call fail. */
  readonly apiConfigured = this.api.configured;

  /**
   * Submit (or re-submit, for recovery — see this method's own comment) a
   * claim. ALWAYS resolves to "check your email", whether the email is
   * new, already pending, or already has a verified certificate — this
   * mirrors the backend's own anti-enumeration guarantee: the UI must never
   * imply which case occurred.
   *
   * RECOVERY: a claimant who already has a verified certificate but lost
   * their retrieval credential (cleared storage, new device) calls this
   * SAME method with their email again. The backend's own createClaim
   * resolves this to a 'recovery_created' claim internally and, once the
   * resulting email is confirmed, resolves to the EXISTING certificate —
   * same id, same original issue date, no second owner notification. There
   * is no separate recovery endpoint; this is that path.
   */
  async submitClaim(name: string, email: string): Promise<void> {
    this._busy.set(true);
    this._submitError.set(null);
    try {
      await firstValueFrom(this.api.submitClaim(name, email, this.eligibilitySnapshot()));
      this.setState({ version: 1, status: 'pending' });
    } catch (err: unknown) {
      this._submitError.set(this.messageFor(err));
      throw err;
    } finally {
      this._busy.set(false);
    }
  }

  async resendClaim(email: string): Promise<void> {
    this._busy.set(true);
    this._submitError.set(null);
    try {
      await firstValueFrom(this.api.resendClaim(email));
    } catch (err: unknown) {
      this._submitError.set(this.messageFor(err));
      throw err;
    } finally {
      this._busy.set(false);
    }
  }

  /** Read-only preview for the confirmation page — never consumes the token. */
  async previewToken(token: string): Promise<PreviewTokenResult> {
    return firstValueFrom(this.api.previewToken(token));
  }

  /**
   * The ONE mutating step. Callers must invoke this ONLY from an explicit
   * user-triggered action (a button click) — never from ngOnInit or a
   * route resolver, which would auto-verify on page load.
   */
  async confirmToken(token: string): Promise<VerifiedCertificate> {
    this._busy.set(true);
    try {
      const confirmed = await firstValueFrom(this.api.confirmToken(token));
      const certificate: VerifiedCertificate = {
        certificateId: confirmed.certificateId,
        recipientName: confirmed.recipientName,
        issuedAt: new Date(confirmed.issuedAt).toISOString()
      };
      this.setState({ version: 1, status: 'verified', certificate, retrievalToken: confirmed.retrievalToken });
      return certificate;
    } finally {
      this._busy.set(false);
    }
  }

  /**
   * Re-fetches the verified certificate on page load/refresh via the
   * stored retrieval token. No-ops (resolves silently) when there is
   * nothing to refresh or the credential has been revoked/expired — the
   * UI keeps showing the last-known state rather than flashing a locked
   * screen on a transient network failure.
   */
  async refresh(): Promise<void> {
    const token = this._state().retrievalToken;
    if (!token) return;
    try {
      const certificate = await firstValueFrom(this.api.getCertificateByRetrievalToken(token));
      this.setState({ ...this._state(), status: 'verified', certificate });
    } catch {
      // Keep the last-known state — see this method's own doc comment.
    }
  }

  /** The snapshot sent with a claim submission — audit-only server-side, never re-derived into an authorization decision there or here. */
  private eligibilitySnapshot(): { achievementIds: readonly string[]; qualifyingInterviewCount: number; qualificationStartedAt: number | null } {
    const progress = this.legacyCert.progress();
    const qualStartMs = progress.qualificationStartedAt ? Date.parse(progress.qualificationStartedAt) : NaN;
    return {
      achievementIds: [...this.achievements.earnedIds()],
      qualifyingInterviewCount: progress.qualifyingInterviewsCompleted,
      qualificationStartedAt: Number.isNaN(qualStartMs) ? null : qualStartMs
    };
  }

  private messageFor(err: unknown): string {
    return err instanceof CertificateClaimApiError ? err.userMessage : 'Something went wrong. Please try again.';
  }

  private setState(state: CertificateClaimState): void {
    this._state.set(state);
    writeLocalJson(SK_CERTIFICATE_CLAIM, state);
  }

  private load(): CertificateClaimState {
    return validateCertificateClaimState(readLocalJson<unknown>(SK_CERTIFICATE_CLAIM, EMPTY_CERTIFICATE_CLAIM_STATE));
  }
}
