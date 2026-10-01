import { ChangeDetectionStrategy, Component, inject, OnInit, signal, ViewEncapsulation } from '@angular/core';
import { RouterLink } from '@angular/router';

import { CertificateClaimService } from '@shared/services/features/interview/certificate-claim.service';
import { CertificateClaimApiError } from '@shared/services/api/certificate-claim-api.errors';
import { ThemeToggleComponent } from '../../../components/theme-toggle/theme-toggle.component';

type ViewState = 'loading' | 'preview' | 'confirming' | 'confirmed' | 'error';

/**
 * The email-link confirmation page. Reachable at
 * /interview/certificate/verify — the link in the verification email points
 * here with the raw token in a URL FRAGMENT (#token=...), never a query
 * string, so it is never sent to any server or appear in access logs or
 * Referer headers (see backend/src/certificate's own design doc).
 *
 * SAFETY-CRITICAL: ngOnInit calls previewToken() ONLY — a read-only call
 * that does NOT consume the token. The token is consumed ONLY by
 * confirm(), which fires EXCLUSIVELY from the explicit button click in the
 * template. Opening this link, reloading it, or a link-preview crawler
 * fetching it can never, by itself, issue a certificate.
 */
@Component({
  selector: 'codelab-interview-certificate-verify',
  standalone: true,
  imports: [RouterLink, ThemeToggleComponent],
  templateUrl: './interview-certificate-verify.component.html',
  styleUrls: ['./interview-certificate-verify.component.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InterviewCertificateVerifyComponent implements OnInit {
  private readonly claimService = inject(CertificateClaimService);

  readonly view = signal<ViewState>('loading');
  readonly claimedName = signal('');
  readonly emailMasked = signal('');
  readonly errorMessage = signal('');
  readonly certificate = this.claimService.certificate;

  private token = '';

  ngOnInit(): void {
    this.token = this.readTokenFromFragment();
    if (!this.token) {
      this.view.set('error');
      this.errorMessage.set('This link is not valid.');
      return;
    }
    void this.loadPreview();
  }

  private async loadPreview(): Promise<void> {
    try {
      const preview = await this.claimService.previewToken(this.token);
      this.claimedName.set(preview.claimedName);
      this.emailMasked.set(preview.emailMasked);
      this.view.set('preview');
    } catch (err: unknown) {
      this.view.set('error');
      this.errorMessage.set(err instanceof CertificateClaimApiError ? err.userMessage : 'This link is not valid.');
    }
  }

  async confirm(): Promise<void> {
    this.view.set('confirming');
    try {
      await this.claimService.confirmToken(this.token);
      this.view.set('confirmed');
    } catch (err: unknown) {
      this.view.set('error');
      this.errorMessage.set(err instanceof CertificateClaimApiError ? err.userMessage : 'Something went wrong. Please try again.');
    }
  }

  /** The raw token travels ONLY in the fragment — never read from the query string, which a server/proxy/analytics tool could log. */
  private readTokenFromFragment(): string {
    const hash = globalThis.location?.hash ?? '';
    const match = /token=([^&]+)/.exec(hash);
    return match ? decodeURIComponent(match[1]) : '';
  }
}
