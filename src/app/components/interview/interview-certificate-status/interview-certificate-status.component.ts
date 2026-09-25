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
import { A11yModule } from '@angular/cdk/a11y';

import { InterviewCertificateService } from '@shared/services/features/interview/interview-certificate.service';
import {
  certificateAccessibleSummary,
  certificateInterviewsShown,
  certificateNextAction
} from '@shared/utils/interview-certificate-progress';

/**
 * Certificate status on the Interview Results page. When both requirements
 * (Angular Explorer earned + the required number of completed interviews) are
 * met it unlocks the certificate ONCE (via the service) and shows a tasteful,
 * subtle celebration dialog; thereafter it shows a "View Certificate" card.
 * Until then it shows transparent progress so the user always sees exactly what
 * remains — never both states at once.
 *
 * All rules/persistence live in InterviewCertificateService — this component
 * only RENDERS its progress model + triggers the one-time unlock.
 */
@Component({
  selector: 'app-interview-certificate-status',
  standalone: true,
  imports: [RouterLink, A11yModule],
  templateUrl: './interview-certificate-status.component.html',
  styleUrls: ['./interview-certificate-status.component.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InterviewCertificateStatusComponent implements OnInit {
  readonly cert = inject(InterviewCertificateService);

  readonly unlocked = this.cert.unlocked;
  readonly progress = this.cert.progress;

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

  // True only for the session in which the certificate was just unlocked here.
  readonly showDialog = signal(false);

  // Focus handling is delegated to cdkTrapFocus + cdkTrapFocusAutoCapture in the
  // template: it moves focus into the dialog, keeps Tab cycling inside it while
  // open, and restores focus to the previously focused element on close. That
  // replaces a manual focus() effect, which moved focus IN but neither trapped
  // it nor restored it.

  ngOnInit(): void {
    // Start (or migrate) the certificate qualification period once — the first
    // time this surface is seen with the topic curriculum complete.
    this.cert.ensureQualificationStarted();
    // Unlock exactly once, the first time the user reaches Results while eligible.
    if (!this.cert.unlocked() && this.cert.progress().isEligible) {
      const issued = this.cert.unlock();
      if (issued) this.showDialog.set(true);
    }
  }

  dismiss(): void {
    this.showDialog.set(false);
  }
}
