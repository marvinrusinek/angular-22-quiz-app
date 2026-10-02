import { computed, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import {
  InterviewCertificateProgress,
  InterviewCertificateRecord,
  InterviewReadiness,
  InterviewReadinessBand
} from '@shared/models';
import type { VerifiedCertificate } from '@shared/models/certificate-claim.model';
import { InterviewCertificateService } from '@shared/services/features/interview/interview-certificate.service';
import { CertificateClaimService } from '@shared/services/features/interview/certificate-claim.service';
import { InterviewReadinessService } from '@shared/services/features/interview/interview-readiness.service';
import { InterviewHistoryService } from '@shared/services/features/interview/interview-history.service';
import { InterviewCertificateComponent } from './interview-certificate.component';

const recordSig = signal<InterviewCertificateRecord | null>(null);
const readinessSig = signal<InterviewReadiness | null>({ band: 'interview-ready' } as InterviewReadiness);
const trendsSig = signal<{ best: number | null }>({ best: 95 });
const setRecipientName = jest.fn();
const ensureQualificationStarted = jest.fn();

function progress(over: Partial<InterviewCertificateProgress> = {}): InterviewCertificateProgress {
  return {
    angularExplorerEarned: false,
    qualifyingInterviewsCompleted: 0,
    requiredInterviews: 5,
    interviewsRemaining: 5,
    isEligible: false,
    isUnlocked: false,
    interviewMasterEarned: false,
    ...over
  };
}
const progressSig = signal<InterviewCertificateProgress>(progress());

function band(b: InterviewReadinessBand | null): void {
  readinessSig.set(b === null ? null : ({ band: b } as InterviewReadiness));
}

const persistFailedSig = signal(false);

const serviceStub = {
  record: recordSig,
  unlocked: computed(() => recordSig()?.unlocked === true),
  persistenceFailed: persistFailedSig,
  progress: progressSig,
  setRecipientName,
  ensureQualificationStarted
} as unknown as InterviewCertificateService;

const verifiedCertSig = signal<VerifiedCertificate | undefined>(undefined);
const claimStatusSig = signal<'none' | 'pending' | 'verified'>('none');
const refresh = jest.fn(() => Promise.resolve());
const claimStub = {
  certificate: verifiedCertSig,
  status: claimStatusSig,
  refresh
} as unknown as CertificateClaimService;

function issued(over: Partial<InterviewCertificateRecord> = {}): InterviewCertificateRecord {
  return { version: 1, unlocked: true, unlockedAt: '2026-07-24T15:00:00.000Z', certificateId: 'AQ-2026-000128', ...over };
}

function verified(over: Partial<VerifiedCertificate> = {}): VerifiedCertificate {
  return { certificateId: 'AQ-2026-000200-K', recipientName: 'Ada Lovelace', issuedAt: '2026-08-01T00:00:00.000Z', ...over };
}

function render(): ComponentFixture<InterviewCertificateComponent> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [InterviewCertificateComponent],
    providers: [
      provideRouter([]),
      { provide: InterviewCertificateService, useValue: serviceStub },
      { provide: CertificateClaimService, useValue: claimStub },
      { provide: InterviewReadinessService, useValue: { readiness: readinessSig } },
      { provide: InterviewHistoryService, useValue: { trends: trendsSig } }
    ]
  });
  const fixture = TestBed.createComponent(InterviewCertificateComponent);
  fixture.detectChanges();
  return fixture;
}

describe('InterviewCertificateComponent', () => {
  beforeEach(() => {
    recordSig.set(null);
    verifiedCertSig.set(undefined);
    claimStatusSig.set('none');
    progressSig.set(progress());
    band('interview-ready');
    trendsSig.set({ best: 95 });
    setRecipientName.mockClear();
    refresh.mockClear();
  });

  it('shows a friendly locked state (not eligible, no certificate)', () => {
    const el = render().nativeElement as HTMLElement;
    expect(el.querySelector('.ic-locked')).not.toBeNull();
    expect(el.querySelector('.ic-locked__title')?.textContent).toContain('not yet unlocked');
    expect(el.querySelector('.ic-cert')).toBeNull();
  });

  it('eligible but not yet claimed: shows a CTA to the claim form, never an automatic certificate', () => {
    progressSig.set(progress({ isEligible: true }));
    const el = render().nativeElement as HTMLElement;
    expect(el.querySelector('.ic-cert')).toBeNull();
    const cta = el.querySelector('.ic-locked .ic-btn--primary') as HTMLAnchorElement;
    expect(cta?.getAttribute('href')).toContain('/interview/certificate/claim');
  });

  it('renders a VERIFIED certificate with title, id, tier and date, no legacy badge', () => {
    verifiedCertSig.set(verified());
    claimStatusSig.set('verified');
    const el = render().nativeElement as HTMLElement;
    expect(el.querySelector('.ic-locked')).toBeNull();
    expect(el.querySelector('.ic-cert__title')?.textContent).toContain('Angular Interview Master');
    expect(el.querySelector('.ic-cert__id')?.textContent).toContain('AQ-2026-000200-K');
    expect(el.querySelector('.ic-cert__name')?.textContent).toContain('Ada Lovelace');
    const facts = el.querySelector('.ic-cert__facts')?.textContent ?? '';
    expect(facts).toContain('Interview Ready');
    expect(el.querySelector('.ic-legacy-badge')).toBeNull();
    // A verified certificate's name is not locally editable.
    expect(el.querySelector('.ic-name-btn')).toBeNull();
  });

  it('a VERIFIED certificate NEVER shows an Interview Score fact — it is server-issued and must not depend on this browser’s local history', () => {
    verifiedCertSig.set(verified());
    claimStatusSig.set('verified');
    const el = render().nativeElement as HTMLElement;
    const facts = el.querySelector('.ic-cert__facts');
    expect(facts?.textContent).not.toMatch(/Interview Score/i);
    expect(facts?.querySelectorAll('.ic-fact')).toHaveLength(2);
    expect(facts?.classList.contains('ic-cert__facts--two')).toBe(true);
  });

  it('a VERIFIED certificate displays IDENTICALLY whether or not this browser has local interview history — the exact bug a mismatched regular/Incognito display would be', () => {
    verifiedCertSig.set(verified());
    claimStatusSig.set('verified');

    trendsSig.set({ best: 95 }); // e.g. regular Chrome, rich local history
    const withHistory = (render().nativeElement as HTMLElement).querySelector('.ic-cert__facts')?.innerHTML;

    trendsSig.set({ best: null }); // e.g. a fresh Incognito window, no local history
    const withoutHistory = (render().nativeElement as HTMLElement).querySelector('.ic-cert__facts')?.innerHTML;

    expect(withHistory).toBe(withoutHistory);
  });

  it('renders a LEGACY certificate (locally issued, pre-feature) with the legacy badge, editable name, and a "Best Interview Score" fact', () => {
    recordSig.set(issued());
    const el = render().nativeElement as HTMLElement;
    expect(el.querySelector('.ic-locked')).toBeNull();
    expect(el.querySelector('.ic-cert__id')?.textContent).toContain('AQ-2026-000128');
    expect(el.querySelector('.ic-legacy-badge')).not.toBeNull();
    expect(el.querySelector('.ic-name-btn')).not.toBeNull();
    const facts = el.querySelector('.ic-cert__facts');
    expect(facts?.textContent).toContain('Best Interview Score');
    expect(facts?.textContent).toContain('95%');
    expect(facts?.querySelectorAll('.ic-fact')).toHaveLength(3);
    expect(facts?.classList.contains('ic-cert__facts--two')).toBe(false);
  });

  it('prefers the VERIFIED certificate over a legacy one when both exist', () => {
    recordSig.set(issued());
    verifiedCertSig.set(verified());
    claimStatusSig.set('verified');
    const el = render().nativeElement as HTMLElement;
    expect(el.querySelector('.ic-cert__id')?.textContent).toContain('AQ-2026-000200-K');
    expect(el.querySelector('.ic-legacy-badge')).toBeNull();
  });

  it('shows a placeholder name until one is entered, then the entered name (legacy)', () => {
    recordSig.set(issued());
    let el = render().nativeElement as HTMLElement;
    expect(el.querySelector('.ic-cert__name')?.textContent).toContain('Angular Developer');
    expect(el.querySelector('.ic-cert__name--placeholder')).not.toBeNull();

    recordSig.set(issued({ recipientName: 'Ada Lovelace' }));
    el = render().nativeElement as HTMLElement;
    expect(el.querySelector('.ic-cert__name')?.textContent).toContain('Ada Lovelace');
    expect(el.querySelector('.ic-cert__name--placeholder')).toBeNull();
  });

  it('edits the recipient name through the service (legacy only)', () => {
    recordSig.set(issued());
    const fixture = render();
    const comp = fixture.componentInstance;
    comp.startEditName();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.ic-name-input')).not.toBeNull();
    comp.onNameInput('Grace Hopper');
    comp.saveName();
    expect(setRecipientName).toHaveBeenCalledWith('Grace Hopper');
    expect(comp.editingName()).toBe(false);
  });

  it('print() triggers the browser print dialog', () => {
    recordSig.set(issued());
    const spy = jest.spyOn(window, 'print').mockImplementation(() => {});
    render().componentInstance.print();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('falls back to the required tier label + score placeholder if history aged out post-issue (legacy only)', () => {
    recordSig.set(issued());
    band(null);
    trendsSig.set({ best: null });
    const facts = (render().nativeElement as HTMLElement).querySelector('.ic-cert__facts')?.textContent ?? '';
    expect(facts).toContain('Interview Ready');       // required-tier fallback
    expect(facts).toContain('Best Interview Score');  // still shown — this IS the legacy, same-browser case
    expect(facts).toContain('—');                     // score placeholder
  });

  it('calls ensureQualificationStarted + refresh on visit — never unlock()', () => {
    render();
    expect(ensureQualificationStarted).toHaveBeenCalled();
    expect(refresh).toHaveBeenCalled();
    expect((serviceStub as unknown as { unlock?: unknown }).unlock).toBeUndefined();
  });

  it('warns when the certificate could not be saved, and stays silent otherwise', () => {
    recordSig.set(issued());
    persistFailedSig.set(false);
    expect((render().nativeElement as HTMLElement).querySelector('.ic-warning')).toBeNull();

    persistFailedSig.set(true);
    const warning = (render().nativeElement as HTMLElement).querySelector('.ic-warning');
    expect(warning?.textContent).toContain('could not be saved to this browser');
    persistFailedSig.set(false);
  });
});
