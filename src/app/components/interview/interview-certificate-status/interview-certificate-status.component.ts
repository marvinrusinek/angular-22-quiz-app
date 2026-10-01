import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnInit,
  ViewEncapsulation
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { InterviewCertificateService } from '@shared/services/features/interview/interview-certificate.service';
import { CertificateClaimService } from '@shared/services/features/interview/certificate-claim.service';
import {
  certificateAccessibleSummary,
  certificateInterviewsShown,
  certificateNextAction
} from '@shared/utils/interview-certificate-progress';

/**
 * Certificate status on the Interview Results page. THREE states:
 *   1. A certificate already exists (verified OR legacy) — "View Certificate".
 *   2. Both requirements are met but nothing is claimed yet — a CTA to the
 *      claim form. NOT an automatic unlock: issuing now requires an
 *      explicit name + verified email, submitted on the claim page.
 *   3. Still in progress — the existing checklist.
 *
 * Eligibility rules/persistence live in InterviewCertificateService; the
 * verified-claim state lives in CertificateClaimService. This component only
 * RENDERS both.
 */
@Component({
  selector: 'app-interview-certificate-status',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './interview-certificate-status.component.html',
  styleUrls: ['./interview-certificate-status.component.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InterviewCertificateStatusComponent implements OnInit {
  readonly cert = inject(InterviewCertificateService);
  private readonly claimService = inject(CertificateClaimService);

  readonly hasCertificate = computed(() => this.claimService.status() === 'verified' || this.cert.unlocked());
  readonly progress = this.cert.progress;
  readonly awaitingClaim = computed(() => !this.hasCertificate() && this.progress().isEligible);

  readonly nextAction = computed(() => certificateNextAction(this.progress()));
  readonly srSummary = computed(() => certificateAccessibleSummary(this.progress()));

  // Capped for display — never "18 / 5". See certificateInterviewsShown().
  readonly interviewsShown = computed(() => certificateInterviewsShown(this.progress()));
  readonly interviewsMet = computed(
    () => this.progress().qualifyingInterviewsCompleted >= this.progress().requiredInterviews
  );

  // Optional "journey started on …" caption (locale date; '' until qualified).
  readonly journeyDate = computed(() => {
    const iso = this.progress().qualificationStartedAt;
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  });

  ngOnInit(): void {
    // Start (or migrate) the certificate qualification period once — the first
    // time this surface is seen with the topic curriculum complete. This only
    // affects WHICH interviews qualify; it never issues anything.
    this.cert.ensureQualificationStarted();
  }
}
