import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnInit,
  signal,
  ViewEncapsulation
} from '@angular/core';
import { RouterLink } from '@angular/router';

import {
  CERTIFICATE_REQUIRED_BAND,
  CERTIFICATE_TITLE,
  REQUIRED_CERTIFICATE_INTERVIEWS
} from '@shared/models';
import {
  InterviewCertificateService,
  readinessBandLabel
} from '@shared/services/features/interview/interview-certificate.service';
import { CertificateClaimService } from '@shared/services/features/interview/certificate-claim.service';
import { InterviewReadinessService } from '@shared/services/features/interview/interview-readiness.service';
import { InterviewHistoryService } from '@shared/services/features/interview/interview-history.service';
import { ThemeToggleComponent } from '../../../components/theme-toggle/theme-toggle.component';

/**
 * The Angular Interview Master Certificate page. READ-ONLY and
 * presentation-only. Reachable at /interview/certificate.
 *
 * THREE possible states, checked in this order:
 *   1. A VERIFIED, backend-issued certificate exists (CertificateClaimService)
 *      — the normal path going forward. Shown with no "legacy" label.
 *   2. No verified certificate, but a LEGACY locally-issued one exists
 *      (InterviewCertificateService, from before this feature) — preserved
 *      exactly as issued, never deleted, but clearly labelled as legacy and
 *      not email-verified, with a CTA to claim a verified one.
 *   3. Neither exists. If eligible, a CTA to the claim form
 *      (/interview/certificate/claim) — NOT an automatic unlock. Unlocking a
 *      local record on page load is what this feature replaces; see
 *      InterviewCertificateService's own doc comment.
 *
 * Print-friendly: only the certificate itself prints (see the SCSS
 * `@media print`), so it doubles as a portfolio artifact.
 */
@Component({
  selector: 'codelab-interview-certificate',
  standalone: true,
  imports: [RouterLink, ThemeToggleComponent],
  templateUrl: './interview-certificate.component.html',
  styleUrls: ['./interview-certificate.component.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InterviewCertificateComponent implements OnInit {
  private readonly certService = inject(InterviewCertificateService);
  private readonly claimService = inject(CertificateClaimService);
  private readonly readinessService = inject(InterviewReadinessService);
  private readonly historyService = inject(InterviewHistoryService);

  readonly title = CERTIFICATE_TITLE;
  readonly requiredInterviews = REQUIRED_CERTIFICATE_INTERVIEWS;

  readonly verifiedCertificate = this.claimService.certificate;
  readonly isVerified = computed(() => this.claimService.status() === 'verified');

  /** The legacy, locally-issued record — never shown once a verified certificate exists. */
  readonly legacyRecord = this.certService.record;
  readonly hasLegacy = computed(() => this.certService.unlocked() && !this.isVerified());

  readonly unlocked = computed(() => this.isVerified() || this.hasLegacy());
  readonly isEligible = computed(() => this.certService.progress().isEligible);
  readonly persistenceFailed = this.certService.persistenceFailed;

  // Live readiness tier for display — reuses the readiness service (no re-derive).
  // Falls back to the required tier if history has since aged out (the
  // certificate stays valid; the tier was met when it was issued).
  readonly tierLabel = computed(() =>
    readinessBandLabel(this.readinessService.readiness()?.band ?? CERTIFICATE_REQUIRED_BAND)
  );

  // LEGACY CERTIFICATES ONLY — never read for a verified one (see the
  // template's own comment next to its one usage). This is this BROWSER's
  // local Interview History, so it is NOT part of the issued certificate
  // record and will differ (or be entirely absent) on a different browser
  // or device — exactly the kind of inconsistency a verified, server-issued
  // certificate must never show. Null only if history was cleared post-issue.
  readonly score = computed(() => this.historyService.trends().best);

  readonly recipientName = computed(() => this.verifiedCertificate()?.recipientName ?? this.legacyRecord()?.recipientName ?? '');
  readonly certificateId = computed(() => this.verifiedCertificate()?.certificateId ?? this.legacyRecord()?.certificateId ?? '');

  ngOnInit(): void {
    // Qualification-date tracking is unaffected by this feature — it only
    // counts WHICH interviews qualify, never issues anything. Kept so
    // progress()/isEligible() stay correct for a user reaching this page
    // for the first time.
    this.certService.ensureQualificationStarted();
    // Re-fetch a verified certificate via its stored retrieval token, so a
    // refresh or a later visit shows it without re-confirming. No-ops
    // silently if there is nothing to refresh (see the service's own doc
    // comment) — the legacy/eligible states below still render correctly
    // either way.
    void this.claimService.refresh();
  }

  readonly issuedDate = computed(() => {
    const iso = this.verifiedCertificate()?.issuedAt ?? this.legacyRecord()?.unlockedAt;
    if (!iso) return '';
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    } catch {
      return iso;
    }
  });

  // ── recipient name editing — LEGACY certificates only. A verified
  // certificate's name is the one confirmed by email and is not locally
  // editable; its recipientName comes from the backend. ──
  readonly canEditName = computed(() => this.hasLegacy());
  readonly editingName = signal(false);
  readonly nameDraft = signal('');

  startEditName(): void {
    this.nameDraft.set(this.recipientName());
    this.editingName.set(true);
  }

  onNameInput(value: string): void {
    this.nameDraft.set(value);
  }

  saveName(): void {
    this.certService.setRecipientName(this.nameDraft());
    this.editingName.set(false);
  }

  cancelEditName(): void {
    this.editingName.set(false);
  }

  print(): void {
    window.print();
  }
}
