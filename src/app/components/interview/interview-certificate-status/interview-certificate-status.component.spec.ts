import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { InterviewCertificateProgress, InterviewCertificateRecord } from '@shared/models/interview-certificate.model';
import { InterviewCertificateService } from '@shared/services/features/interview/interview-certificate.service';
import { InterviewCertificateStatusComponent } from './interview-certificate-status.component';

const unlockedSig = signal(false);
const progressSig = signal<InterviewCertificateProgress>(progress());
const unlock = jest.fn<InterviewCertificateRecord | null, []>(() => {
  unlockedSig.set(true);
  return { version: 1, unlocked: true, unlockedAt: '2026-07-24T00:00:00.000Z', certificateId: 'AQ-2026-000001' };
});

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
const stub = { unlocked: unlockedSig, progress: progressSig, unlock, ensureQualificationStarted } as unknown as InterviewCertificateService;

function render(): ComponentFixture<InterviewCertificateStatusComponent> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [InterviewCertificateStatusComponent],
    providers: [provideRouter([]), { provide: InterviewCertificateService, useValue: stub }]
  });
  const fixture = TestBed.createComponent(InterviewCertificateStatusComponent);
  fixture.detectChanges();
  return fixture;
}

describe('InterviewCertificateStatusComponent', () => {
  beforeEach(() => {
    unlockedSig.set(false);
    progressSig.set(progress());
    unlock.mockClear();
  });

  it('28. shows locked progress (two requirement rows) while requirements remain', () => {
    progressSig.set(progress({ angularExplorerEarned: false, qualifyingInterviewsCompleted: 2 }));
    const el = render().nativeElement as HTMLElement;
    expect(el.querySelector('.ic-status--progress')).not.toBeNull();
    expect(el.querySelectorAll('.ic-check')).toHaveLength(2);
    expect(el.textContent).toContain('Angular Explorer');
    expect(unlock).not.toHaveBeenCalled();
    expect(el.querySelector('.ic-dialog')).toBeNull();
  });

  it('29. shows the correct interviews-completed progress', () => {
    progressSig.set(progress({ angularExplorerEarned: true, qualifyingInterviewsCompleted: 3 }));
    const el = render().nativeElement as HTMLElement;
    expect(el.textContent).toContain('Interviews completed: 3 / 5');
  });

  it('30/31. renders singular/plural next action', () => {
    progressSig.set(progress({ angularExplorerEarned: true, qualifyingInterviewsCompleted: 4 }));
    expect((render().nativeElement as HTMLElement).querySelector('.ic-status__action')?.textContent)
      .toContain('Complete 1 more interview ');
    progressSig.set(progress({ angularExplorerEarned: true, qualifyingInterviewsCompleted: 3 }));
    expect((render().nativeElement as HTMLElement).querySelector('.ic-status__action')?.textContent)
      .toContain('Complete 2 more interviews');
  });

  it('19/unlock: unlocks ONCE and celebrates when eligible and not yet unlocked', () => {
    progressSig.set(progress({ angularExplorerEarned: true, qualifyingInterviewsCompleted: 5 }));
    const el = render().nativeElement as HTMLElement;
    expect(unlock).toHaveBeenCalledTimes(1);
    expect(el.querySelector('.ic-dialog')).not.toBeNull();
    expect(el.querySelector('.ic-dialog__title')?.textContent).toContain('Certificate Unlocked');
  });

  it('26/33. already unlocked: no re-unlock, no dialog, only the View Certificate CTA', () => {
    unlockedSig.set(true);
    const el = render().nativeElement as HTMLElement;
    expect(unlock).not.toHaveBeenCalled();
    expect(el.querySelector('.ic-dialog')).toBeNull();
    expect(el.querySelector('.ic-status--progress')).toBeNull();   // not both at once
    expect(el.querySelector('.ic-status--unlocked')).not.toBeNull();
    const cta = el.querySelector('.ic-status__cta') as HTMLAnchorElement;
    expect(cta?.textContent).toContain('View Certificate');
    expect(cta?.getAttribute('href')).toContain('/interview/certificate');
  });

  it('43/44/45/46. accessible: requirement text present, marks aria-hidden, sr summary present', () => {
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

  it('dismiss() closes the celebration dialog', () => {
    progressSig.set(progress({ angularExplorerEarned: true, qualifyingInterviewsCompleted: 5 }));
    const fixture = render();
    expect((fixture.nativeElement as HTMLElement).querySelector('.ic-dialog')).not.toBeNull();
    fixture.componentInstance.dismiss();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.ic-dialog')).toBeNull();
  });

  it('Escape closes the celebration dialog (keyboard users are not trapped)', () => {
    progressSig.set(progress({ angularExplorerEarned: true, qualifyingInterviewsCompleted: 5 }));
    const fixture = render();
    const el = fixture.nativeElement as HTMLElement;
    const dialog = el.querySelector('.ic-dialog') as HTMLElement;
    expect(dialog).not.toBeNull();

    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();

    expect(el.querySelector('.ic-dialog')).toBeNull();
  });

  it('the celebration dialog traps focus while open', () => {
    progressSig.set(progress({ angularExplorerEarned: true, qualifyingInterviewsCompleted: 5 }));
    const fixture = render();
    const dialog = (fixture.nativeElement as HTMLElement).querySelector('.ic-dialog');
    // cdkTrapFocus keeps Tab inside the modal and restores focus on close.
    expect(dialog?.hasAttribute('cdktrapfocus')).toBe(true);
  });
});
