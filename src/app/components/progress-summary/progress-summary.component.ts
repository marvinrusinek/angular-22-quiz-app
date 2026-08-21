import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { TitleCasePipe } from '@angular/common';
import { Router } from '@angular/router';

import { ProgressSummary } from '../../shared/models/progress.model';
import { WeakAreasService } from '../../shared/services/progress/weak-areas.service';
import { PracticeSessionService } from '../../shared/services/features/practice/practice-session.service';

/**
 * "Your Progress" panel for the Quiz Selection page. It renders an
 * already-derived ProgressSummary and owns no storage or scoring rules of its
 * own. The one exception is Needs Review, which reads WeakAreasService directly
 * so the topics it names are exactly the ones the practice session will use.
 * Renders nothing until there is at least one quiz.
 *
 * Accessibility: every value is available as text (never color alone); the bars
 * are supplementary and carry role="progressbar" + aria-valuemin/max/now + a
 * descriptive aria-label. A single "Your Progress" heading anchors the region.
 */
@Component({
  selector: 'codelab-progress-summary',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TitleCasePipe],
  template: `
    @if (summary(); as s) {
      @if (s.totalCount > 0) {
        <section
          class="progress-summary"
          [class.progress-summary--details]="variant() === 'details'"
          [attr.aria-labelledby]="variant() === 'full' ? 'progress-summary-heading' : null"
          [attr.aria-label]="variant() === 'details' ? 'Progress details' : null"
        >
          @if (variant() === 'full') {
            <h2 id="progress-summary-heading" class="progress-summary__heading" i18n>Your Progress</h2>
          }

          <!-- Completed count is header-owned in the accordion, so it's shown only
               in the 'full' variant. The Overall Progress bar shows in both. -->
          <dl class="progress-summary__rows">
            @if (variant() === 'full') {
              <div class="progress-summary__row">
                <dt class="progress-summary__label" i18n>Completed</dt>
                <dd class="progress-summary__value">{{ s.completedCount }} / {{ s.totalCount }}</dd>
              </div>
            }

            <div class="progress-summary__row">
              <dt class="progress-summary__label" i18n>Overall Progress</dt>
              <dd class="progress-summary__value">
                <span class="progress-summary__pct">{{ s.completionPercentage }}%</span>
                <span
                  class="progress-summary__bar"
                  role="progressbar"
                  aria-valuemin="0"
                  aria-valuemax="100"
                  [attr.aria-valuenow]="s.completionPercentage"
                  [attr.aria-label]="'Overall progress: ' + s.completionPercentage + ' percent'"
                >
                  <span class="progress-summary__bar-fill" [style.width.%]="s.completionPercentage"></span>
                </span>
              </dd>
            </div>
          </dl>

          @if (s.byDifficulty.length > 0) {
            <dl class="progress-summary__rows progress-summary__rows--difficulty">
              @for (level of s.byDifficulty; track level.difficulty) {
                <div class="progress-summary__row">
                  <dt class="progress-summary__label">{{ level.difficulty | titlecase }}</dt>
                  <dd class="progress-summary__value">
                    <span class="progress-summary__count">{{ level.completed }} / {{ level.total }}</span>
                    <span
                      class="progress-summary__bar"
                      role="progressbar"
                      aria-valuemin="0"
                      [attr.aria-valuemax]="level.total"
                      [attr.aria-valuenow]="level.completed"
                      [attr.aria-label]="(level.difficulty | titlecase) + ': ' + level.completed + ' of ' + level.total + ' completed'"
                    >
                      <span
                        class="progress-summary__bar-fill"
                        [style.width.%]="level.total > 0 ? (level.completed / level.total) * 100 : 0"
                      ></span>
                    </span>
                  </dd>
                </div>
              }
            </dl>
          }

          <!-- Key stats (derived in ProgressService). Shown beneath the existing
               progress info; always present so 0-values appear when nothing is
               completed yet. -->
          <dl class="progress-summary__stats" aria-label="Key stats" i18n-aria-label>
            <div class="progress-summary__stat">
              <dt class="progress-summary__stat-label" i18n>Average Score</dt>
              <dd class="progress-summary__stat-value">{{ s.averageScore }}%</dd>
            </div>
            <div class="progress-summary__stat">
              <dt class="progress-summary__stat-label" i18n>Perfect Scores</dt>
              <dd class="progress-summary__stat-value">{{ s.perfectScores }}</dd>
            </div>
            <div class="progress-summary__stat">
              <dt class="progress-summary__stat-label" i18n>Questions Completed</dt>
              <dd class="progress-summary__stat-value">{{ s.questionsCompleted }}</dd>
            </div>
          </dl>

          @if (s.strongestQuiz || s.weakestQuiz || weakTopics().length > 0) {
            <dl class="progress-summary__rows progress-summary__rows--highlights">
              @if (s.strongestQuiz; as strong) {
                <div class="progress-summary__row">
                  <dt class="progress-summary__label" i18n>Strongest</dt>
                  <dd class="progress-summary__value">{{ strong.milestone }} — {{ strong.bestScore }}%</dd>
                </div>
              }
              <!-- Needs Review is driven by WeakAreasService, NOT the
                   best-score percentage that used to feed it: the practice
                   action below must offer exactly the topics named here, and a
                   best-score percentage cannot say how many questions were
                   answered. There is deliberately no percentage fallback. -->
              <div class="progress-summary__row">
                <dt class="progress-summary__label" i18n>Needs Review</dt>
                <dd class="progress-summary__value">
                  @if (weakTopics().length > 0) {
                    <span class="progress-summary__weak-list">
                      @for (t of weakTopics(); track t.topicId) {
                        <span class="progress-summary__weak-topic"
                          >{{ t.topicName }} — {{ t.percentage }}%</span
                        >
                      }
                    </span>
                  } @else if (insufficientData()) {
                    <span i18n>Complete a quiz or interview to identify weak areas.</span>
                  } @else {
                    <span i18n>No weak areas detected.</span>
                  }
                </dd>
              </div>
            </dl>

            <!-- Rendered directly from eligibility: shown ONLY when there are
                 weak topics to practise. The other two states are messages,
                 never a disabled button. -->
            @if (weakTopics().length > 0) {
              <button
                type="button"
                class="progress-summary__practice"
                [attr.aria-label]="practiceAriaLabel()"
                (click)="startPractice()"
                i18n
              >
                Practice Weak Areas
              </button>
            }
          }
        </section>
      }
    }
  `,
  styles: [`
    .progress-summary {
      max-width: 560px;
      margin: 4px auto 18px;
      padding: 14px 20px;
      border: 1px solid var(--border-color, #e0e0e0);
      border-radius: 12px;
      background: var(--bg-secondary, rgba(255, 255, 255, 0.6));
      box-sizing: border-box;
    }

    .progress-summary__heading {
      margin: 0 0 10px;
      font-size: 16px;
      font-weight: 700;
      color: var(--text-primary, #212121);
    }

    .progress-summary__rows {
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 7px;
    }

    .progress-summary__rows--difficulty,
    .progress-summary__rows--highlights {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--border-color, #e0e0e0);
    }

    /* Three understated stat cells beneath the progress rows. */
    .progress-summary__stats {
      margin: 12px 0 0;
      padding-top: 12px;
      border-top: 1px solid var(--border-color, #e0e0e0);
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
    }

    .progress-summary__stat {
      margin: 0;
      /* column-reverse: DOM is label→value (screen readers hear "Average Score,
         80%"), but the value shows on top like a stat tile. */
      display: flex;
      flex-direction: column-reverse;
      align-items: center;
      gap: 2px;
      text-align: center;
    }

    .progress-summary__stat-value {
      margin: 0;
      font-size: 19px;
      font-weight: 700;
      line-height: 1.1;
      color: var(--text-primary, #212121);
      font-variant-numeric: tabular-nums;
    }

    .progress-summary__stat-label {
      margin: 0;
      font-size: 10.5px;
      font-weight: 600;
      letter-spacing: 0.4px;
      line-height: 1.2;
      text-transform: uppercase;
      color: var(--text-secondary, #555555);
    }

    /* Details variant lives inside the expansion panel: drop the card chrome and
       the leading divider so it sits flush in the panel body. */
    .progress-summary--details {
      max-width: none;
      margin: 0;
      padding: 0;
      border: none;
      background: transparent;
    }

    .progress-summary--details .progress-summary__rows:first-child {
      margin-top: 0;
      padding-top: 0;
      border-top: none;
    }

    .progress-summary__row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .progress-summary__label {
      margin: 0;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-secondary, #555555);
      white-space: nowrap;
    }

    .progress-summary__value {
      margin: 0;
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary, #212121);
      font-variant-numeric: tabular-nums;
    }

    .progress-summary__pct,
    .progress-summary__count {
      min-width: 44px;
      text-align: right;
    }

    .progress-summary__bar {
      display: inline-block;
      width: 120px;
      height: 8px;
      border-radius: 999px;
      background: var(--bg-hover, rgba(0, 0, 0, 0.1));
      overflow: hidden;
    }

    .progress-summary__bar-fill {
      display: block;
      height: 100%;
      border-radius: 999px;
      background: var(--text-link, #3b98fd);
    }

    @media (max-width: 600px) {
      .progress-summary {
        margin: 4px 8px 16px;
        padding: 12px 14px;
      }

      .progress-summary__bar {
        width: 84px;
      }
    }
  `]
})
export class ProgressSummaryComponent {
  private readonly weakAreas = inject(WeakAreasService);
  private readonly practiceSession = inject(PracticeSessionService);
  private readonly router = inject(Router);

  /**
   * The SAME weak topics the practice session will draw from — one computed,
   * so the labels shown here can never name different topics than the generator
   * uses. Percentage is pre-rounded for display (templates can't call Math).
   */
  readonly weakTopics = computed(() =>
    this.weakAreas.weakTopics().map((t) => ({ ...t, percentage: Math.round(t.percentage) }))
  );

  /** True when no topic yet has enough answered questions to be judged. */
  readonly insufficientData = this.weakAreas.hasInsufficientData;

  /** Names the topics in the action's accessible label, not colour or position. */
  readonly practiceAriaLabel = computed(() => {
    const names = this.weakTopics().map((t) => t.topicName).join(', ');
    return names ? `Practice weak areas: ${names}` : 'Practice weak areas';
  });

  /**
   * Generate a session from the CURRENT weak topics, THEN navigate. The route
   * guard blocks direct URL entry, so the session must exist before we go — a
   * bare routerLink here would simply be bounced back.
   *
   * start() returns false when the weak topics cannot supply a single question,
   * so an eligible-looking action can never navigate into an empty session.
   */
  async startPractice(): Promise<void> {
    if (!(await this.practiceSession.start())) return;
    await this.router.navigate(['/practice/weak-areas']);
  }

  /** The derived aggregate progress. Renders nothing when there are no quizzes. */
  readonly summary = input<ProgressSummary | null>(null);

  /**
   * 'full' (default) renders the heading + Completed + Overall rows plus the
   * breakdown. 'details' omits the heading/Completed/Overall (they live in the
   * accordion header) and renders only the difficulty + strongest/needs-review
   * breakdown, with the card chrome stripped for use inside a panel.
   */
  readonly variant = input<'full' | 'details'>('full');

  /** Convenience for tests / hosts that prefer a boolean guard. */
  readonly hasQuizzes = computed(() => (this.summary()?.totalCount ?? 0) > 0);
}
