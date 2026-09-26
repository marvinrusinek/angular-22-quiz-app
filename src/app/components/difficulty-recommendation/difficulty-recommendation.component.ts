import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  OnInit,
  output,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { DifficultyAction, DifficultyRecommendation } from '@shared/models';
import { InterviewCertificateService } from '@shared/services/features/interview/interview-certificate.service';
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
  template: `
    @if (recommendation(); as r) {
      <section
        class="dr"
        aria-labelledby="dr-heading"
        [class.dr--complete]="r.level === 'complete'"
      >
        @if (r.level === 'complete') {
          @if (certUnlocked()) {
            <!-- Certificate earned -->
            <p
              id="dr-heading"
              class="dr__heading"
            >
              <span
                class="dr__icon"
                aria-hidden="true"
              >
                🎖
              </span>
              <ng-container i18n>Certificate Earned</ng-container>
            </p>
            <p
              class="dr__message"
              i18n
            >
              View your Angular Interview Master Certificate.
            </p>
            <a
              class="dr__btn"
              routerLink="/interview/certificate"
              aria-label="View your Angular Interview Master certificate"
              i18n-aria-label
              i18n
            >
              View Certificate
            </a>
          } @else {
            <!-- Curriculum done — certificate journey -->
            <p
              id="dr-heading"
              class="dr__heading"
            >
              <span
                class="dr__icon"
                aria-hidden="true"
              >
                💼
              </span>
              <ng-container i18n>Ready for Interview Mode?</ng-container>
            </p>
            @if (certProgress().interviewMasterEarned) {
              <!-- Same next-action sentence the Results card and Builder callout
                   show, so all three surfaces agree and it reflects ACTUAL
                   progress ("2 more interviews") rather than restating the bar. -->
              <p class="dr__message">{{ certNextAction() }}</p>
            } @else {
              <p
                class="dr__message"
                i18n
              >
                Build a mixed-topic interview and become an Interview Master.
              </p>
            }
            @if (r.action; as a) {
              <button
                type="button"
                class="dr__btn"
                (click)="act(a)"
                [attr.aria-label]="a.label"
              >
                {{ a.label }}
              </button>
            }
          }
        } @else {
          <!-- Difficulty advice (non-complete levels) -->
          <p
            id="dr-heading"
            class="dr__heading"
          >
            {{ r.heading }}
          </p>
          @if (r.message) {
            <p class="dr__message">{{ r.message }}</p>
          }
          @if (r.action; as a) {
            <button
              type="button"
              class="dr__btn"
              [class.dr__btn--ghost]="a.kind === 'browse'"
              (click)="act(a)"
              [attr.aria-label]="a.label"
            >
              {{ a.label }}
            </button>
          }
        }
      </section>
    }
  `,
  styles: [
    `
      .dr {
        max-width: 560px;
        margin: 10px auto 18px;
        padding: 14px 18px;
        border: 1px solid var(--border-color, #e0e0e0);
        border-radius: 12px;
        background: var(--bg-secondary, #f5f5f5);
        box-sizing: border-box;
      }

      .dr__heading {
        margin: 0 0 6px;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.6px;
        text-transform: uppercase;
        color: var(--text-secondary, #555);
      }

      .dr--complete .dr__heading {
        /* Celebratory completion — a touch more prominent, still understated. */
        font-size: 15px;
        letter-spacing: 0.2px;
        text-transform: none;
        color: var(--text-primary, #212121);
      }

      .dr__icon {
        margin-right: 4px;
      }

      .dr__message {
        margin: 0 0 12px;
        font-size: 14px;
        line-height: 1.45;
        color: var(--text-primary, #212121);
      }

      .dr__message:last-child {
        margin-bottom: 0;
      }

      .dr__btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 8px 16px;
        border: 1px solid #3b98fd;
        border-radius: 8px;
        background: #3b98fd;
        color: #fff;
        font-size: 13.5px;
        font-weight: 700;
        cursor: pointer;
        text-decoration: none;
        transition:
          filter 0.15s ease,
          background 0.15s ease,
          color 0.15s ease;
      }

      /* Browse is a lighter, secondary affordance (informational, not a primary CTA). */
      .dr__btn--ghost {
        background: transparent;
        color: #3b98fd;
      }

      .dr__btn:hover {
        filter: brightness(0.96);
      }

      .dr__btn--ghost:hover {
        background: rgba(59, 152, 253, 0.1);
      }

      .dr__btn:focus-visible {
        outline: 2px solid #3b98fd;
        outline-offset: 2px;
      }

      @media (max-width: 600px) {
        .dr__btn {
          width: 100%;
        }
      }
    `,
  ],
})
export class DifficultyRecommendationComponent implements OnInit {
  private readonly cert = inject(InterviewCertificateService);

  readonly recommendation = input.required<DifficultyRecommendation | null>();

  /** Emits when the user chooses to build an interview (completion state). */
  readonly buildInterview = output<void>();
  /** Emits the target difficulty when the user chooses to browse those quizzes. */
  readonly browse = output<string>();

  // Certificate state (single source of truth) — drives the complete-state copy.
  readonly certUnlocked = this.cert.unlocked;
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
