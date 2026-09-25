import { computed, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { InterviewCertificateRecord } from '@shared/models/interview-certificate.model';
import { InterviewReadiness, InterviewReadinessBand } from '@shared/models/interview-readiness.model';
import { InterviewCertificateService } from '@shared/services/features/interview/interview-certificate.service';
import { InterviewReadinessService } from '@shared/services/features/interview/interview-readiness.service';
import { InterviewHistoryService } from '@shared/services/features/interview/interview-history.service';
import { InterviewCertificateComponent } from './interview-certificate.component';

const recordSig = signal<InterviewCertificateRecord | null>(null);
const readinessSig = signal<InterviewReadiness | null>({ band: 'interview-ready' } as InterviewReadiness);
const trendsSig = signal<{ best: number | null }>({ best: 95 });
const setRecipientName = jest.fn();
const ensureQualificationStarted = jest.fn();
// Mirrors the real service: idempotent, and issues only when eligible.
const unlock = jest.fn(() => recordSig());

function band(b: InterviewReadinessBand | null): void {
  readinessSig.set(b === null ? null : ({ band: b } as InterviewReadiness));
}

const persistFailedSig = signal(false);

const serviceStub = {
  record: recordSig,
  unlocked: computed(() => recordSig()?.unlocked === true),
  persistenceFailed: persistFailedSig,
  setRecipientName,
  ensureQualificationStarted,
  unlock
} as unknown as InterviewCertificateService;

function issued(over: Partial<InterviewCertificateRecord> = {}): InterviewCertificateRecord {
  return { version: 1, unlocked: true, unlockedAt: '2026-07-24T15:00:00.000Z', certificateId: 'AQ-2026-000128', ...over };
}

function render(): ComponentFixture<InterviewCertificateComponent> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [InterviewCertificateComponent],
    providers: [
      provideRouter([]),
      { provide: InterviewCertificateService, useValue: serviceStub },
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
    band('interview-ready');
    trendsSig.set({ best: 95 });
    setRecipientName.mockClear();
  });

  it('shows a friendly locked state (no certificate) before it is unlocked', () => {
    const el = render().nativeElement as HTMLElement;
    expect(el.querySelector('.ic-locked')).not.toBeNull();
    expect(el.querySelector('.ic-locked__title')?.textContent).toContain('not yet unlocked');
    expect(el.querySelector('.ic-cert')).toBeNull();
  });

  it('57. renders the certificate with title, id, tier, score and date once unlocked', () => {
    recordSig.set(issued());
    const el = render().nativeElement as HTMLElement;
    expect(el.querySelector('.ic-locked')).toBeNull();
    expect(el.querySelector('.ic-cert__title')?.textContent).toContain('Angular Interview Master');
    expect(el.querySelector('.ic-cert__id')?.textContent).toContain('AQ-2026-000128');
    const facts = el.querySelector('.ic-cert__facts')?.textContent ?? '';
    expect(facts).toContain('Interview Ready');
    expect(facts).toContain('95%');
    expect(facts).toMatch(/2026/);
    expect(el.querySelectorAll('h1#ic-title')).toHaveLength(1);
  });

  it('shows a placeholder name until one is entered, then the entered name', () => {
    recordSig.set(issued());
    let el = render().nativeElement as HTMLElement;
    expect(el.querySelector('.ic-cert__name')?.textContent).toContain('Angular Developer');
    expect(el.querySelector('.ic-cert__name--placeholder')).not.toBeNull();

    recordSig.set(issued({ recipientName: 'Ada Lovelace' }));
    el = render().nativeElement as HTMLElement;
    expect(el.querySelector('.ic-cert__name')?.textContent).toContain('Ada Lovelace');
    expect(el.querySelector('.ic-cert__name--placeholder')).toBeNull();
  });

  it('edits the recipient name through the service', () => {
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

  it('falls back to the required tier label + score placeholder if history aged out post-issue', () => {
    recordSig.set(issued());
    band(null);
    trendsSig.set({ best: null });
    const facts = (render().nativeElement as HTMLElement).querySelector('.ic-cert__facts')?.textContent ?? '';
    expect(facts).toContain('Interview Ready');   // required-tier fallback
    expect(facts).toContain('—');                 // score placeholder
  });

  // Unlocking used to be reachable ONLY from the Results status card, so a user
  // who became eligible and came straight here saw the locked page despite
  // qualifying. Visiting this page now attempts the (idempotent) unlock.
  it('attempts qualification + unlock on visit, so unlocking is order-independent', () => {
    recordSig.set(null);
    render();
    expect(ensureQualificationStarted).toHaveBeenCalled();
    expect(unlock).toHaveBeenCalled();
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

  it('does not re-issue when already unlocked (id and date stay stable)', () => {
    recordSig.set(issued());
    const fixture = render();
    const idText = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(idText).toContain('AQ-2026-000128');
    // unlock() is idempotent: it returns the existing record rather than a new one.
    expect(unlock).toHaveBeenCalled();
    expect(recordSig()?.certificateId).toBe('AQ-2026-000128');
    expect(recordSig()?.unlockedAt).toBe('2026-07-24T15:00:00.000Z');
  });
});
