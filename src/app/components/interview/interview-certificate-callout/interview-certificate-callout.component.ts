import { ChangeDetectionStrategy, Component, computed, inject, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';

import { InterviewCertificateService } from '@shared/services/features/interview/interview-certificate.service';
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
  template: `
    <section class="icc" aria-labelledby="icc-title">
      <!-- One screen-reader sentence (static — not a live region). -->
      <p class="icc__sr">{{ srSummary() }}</p>

      @if (unlocked()) {
        <p class="icc__earned">
          <span class="icc__badge" aria-hidden="true">🎓</span>
          <span i18n>Certificate Earned</span>
          <span class="icc__check" aria-hidden="true">✓</span>
        </p>
        <a class="icc__cta" routerLink="/interview/certificate"
           aria-label="View your Angular Interview Master certificate" i18n-aria-label i18n>View Certificate</a>
      } @else {
        <h3 id="icc-title" class="icc__title" i18n>Angular Interview Master Certificate</h3>

        @if (progress().angularExplorerEarned) {
          <p class="icc__line icc__line--ok">
            <span class="icc__ok" aria-hidden="true">✓</span>
            <ng-container i18n>Angular Explorer unlocked</ng-container>
          </p>
        }
        <p class="icc__line" i18n>Interviews completed: {{ interviewsShown() }} / {{ progress().requiredInterviews }}</p>
        <p class="icc__action">{{ nextAction() }}</p>
      }
    </section>
  `,
  styles: [`
    .icc {
      max-width: 560px;
      margin: 0 auto 14px;
      padding: 12px 16px;
      border: 1px solid var(--border-color, #e0e0e0);
      border-left: 3px solid var(--text-link, #3b98fd);
      border-radius: 10px;
      background: var(--bg-secondary, #f5f5f5);
      color: var(--text-primary, #212121);
      box-sizing: border-box;
    }
    .icc__sr {
      position: absolute; width: 1px; height: 1px;
      padding: 0; margin: -1px; overflow: hidden;
      clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
    }
    .icc__title { margin: 0 0 6px; font-size: 13px; font-weight: 700; }
    .icc__line { margin: 2px 0; font-size: 13px; color: var(--text-secondary, #555); font-variant-numeric: tabular-nums; }
    .icc__line--ok { color: #2e9e5b; font-weight: 600; }
    .icc__ok { margin-right: 4px; }
    .icc__action { margin: 6px 0 0; font-size: 13px; font-weight: 600; }
    .icc__earned {
      display: flex; align-items: center; gap: 6px;
      margin: 0 0 8px; font-size: 15px; font-weight: 800;
    }
    .icc__badge { font-size: 20px; line-height: 1; }
    .icc__check { color: #2e9e5b; }
    .icc__cta {
      display: inline-flex; align-items: center; min-height: 40px;
      padding: 6px 14px; border-radius: 8px;
      background: var(--text-link, #3b98fd); color: #fff;
      font-size: 13.5px; font-weight: 700; text-decoration: none;
    }
    .icc__cta:focus-visible { outline: 2px solid var(--text-link, #3b98fd); outline-offset: 2px; }
  `]
})
export class InterviewCertificateCalloutComponent implements OnInit {
  private readonly cert = inject(InterviewCertificateService);

  readonly unlocked = this.cert.unlocked;
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
