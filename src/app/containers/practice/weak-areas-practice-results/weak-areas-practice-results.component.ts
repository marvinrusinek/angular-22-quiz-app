import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  signal,
  viewChild,
  ViewEncapsulation
} from '@angular/core';
import { Router } from '@angular/router';

import { PracticeSessionService } from '@shared/services/features/practice/practice-session.service';
import { WeakAreasService } from '@shared/services/progress/weak-areas.service';
import { ThemeToggleComponent } from '../../../components/theme-toggle/theme-toggle.component';
import { ScrollDownIndicatorComponent } from '../../../components/scroll-down-indicator/scroll-down-indicator.component';

/**
 * Practice Results — overall score, per-topic breakdown and Answer Review.
 *
 * The result is READ from the session snapshot, never recomputed here, so a
 * remount or refresh renders the identical numbers that were recorded. Scoring
 * itself lives in practice-scoring.ts and reuses the shared `isAnswerCorrect()`.
 *
 * This page writes NOTHING except the topic-performance record: no Interview
 * History, no interview attempt counts, no certificates, no High Scores, no
 * achievements, no quiz completion counts. Difficulty Recommendation and
 * Recommended Next Quiz are likewise untouched.
 */
@Component({
  selector: 'codelab-weak-areas-practice-results',
  standalone: true,
  imports: [ThemeToggleComponent, ScrollDownIndicatorComponent],
  templateUrl: './weak-areas-practice-results.component.html',
  styleUrls: ['./weak-areas-practice-results.component.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class WeakAreasPracticeResultsComponent {
  private readonly session = inject(PracticeSessionService);
  private readonly weakAreas = inject(WeakAreasService);
  private readonly router = inject(Router);

  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');

  readonly result = this.session.result;

  readonly total = computed(() => this.result()?.total ?? 0);
  readonly correct = computed(() => this.result()?.correct ?? 0);
  readonly percentage = computed(() => this.result()?.percentage ?? 0);
  readonly perTopic = computed(() => this.result()?.perTopic ?? []);
  readonly review = computed(() => this.result()?.review ?? []);

  /**
   * Set when Practice Again finds nothing left to practise. Shown INSTEAD of
   * starting an empty session.
   */
  readonly noWeakAreasRemaining = signal(false);

  /** Whether more practice is currently available, used to word the action. */
  readonly hasWeakTopics = this.weakAreas.hasWeakTopics;

  constructor() {
    // Recording is idempotent and keyed by `practice:{sessionId}` against
    // PERSISTED state, so this remount/refresh entry point cannot duplicate it.
    this.session.ensureRecorded();
    afterNextRender(() => this.heading()?.nativeElement.focus());
  }

  /**
   * Practice Again: record → recalculate weak topics → generate a NEW randomized
   * session. Never a replay of the completed one.
   */
  async practiceAgain(): Promise<void> {
    if (!this.session.practiceAgain()) {
      this.noWeakAreasRemaining.set(true);
      return;
    }
    this.noWeakAreasRemaining.set(false);
    await this.router.navigate(['/practice/weak-areas']);
  }

  /**
   * Drops the completed snapshot, so browser Back cannot restore a finished
   * session. Recorded topic-performance history is deliberately left intact.
   */
  async backToQuizzes(): Promise<void> {
    this.session.clear();
    await this.router.navigate(['/quiz'], { replaceUrl: true });
  }
}
