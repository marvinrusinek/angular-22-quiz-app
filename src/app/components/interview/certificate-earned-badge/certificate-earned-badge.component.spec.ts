import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router, UrlTree } from '@angular/router';

import { InterviewCertificateService } from '@shared/services/features/interview/interview-certificate.service';
import { CertificateClaimService } from '@shared/services/features/interview/certificate-claim.service';
import { CertificateEarnedBadgeComponent } from './certificate-earned-badge.component';

// The service's `unlocked` is the single source of truth (it loads persisted
// certificate state on construction, so a `true` value == "earned + survives reload").
const unlockedSig = signal(false);
const stub = { unlocked: unlockedSig } as unknown as InterviewCertificateService;
const claimStatusSig = signal<'none' | 'pending' | 'verified'>('none');
const claimStub = { status: claimStatusSig } as unknown as CertificateClaimService;

function render(): ComponentFixture<CertificateEarnedBadgeComponent> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [CertificateEarnedBadgeComponent],
    providers: [
      provideRouter([]),
      { provide: InterviewCertificateService, useValue: stub },
      { provide: CertificateClaimService, useValue: claimStub }
    ]
  });
  const fixture = TestBed.createComponent(CertificateEarnedBadgeComponent);
  fixture.detectChanges();
  return fixture;
}

describe('CertificateEarnedBadgeComponent', () => {
  beforeEach(() => {
    unlockedSig.set(false);
    claimStatusSig.set('none');
  });

  it('shows the badge for a VERIFIED certificate even with no legacy record', () => {
    claimStatusSig.set('verified');
    const el = render().nativeElement as HTMLElement;
    expect(el.querySelector('.cert-badge')).not.toBeNull();
  });

  it('renders NOTHING before the certificate is earned', () => {
    expect((render().nativeElement as HTMLElement).querySelector('.cert-badge')).toBeNull();
  });

  it('shows the badge once the certificate is unlocked', () => {
    unlockedSig.set(true);
    const el = render().nativeElement as HTMLElement;
    expect(el.querySelector('.cert-badge')).not.toBeNull();
    expect(el.querySelector('.cert-badge__text')?.textContent).toContain('Certificate Earned');
  });

  it('persists across refresh — a fresh render with unlocked state shows it', () => {
    unlockedSig.set(true); // == loaded-from-storage on a new page load
    expect((render().nativeElement as HTMLElement).querySelector('.cert-badge')).not.toBeNull();
  });

  it('reacts when the certificate becomes unlocked (badge appears immediately)', () => {
    const fixture = render();
    expect((fixture.nativeElement as HTMLElement).querySelector('.cert-badge')).toBeNull();
    unlockedSig.set(true);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.cert-badge')).not.toBeNull();
  });

  it('uses a native button that navigates to the certificate once', () => {
    unlockedSig.set(true);
    const fixture = render();
    const router = TestBed.inject(Router);
    const navigate = jest.spyOn(router, 'navigateByUrl')
      .mockResolvedValue(true);
    const button = (fixture.nativeElement as HTMLElement).querySelector(
      'button.cert-badge'
    ) as HTMLButtonElement;
    expect(button.type).toBe('button');
    expect(button.hasAttribute('href')).toBe(false);
    button.focus();
    expect(document.activeElement).toBe(button);
    button.click();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(router.serializeUrl(navigate.mock.calls[0][0] as UrlTree))
      .toBe('/interview/certificate');
  });

  it('keeps the decorative medal hidden and the existing accessible name', () => {
    unlockedSig.set(true);
    const el = render().nativeElement as HTMLElement;
    expect(el.querySelector('.cert-badge__icon')?.getAttribute('aria-hidden')).toBe('true');
    expect(el.querySelector('.cert-badge')?.getAttribute('aria-label')).toMatch(
      /Certificate earned/i
    );
  });
});
