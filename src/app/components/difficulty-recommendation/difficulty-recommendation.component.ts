import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  OnInit,
  output
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { DifficultyAction, DifficultyRecommendation } from '@shared/models';
import { InterviewCertificateService } from '@shared/services/features/interview/interview-certificate.service';
import { CertificateClaimService } from '@shared/services/features/interview/certificate-claim.service';
import { certificateNextAction } from '@shared/utils/interview-certificate-progress';

/**
 * Compact, advisory "Difficulty Recommendation" card for Quiz Selection.
 *
 * For non-complete levels it renders the derived difficulty advice. Once the
 * curriculum is COMPLETE it becomes the certificate-journey card, whose message
 * tracks the user's progress (reusing InterviewCertificateService — the single
 * source of truth; it never recomputes eligibility):
 *   - before Interview Master → "…become an Interview Master."
 *   - Interview Master earned, certificate not yet → "Complete N qualifying interviews…"
 *   - certificate earned → 🎖 Certificate Earned → View Certificate.
 * The parent still owns Build/browse navigation.
 */
@Component({
  selector: 'codelab-difficulty-recommendation',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './difficulty-recommendation.component.html',
  styleUrl: './difficulty-recommendation.component.scss'
})
export class DifficultyRecommendationComponent implements OnInit {
  private readonly cert = inject(InterviewCertificateService);
  private readonly claimService = inject(CertificateClaimService);

  readonly recommendation = input.required<DifficultyRecommendation | null>();

  /** Emits when the user chooses to build an interview (completion state). */
  readonly buildInterview = output<void>();
  /** Emits the target difficulty when the user chooses to browse those quizzes. */
  readonly browse = output<string>();

  // Certificate state — a VERIFIED claim or a LEGACY local record, same
  // precedence as the other certificate-status surfaces (see
  // CertificateEarnedBadgeComponent / InterviewCertificateCalloutComponent).
  readonly certUnlocked = computed(
    () => this.claimService.status() === 'verified' || this.cert.unlocked()
  );
  readonly certProgress = this.cert.progress;

  // Reuses the shared helper rather than restating the requirement, so this
  // surface tracks real progress and stays in step with Results + Builder.
  readonly certNextAction = computed(() => certificateNextAction(this.certProgress()));

  // Kept for template clarity; routing decisions stay in the parent.
  protected readonly hasAction = computed(() => !!this.recommendation()?.action);

  ngOnInit(): void {
    // The certificate-journey card is a certificate-eligibility surface: start
    // (or migrate) the qualification period once the curriculum is complete.
    this.cert.ensureQualificationStarted();
  }

  act(action: DifficultyAction): void {
    if (action.kind === 'interview') {
      this.buildInterview.emit();
    } else {
      this.browse.emit(action.difficulty ?? '');
    }
  }
}
