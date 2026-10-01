import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { CertificateClaimService } from '@shared/services/features/interview/certificate-claim.service';
import { InterviewCertificateClaimComponent } from './interview-certificate-claim.component';

const submitClaim = jest.fn();
const busySig = signal(false);
const submitErrorSig = signal<string | null>(null);
const claimStub = {
  apiConfigured: true,
  busy: busySig,
  submitError: submitErrorSig,
  submitClaim
} as unknown as CertificateClaimService;

function render(): ComponentFixture<InterviewCertificateClaimComponent> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [InterviewCertificateClaimComponent],
    providers: [provideRouter([]), { provide: CertificateClaimService, useValue: claimStub }]
  });
  const fixture = TestBed.createComponent(InterviewCertificateClaimComponent);
  fixture.detectChanges();
  return fixture;
}

describe('InterviewCertificateClaimComponent', () => {
  beforeEach(() => {
    submitClaim.mockReset();
    busySig.set(false);
    submitErrorSig.set(null);
  });

  it('a blank name or email never calls submitClaim', async () => {
    const fixture = render();
    fixture.componentInstance.onEmailInput('a@example.com');
    await fixture.componentInstance.submit();
    expect(submitClaim).not.toHaveBeenCalled();
  });

  it('a valid submission shows "check your email" — identical whether the email is new or already has a certificate (anti-enumeration)', async () => {
    submitClaim.mockResolvedValue(undefined);
    const fixture = render();
    fixture.componentInstance.onNameInput('Ada Lovelace');
    fixture.componentInstance.onEmailInput('ada@example.com');
    await fixture.componentInstance.submit();
    fixture.detectChanges();
    expect(submitClaim).toHaveBeenCalledWith('Ada Lovelace', 'ada@example.com');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Check your email');
  });

  it('recovery mode submits through the SAME submitClaim call — no separate recovery request', async () => {
    submitClaim.mockResolvedValue(undefined);
    const fixture = render();
    fixture.componentInstance.toggleRecoveryMode();
    fixture.componentInstance.onNameInput('Ada Lovelace');
    fixture.componentInstance.onEmailInput('ada@example.com');
    await fixture.componentInstance.submit();
    expect(submitClaim).toHaveBeenCalledWith('Ada Lovelace', 'ada@example.com');
  });

  it('a submission failure shows the error and does NOT show "check your email"', async () => {
    submitClaim.mockRejectedValue(new Error('fail'));
    submitErrorSig.set('Please check the name and email address and try again.');
    const fixture = render();
    fixture.componentInstance.onNameInput('Ada Lovelace');
    fixture.componentInstance.onEmailInput('ada@example.com');
    await fixture.componentInstance.submit();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('Check your email');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('check the name and email address');
  });
});
