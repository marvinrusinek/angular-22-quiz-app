import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { InterviewCertificateService } from '@shared/services/features/interview/interview-certificate.service';
import { CertificateClaimService } from '@shared/services/features/interview/certificate-claim.service';

/**
 * Small "🎖 Certificate Earned" status badge. Renders NOTHING until a
 * certificate exists — either a VERIFIED one (CertificateClaimService) or a
 * LEGACY, locally-issued one (InterviewCertificateService) — never inferred
 * from achievement counts. Clicking it opens the existing certificate page.
 * Presentation only — it derives no eligibility and mutates nothing.
 *
 * Accessibility: a real link with an accessible name announcing "Certificate
 * earned"; the medal emoji is decorative (aria-hidden). Theme-aware via the
 * app's CSS custom properties; a one-shot, reduced-motion-respecting fade-in.
 */
@Component({
  selector: 'app-certificate-earned-badge',
  standalone: true,
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './certificate-earned-badge.component.html',
  styleUrl: './certificate-earned-badge.component.scss'
})
export class CertificateEarnedBadgeComponent {
  private readonly cert = inject(InterviewCertificateService);
  private readonly claimService = inject(CertificateClaimService);

  readonly unlocked = computed(
    () => this.claimService.status() === 'verified' || this.cert.unlocked()
  );
}
