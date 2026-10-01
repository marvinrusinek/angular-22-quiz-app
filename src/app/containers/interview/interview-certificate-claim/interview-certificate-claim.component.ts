import { ChangeDetectionStrategy, Component, inject, signal, ViewEncapsulation } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { CertificateClaimService } from '@shared/services/features/interview/certificate-claim.service';
import { swallow } from '@shared/utils/error-logging';
import { ThemeToggleComponent } from '../../../components/theme-toggle/theme-toggle.component';

/**
 * Required name + verified-email claim form. Reachable at
 * /interview/certificate/claim. Submitting (or re-submitting for recovery —
 * same form, same endpoint, see CertificateClaimService#submitClaim's own
 * doc comment) ALWAYS shows the identical "check your email" confirmation,
 * whatever the email's actual state server-side — this page must never
 * imply which case occurred.
 *
 * DISCLOSURE, shown plainly rather than buried in fine print: email
 * verification confirms control of the email address, not real-world
 * identity, and achievement eligibility itself remains browser-reported
 * (unchanged from before this feature). The submitted name and email are
 * shared with the app owner once the certificate is confirmed.
 */
@Component({
  selector: 'codelab-interview-certificate-claim',
  standalone: true,
  imports: [FormsModule, RouterLink, ThemeToggleComponent],
  templateUrl: './interview-certificate-claim.component.html',
  styleUrls: ['./interview-certificate-claim.component.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InterviewCertificateClaimComponent {
  private readonly claimService = inject(CertificateClaimService);

  readonly apiConfigured = this.claimService.apiConfigured;
  readonly busy = this.claimService.busy;
  readonly submitError = this.claimService.submitError;

  readonly name = signal('');
  readonly email = signal('');
  readonly submitted = signal(false);
  readonly recoveryMode = signal(false);

  onNameInput(value: string): void {
    this.name.set(value);
  }

  onEmailInput(value: string): void {
    this.email.set(value);
  }

  toggleRecoveryMode(): void {
    this.recoveryMode.set(!this.recoveryMode());
    this.submitted.set(false);
  }

  async submit(): Promise<void> {
    const name = this.name().trim();
    const email = this.email().trim();
    if (name.length === 0 || email.length === 0) return;

    try {
      // Recovery mode submits through the SAME call — the backend resolves
      // a recovery claim to the pre-existing certificate regardless of the
      // name submitted here (see CertificateClaimService#submitClaim's own
      // doc comment); there is no separate recovery request to make.
      await this.claimService.submitClaim(name, email);
      this.submitted.set(true);
    } catch (err: unknown) {
      // submitError() already reflects the failure for the template — this is
      // for local diagnostics only.
      swallow('interview-certificate-claim.component.ts', err);
    }
  }
}
