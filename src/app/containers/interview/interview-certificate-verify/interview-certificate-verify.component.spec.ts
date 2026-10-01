import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { CertificateClaimService } from '@shared/services/features/interview/certificate-claim.service';
import { CertificateClaimApiError } from '@shared/services/api/certificate-claim-api.errors';
import type { VerifiedCertificate } from '@shared/models/certificate-claim.model';
import { InterviewCertificateVerifyComponent } from './interview-certificate-verify.component';

const previewToken = jest.fn();
const confirmToken = jest.fn();
const certificateSig = signal<VerifiedCertificate | undefined>(undefined);
const claimStub = { previewToken, confirmToken, certificate: certificateSig } as unknown as CertificateClaimService;

function render(hash: string): ComponentFixture<InterviewCertificateVerifyComponent> {
  window.location.hash = hash;
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [InterviewCertificateVerifyComponent],
    providers: [provideRouter([]), { provide: CertificateClaimService, useValue: claimStub }]
  });
  const fixture = TestBed.createComponent(InterviewCertificateVerifyComponent);
  fixture.detectChanges();
  return fixture;
}

describe('InterviewCertificateVerifyComponent — SAFETY: never auto-verifies on load', () => {
  beforeEach(() => {
    previewToken.mockReset();
    confirmToken.mockReset();
    certificateSig.set(undefined);
  });

  it('on mount, calls ONLY previewToken — never confirmToken — even for a perfectly valid token', async () => {
    previewToken.mockResolvedValue({ claimedName: 'Ada Lovelace', emailMasked: 'a**@example.com' });
    render('#token=raw-token-value');
    await Promise.resolve();
    expect(previewToken).toHaveBeenCalledWith('raw-token-value');
    expect(confirmToken).not.toHaveBeenCalled();
  });

  it('reloading the page (simulated by rendering again) still never confirms — repeat visits are as safe as the first', async () => {
    previewToken.mockResolvedValue({ claimedName: 'Ada Lovelace', emailMasked: 'a**@example.com' });
    render('#token=raw-token-value');
    await Promise.resolve();
    render('#token=raw-token-value'); // simulates a reload of the same link
    await Promise.resolve();
    expect(confirmToken).not.toHaveBeenCalled();
  });

  it('confirmToken fires ONLY after the explicit button click', async () => {
    previewToken.mockResolvedValue({ claimedName: 'Ada Lovelace', emailMasked: 'a**@example.com' });
    confirmToken.mockResolvedValue({ certificateId: 'AQ-2026-000128-K', recipientName: 'Ada Lovelace', issuedAt: '2026-08-01T00:00:00.000Z' });
    const fixture = render('#token=raw-token-value');
    await Promise.resolve();
    fixture.detectChanges();

    expect(confirmToken).not.toHaveBeenCalled();
    await fixture.componentInstance.confirm();
    expect(confirmToken).toHaveBeenCalledWith('raw-token-value');
  });

  it('a malformed/missing fragment never calls previewToken or confirmToken — shows an immediate error instead', async () => {
    render('');
    await Promise.resolve();
    expect(previewToken).not.toHaveBeenCalled();
    expect(confirmToken).not.toHaveBeenCalled();
  });

  it('an EXPIRED token surfaces the expired message from preview, without attempting to confirm', async () => {
    previewToken.mockRejectedValue(new CertificateClaimApiError('TOKEN_EXPIRED', 410));
    const fixture = render('#token=expired-token');
    await Promise.resolve();
    fixture.detectChanges();
    expect(fixture.componentInstance.view()).toBe('error');
    expect(fixture.componentInstance.errorMessage()).toContain('expired');
    expect(confirmToken).not.toHaveBeenCalled();
  });

  it('a REUSED (already-used) token surfaces that message on confirm, not success', async () => {
    previewToken.mockResolvedValue({ claimedName: 'Ada Lovelace', emailMasked: 'a**@example.com' });
    confirmToken.mockRejectedValue(new CertificateClaimApiError('TOKEN_ALREADY_USED', 409));
    const fixture = render('#token=used-token');
    await Promise.resolve();
    fixture.detectChanges();

    await fixture.componentInstance.confirm();
    expect(fixture.componentInstance.view()).toBe('error');
    expect(fixture.componentInstance.errorMessage()).toContain('already been used');
  });
});
