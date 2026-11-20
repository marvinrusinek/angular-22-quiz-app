import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { Router } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';

/**
 * The four dashboard entry cards, all native buttons. The two cards that need
 * the parent (browse the topic list, start a Weak Areas session) tell it through
 * outputs, so no session logic or guard bypass lives here. Interview Mode and
 * Certificate only navigate, through the Router, to the same routes their links
 * used to point at.
 */
@Component({
  selector: 'codelab-dashboard-feature-cards',
  standalone: true,
  imports: [MatIconModule],
  templateUrl: './dashboard-feature-cards.component.html',
  styleUrl: './dashboard-feature-cards.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DashboardFeatureCardsComponent {
  private readonly router = inject(Router);

  /** True when weak topics exist, i.e. a practice session can be started. */
  readonly weakAreasReady = input(false);

  /** True while a Weak Areas session is being started (blocks nothing here;
   *  the parent ignores clicks, this only reflects the state). */
  readonly weakAreasBusy = input(false);

  /** "Topic Quizzes": scroll to the topic list. */
  readonly browse = output<void>();

  /** "Weak Areas Practice": the parent starts the session, then navigates. */
  readonly practiceWeakAreas = output<void>();

  /** "Interview Mode": open the Interview builder. */
  openInterview(): void {
    void this.router.navigateByUrl('/interview');
  }

  /** "Certificate": open the Interview certificate page. */
  openCertificate(): void {
    void this.router.navigateByUrl('/interview/certificate');
  }
}
