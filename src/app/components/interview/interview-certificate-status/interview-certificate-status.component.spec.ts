import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { InterviewCertificateProgress } from '@shared/models';
import { InterviewCertificateService } from '@shared/services/features/interview/interview-certificate.service';
import { CertificateClaimService } from '@shared/services/features/interview/certificate-claim.service';
import { InterviewCertificateStatusComponent } from './interview-certificate-status.component';

const unlockedSig = signal(false);
const progressSig = signal<InterviewCertificateProgress>(progress());
const claimStatusSig = signal<'none' | 'pending' | 'verified'>('none');

function progress(over: Partial<InterviewCertificateProgress> = {}): InterviewCertificateProgress {
  const angularExplorerEarned = over.angularExplorerEarned ?? false;
  const qualifyingInterviewsCompleted = over.qualifyingInterviewsCompleted ?? 0;
  const requiredInterviews = 5;
  return {
    interviewMasterEarned: over.interviewMasterEarned ?? angularExplorerEarned,
    angularExplorerEarned, qualifyingInterviewsCompleted, requiredInterviews,
    interviewsRemaining: Math.max(requiredInterviews - qualifyingInterviewsCompleted, 0),
    isEligible: over.isEligible ?? (angularExplorerEarned && qualifyingInterviewsCompleted >= requiredInterviews),
    isUnlocked: over.isUnlocked ?? false,
    ...over
  };
}

const ensureQualificationStarted = jest.fn();
const certStub = { unlocked: unlockedSig, progress: progressSig, ensureQualificationStarted } as unknown as InterviewCertificateService;
const claimStub = { status: claimStatusSig } as unknown as CertificateClaimService;

function render(): ComponentFixture<InterviewCertificateStatusComponent> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [InterviewCertificateStatusComponent],
    providers: [
      provideRouter([]),
      { provide: InterviewCertificateService, useValue: certStub },
      { provide: CertificateClaimService, useValue: claimStub }
    ]
  });
  const fixture = TestBed.createComponent(InterviewCertificateStatusComponent);
  fixture.detectChanges();
  return fixture;
}

describe('InterviewCertificateStatusComponent', () => {
  beforeEach(() => {
    unlockedSig.set(false);
    progressSig.set(progress());
    claimStatusSig.set('none');
  });

  it('shows locked progress (two requirement rows) while requirements remain', () => {
    progressSig.set(progress({ angularExplorerEarned: false, qualifyingInterviewsCompleted: 2 }));
    const el = render().nativeElement as HTMLElement;
    expect(el.querySelector('.ic-status--progress')).not.toBeNull();
    expect(el.querySelectorAll('.ic-check')).toHaveLength(2);
    expect(el.textContent).toContain('Angular Explorer');
  });

  it('shows the correct interviews-completed progress', () => {
    progressSig.set(progress({ angularExplorerEarned: true, qualifyingInterviewsCompleted: 3 }));
    const el = render().nativeElement as HTMLElement;
    expect(el.textContent).toContain('Interviews completed: 3 / 5');
  });

  it('renders singular/plural next action', () => {
    progressSig.set(progress({ angularExplorerEarned: true, qualifyingInterviewsCompleted: 4 }));
    expect((render().nativeElement as HTMLElement).querySelector('.ic-status__action')?.textContent)
      .toContain('Complete 1 more interview ');
    progressSig.set(progress({ angularExplorerEarned: true, qualifyingInterviewsCompleted: 3 }));
    expect((render().nativeElement as HTMLElement).querySelector('.ic-status__action')?.textContent)
      .toContain('Complete 2 more interviews');
  });

  it('eligible but not yet claimed: shows a CTA to the claim form, never an automatic unlock', () => {
    progressSig.set(progress({ angularExplorerEarned: true, qualifyingInterviewsCompleted: 5 }));
    const el = render().nativeElement as HTMLElement;
    expect(el.querySelector('.ic-status--progress')).toBeNull();
    const cta = el.querySelector('.ic-status__cta') as HTMLAnchorElement;
    expect(cta?.textContent).toContain('Claim Certificate');
    expect(cta?.getAttribute('href')).toContain('/interview/certificate/claim');
  });

  it('already has a certificate (legacy): shows only the View Certificate CTA', () => {
    unlockedSig.set(true);
    const el = render().nativeElement as HTMLElement;
    expect(el.querySelector('.ic-status--progress')).toBeNull();   // not both at once
    expect(el.querySelector('.ic-status--unlocked')).not.toBeNull();
    const cta = el.querySelector('.ic-status__cta') as HTMLAnchorElement;
    expect(cta?.textContent).toContain('View Certificate');
    expect(cta?.getAttribute('href')).toContain('/interview/certificate');
  });

  it('already has a verified certificate: shows only the View Certificate CTA, even if eligible and no legacy record exists', () => {
    claimStatusSig.set('verified');
    progressSig.set(progress({ angularExplorerEarned: true, qualifyingInterviewsCompleted: 5 }));
    const el = render().nativeElement as HTMLElement;
    const cta = el.querySelector('.ic-status__cta') as HTMLAnchorElement;
    expect(cta?.textContent).toContain('View Certificate');
  });

  it('accessible: requirement text present, marks aria-hidden, sr summary present', () => {
    progressSig.set(progress({ angularExplorerEarned: true, qualifyingInterviewsCompleted: 3 }));
    const el = render().nativeElement as HTMLElement;
    // Real text carries state (not colour alone).
    expect(el.querySelector('.ic-check__badge')?.textContent?.trim()).toBeTruthy();
    // Decorative marks hidden from AT.
    for (const m of Array.from(el.querySelectorAll('.ic-check__mark'))) {
      expect(m.getAttribute('aria-hidden')).toBe('true');
    }
    // One screen-reader summary sentence.
    expect(el.querySelector('.ic-sr')?.textContent).toContain('Certificate progress:');
  });
});
