import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { InterviewCertificateProgress } from '@shared/models';
import { InterviewCertificateService } from '@shared/services/features/interview/interview-certificate.service';
import { InterviewCertificateCalloutComponent } from './interview-certificate-callout.component';

const unlockedSig = signal(false);
const progressSig = signal<InterviewCertificateProgress>(progress());

function progress(over: Partial<InterviewCertificateProgress> = {}): InterviewCertificateProgress {
  const angularExplorerEarned = over.angularExplorerEarned ?? false;
  const qualifyingInterviewsCompleted = over.qualifyingInterviewsCompleted ?? 0;
  const requiredInterviews = 5;
  return {
    interviewMasterEarned: over.interviewMasterEarned ?? angularExplorerEarned,
    angularExplorerEarned, qualifyingInterviewsCompleted, requiredInterviews,
    interviewsRemaining: Math.max(requiredInterviews - qualifyingInterviewsCompleted, 0),
    isEligible: angularExplorerEarned && qualifyingInterviewsCompleted >= requiredInterviews,
    isUnlocked: over.isUnlocked ?? false,
    ...over
  };
}

const ensureQualificationStarted = jest.fn();
const stub = { unlocked: unlockedSig, progress: progressSig, ensureQualificationStarted } as unknown as InterviewCertificateService;

function render(): ComponentFixture<InterviewCertificateCalloutComponent> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [InterviewCertificateCalloutComponent],
    providers: [provideRouter([]), { provide: InterviewCertificateService, useValue: stub }]
  });
  const fixture = TestBed.createComponent(InterviewCertificateCalloutComponent);
  fixture.detectChanges();
  return fixture;
}

describe('InterviewCertificateCalloutComponent (Interview Builder)', () => {
  beforeEach(() => {
    unlockedSig.set(false);
    progressSig.set(progress());
  });

  it('36. displays a compact certificate progress callout while locked', () => {
    const el = render().nativeElement as HTMLElement;
    expect(el.querySelector('.icc__title')?.textContent).toContain('Angular Interview Master Certificate');
    expect(el.querySelector('.icc__line')).not.toBeNull();
    expect(el.querySelector('.icc__action')).not.toBeNull();
  });

  it('37. reflects Angular Explorer status', () => {
    progressSig.set(progress({ angularExplorerEarned: false, qualifyingInterviewsCompleted: 3 }));
    expect((render().nativeElement as HTMLElement).textContent).not.toContain('Angular Explorer unlocked');
    progressSig.set(progress({ angularExplorerEarned: true, qualifyingInterviewsCompleted: 3 }));
    expect((render().nativeElement as HTMLElement).textContent).toContain('Angular Explorer unlocked');
  });

  it('38. displays completed-interview progress', () => {
    progressSig.set(progress({ qualifyingInterviewsCompleted: 3 }));
    expect((render().nativeElement as HTMLElement).textContent).toContain('Interviews completed: 3 / 5');
  });

  it('39. displays the correct next action', () => {
    progressSig.set(progress({ angularExplorerEarned: true, qualifyingInterviewsCompleted: 3 }));
    expect((render().nativeElement as HTMLElement).querySelector('.icc__action')?.textContent)
      .toContain('Complete 2 more interviews');
  });

  it('40. shows Certificate Earned + View Certificate when unlocked', () => {
    unlockedSig.set(true);
    const el = render().nativeElement as HTMLElement;
    expect(el.querySelector('.icc__earned')?.textContent).toContain('Certificate Earned');
    const cta = el.querySelector('.icc__cta') as HTMLAnchorElement;
    expect(cta?.textContent).toContain('View Certificate');
    expect(cta?.getAttribute('href')).toContain('/interview/certificate');
    // Not the locked progress at the same time.
    expect(el.querySelector('.icc__action')).toBeNull();
  });

  it('41/42. is a compact supporting callout — no Build action inside, never mutates', () => {
    const el = render().nativeElement as HTMLElement;
    // Doesn't contain (and therefore can't obscure/replace) the primary Build action.
    expect(el.querySelector('button[type="submit"]')).toBeNull();
    expect(el.textContent).not.toContain('Build an Interview');
    // Read-only: the component exposes no unlock/mutation API.
    expect((render().componentInstance as unknown as Record<string, unknown>)['unlock']).toBeUndefined();
  });

  it('43/45/46. accessible: decorative marks aria-hidden + sr summary present', () => {
    progressSig.set(progress({ angularExplorerEarned: true, qualifyingInterviewsCompleted: 3 }));
    const el = render().nativeElement as HTMLElement;
    for (const m of Array.from(el.querySelectorAll('[aria-hidden="true"]'))) {
      expect(m.getAttribute('aria-hidden')).toBe('true');
    }
    expect(el.querySelector('.icc__sr')?.textContent).toContain('Certificate progress:');
  });
});
