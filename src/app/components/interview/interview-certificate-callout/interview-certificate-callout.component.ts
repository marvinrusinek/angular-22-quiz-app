import { ChangeDetectionStrategy, Component, computed, inject, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';

import { InterviewCertificateService } from '@shared/services/features/interview/interview-certificate.service';
import { CertificateClaimService } from '@shared/services/features/interview/certificate-claim.service';
import {
  certificateAccessibleSummary,
  certificateInterviewsShown,
  certificateNextAction
} from '@shared/utils/interview-certificate-progress';

/**
 * Compact certificate progress callout for the Interview Builder — motivates
 * without competing with the primary "Build an Interview" action. Pure
 * presentation: it RENDERS the certificate service's progress model (never
 * recalculates eligibility) and never mutates any state. Reuses the same
 * next-action / accessible-summary helpers as the Results status card.
 */
@Component({
  selector: 'app-interview-certificate-callout',
  standalone: true,
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './interview-certificate-callout.component.html',
  styleUrl: './interview-certificate-callout.component.scss'
})
export class InterviewCertificateCalloutComponent implements OnInit {
  private readonly cert = inject(InterviewCertificateService);
  private readonly claimService = inject(CertificateClaimService);

  readonly unlocked = computed(
    () => this.claimService.status() === 'verified' || this.cert.unlocked()
  );
  readonly progress = this.cert.progress;

  readonly nextAction = computed(() => certificateNextAction(this.progress()));
  readonly srSummary = computed(() => certificateAccessibleSummary(this.progress()));

  // Capped for display — never "18 / 5". See certificateInterviewsShown().
  readonly interviewsShown = computed(() => certificateInterviewsShown(this.progress()));

  ngOnInit(): void {
    // First Builder visit with the curriculum complete starts the qualification
    // window (so interviews built from here on count). No-op otherwise.
    this.cert.ensureQualificationStarted();
  }
}
