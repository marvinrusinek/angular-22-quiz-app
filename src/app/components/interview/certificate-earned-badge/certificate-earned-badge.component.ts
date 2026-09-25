import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { InterviewCertificateService } from '@shared/services/features/interview/interview-certificate.service';

/**
 * Small "🎖 Certificate Earned" status badge. Renders NOTHING until the Angular
 * Interview Master Certificate has actually been unlocked (single source of
 * truth: InterviewCertificateService.unlocked — never inferred from achievement
 * counts). Clicking it opens the existing certificate page. Presentation only —
 * it derives no eligibility and mutates nothing.
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
  template: `
    @if (unlocked()) {
      <a
        class="cert-badge"
        routerLink="/interview/certificate"
        aria-label="Certificate earned. View your Angular Interview Master certificate."
        i18n-aria-label
      >
        <span class="cert-badge__icon" aria-hidden="true">🎖</span>
        <span class="cert-badge__text" i18n>Certificate Earned</span>
      </a>
    }
  `,
  styles: [`
    .cert-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border: 1px solid var(--border-color, #e0e0e0);
      border-radius: 999px;
      background: var(--bg-secondary, #f5f5f5);
      color: var(--text-primary, #212121);
      font-size: 13px;
      font-weight: 600;
      line-height: 1.2;
      text-decoration: none;
      white-space: nowrap;              /* stays on one line; the ROW wraps it */
      /* One-shot subtle entrance (not continuous). */
      animation: cert-badge-in 0.28s ease-out;
    }

    .cert-badge:hover {
      border-color: var(--text-link, #3b98fd);
    }

    .cert-badge:focus-visible {
      outline: 2px solid var(--text-link, #3b98fd);
      outline-offset: 2px;
    }

    .cert-badge__icon { font-size: 15px; line-height: 1; }

    @keyframes cert-badge-in {
      from { opacity: 0; transform: translateY(-2px); }
      to   { opacity: 1; transform: none; }
    }

    @media (prefers-reduced-motion: reduce) {
      .cert-badge { animation: none; }
    }
  `]
})
export class CertificateEarnedBadgeComponent {
  private readonly cert = inject(InterviewCertificateService);

  /** Certificate state — the single source of truth. */
  readonly unlocked = this.cert.unlocked;
}
