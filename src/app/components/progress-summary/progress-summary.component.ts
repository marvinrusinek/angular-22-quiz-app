import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { TitleCasePipe } from '@angular/common';
import { Router } from '@angular/router';

import { ProgressSummary } from '@shared/models';
import { WeakAreasService } from '@shared/services/progress/weak-areas.service';
import { PracticeSessionService } from '@shared/services/features/practice/practice-session.service';

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
  templateUrl: './progress-summary.component.html',
  styleUrl: './progress-summary.component.scss'
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
    const names = this.weakTopics()
      .map((t) => t.topicName)
      .join(', ');
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
