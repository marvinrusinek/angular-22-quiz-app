import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';

import { SK_CERTIFICATE_CLAIM } from '@shared/constants/session-keys';
import { CertificateClaimApiService } from '@shared/services/api/certificate-claim-api.service';
import { CertificateClaimApiError } from '@shared/services/api/certificate-claim-api.errors';
import { InterviewCertificateService } from './interview-certificate.service';
import { AchievementService } from '@shared/services/achievements/achievement.service';
import { CertificateClaimService } from './certificate-claim.service';

const submitClaim = jest.fn();
const resendClaim = jest.fn();
const previewToken = jest.fn();
const confirmToken = jest.fn();
const getCertificateByRetrievalToken = jest.fn();

const apiStub = {
  configured: true,
  submitClaim,
  resendClaim,
  previewToken,
  confirmToken,
  getCertificateByRetrievalToken
} as unknown as CertificateClaimApiService;

const progressSig = signal({
  qualificationStartedAt: '2026-01-01T00:00:00.000Z',
  qualifyingInterviewsCompleted: 5,
  requiredInterviews: 5,
  interviewsRemaining: 0,
  isEligible: true,
  isUnlocked: false,
  angularExplorerEarned: true,
  interviewMasterEarned: true
});
const legacyCertStub = { progress: progressSig } as unknown as InterviewCertificateService;
const achievementsStub = { earnedIds: () => new Set(['angular-explorer']) } as unknown as AchievementService;

function freshService(): CertificateClaimService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: CertificateClaimApiService, useValue: apiStub },
      { provide: InterviewCertificateService, useValue: legacyCertStub },
      { provide: AchievementService, useValue: achievementsStub }
    ]
  });
  return TestBed.inject(CertificateClaimService);
}

describe('CertificateClaimService — submission', () => {
  beforeEach(() => {
    localStorage.clear();
    submitClaim.mockReset();
    resendClaim.mockReset();
  });

  it('a successful submission moves state to pending and persists it', async () => {
    submitClaim.mockReturnValue(of(undefined));
    const svc = freshService();
    await svc.submitClaim('Ada Lovelace', 'ada@example.com');
    expect(svc.status()).toBe('pending');
    expect(JSON.parse(localStorage.getItem(SK_CERTIFICATE_CLAIM) ?? '{}').status).toBe('pending');
  });

  it('RECOVERY is the exact same call — re-submitting an already-certificated email uses submitClaim, not a separate endpoint', async () => {
    submitClaim.mockReturnValue(of(undefined));
    const svc = freshService();
    await svc.submitClaim('Ada Lovelace', 'ada@example.com');
    expect(submitClaim).toHaveBeenCalledTimes(1);
    expect(resendClaim).not.toHaveBeenCalled();
  });

  it('a failed submission surfaces the user-safe message and does NOT change state', async () => {
    submitClaim.mockReturnValue(throwError(() => new CertificateClaimApiError('VALIDATION', 400)));
    const svc = freshService();
    await expect(svc.submitClaim('', 'bad')).rejects.toBeInstanceOf(CertificateClaimApiError);
    expect(svc.status()).toBe('none');
    expect(svc.submitError()).toContain('check the name and email');
  });
});

describe('CertificateClaimService — confirm + refresh', () => {
  beforeEach(() => {
    localStorage.clear();
    confirmToken.mockReset();
    getCertificateByRetrievalToken.mockReset();
  });

  it('confirming persists the VERIFIED certificate + retrieval token', async () => {
    confirmToken.mockReturnValue(of({
      certificateId: 'AQ-2026-000128-K',
      recipientName: 'Ada Lovelace',
      issuedAt: Date.parse('2026-08-01T00:00:00.000Z'),
      retrievalToken: 'retr_abc'
    }));
    const svc = freshService();
    const cert = await svc.confirmToken('raw-token');
    expect(cert.certificateId).toBe('AQ-2026-000128-K');
    expect(svc.status()).toBe('verified');
    const persisted = JSON.parse(localStorage.getItem(SK_CERTIFICATE_CLAIM) ?? '{}');
    expect(persisted.status).toBe('verified');
    expect(persisted.retrievalToken).toBe('retr_abc');
  });

  it('refresh() re-fetches via the stored retrieval token on a later load (survives refresh)', async () => {
    confirmToken.mockReturnValue(of({
      certificateId: 'AQ-2026-000128-K', recipientName: 'Ada Lovelace',
      issuedAt: Date.parse('2026-08-01T00:00:00.000Z'), retrievalToken: 'retr_abc'
    }));
    const first = freshService();
    await first.confirmToken('raw-token');

    getCertificateByRetrievalToken.mockReturnValue(of({
      certificateId: 'AQ-2026-000128-K', recipientName: 'Ada Lovelace', issuedAt: '2026-08-01T00:00:00.000Z'
    }));
    const reloaded = freshService(); // simulates a fresh page load reading localStorage
    expect(reloaded.status()).toBe('verified'); // loaded from storage before refresh() even runs
    await reloaded.refresh();
    expect(getCertificateByRetrievalToken).toHaveBeenCalledWith('retr_abc');
    expect(reloaded.certificate()?.certificateId).toBe('AQ-2026-000128-K');
  });

  it('refresh() with no stored token is a silent no-op', async () => {
    const svc = freshService();
    await svc.refresh();
    expect(getCertificateByRetrievalToken).not.toHaveBeenCalled();
  });

  it('refresh() keeps the last-known state on a transient failure (e.g. a revoked/expired retrieval credential)', async () => {
    confirmToken.mockReturnValue(of({
      certificateId: 'AQ-2026-000128-K', recipientName: 'Ada Lovelace',
      issuedAt: Date.parse('2026-08-01T00:00:00.000Z'), retrievalToken: 'retr_abc'
    }));
    const svc = freshService();
    await svc.confirmToken('raw-token');

    getCertificateByRetrievalToken.mockReturnValue(throwError(() => new CertificateClaimApiError('RETRIEVAL_INVALID', 404)));
    await svc.refresh();
    expect(svc.status()).toBe('verified'); // unchanged — not downgraded by a transient/edge failure
    expect(svc.certificate()?.certificateId).toBe('AQ-2026-000128-K');
  });
});
