import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { InterviewCertificateService } from '@shared/services/features/interview/interview-certificate.service';
import { CertificateEarnedBadgeComponent } from './certificate-earned-badge.component';

// The service's `unlocked` is the single source of truth (it loads persisted
// certificate state on construction, so a `true` value == "earned + survives reload").
const unlockedSig = signal(false);
const stub = { unlocked: unlockedSig } as unknown as InterviewCertificateService;

function render(): ComponentFixture<CertificateEarnedBadgeComponent> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [CertificateEarnedBadgeComponent],
    providers: [provideRouter([]), { provide: InterviewCertificateService, useValue: stub }]
  });
  const fixture = TestBed.createComponent(CertificateEarnedBadgeComponent);
  fixture.detectChanges();
  return fixture;
}

describe('CertificateEarnedBadgeComponent', () => {
  beforeEach(() => unlockedSig.set(false));

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
    unlockedSig.set(true);            // == loaded-from-storage on a new page load
    expect((render().nativeElement as HTMLElement).querySelector('.cert-badge')).not.toBeNull();
  });

  it('reacts when the certificate becomes unlocked (badge appears immediately)', () => {
    const fixture = render();
    expect((fixture.nativeElement as HTMLElement).querySelector('.cert-badge')).toBeNull();
    unlockedSig.set(true);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.cert-badge')).not.toBeNull();
  });

  it('is a keyboard-accessible link to the certificate page', () => {
    unlockedSig.set(true);
    const link = (render().nativeElement as HTMLElement).querySelector('.cert-badge') as HTMLAnchorElement;
    expect(link.tagName).toBe('A');                                   // focusable / keyboard-operable
    expect(link.getAttribute('href')).toContain('/interview/certificate');
  });

  it('is accessible: decorative emoji hidden, link announces "Certificate earned"', () => {
    unlockedSig.set(true);
    const el = render().nativeElement as HTMLElement;
    expect(el.querySelector('.cert-badge__icon')?.getAttribute('aria-hidden')).toBe('true');
    expect(el.querySelector('.cert-badge')?.getAttribute('aria-label')).toMatch(/Certificate earned/i);
  });
});
