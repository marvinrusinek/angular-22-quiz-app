import { computed, inject, Service } from '@angular/core';

import { InterviewHistoryService } from '@shared/services/features/interview/interview-history.service';
import { TopicPerformanceHistoryService } from './topic-performance-history.service';
import { calculateWeakTopics, TopicAttemptLike, WeakTopic } from '@shared/utils/weak-areas';

/**
 * THE single source of "which topics are weakest" — consumed by BOTH the Your
 * Progress action's topic labels and the practice-session generator, so the UI
 * can never advertise one topic while the generator picks another.
 *
 * Accuracy is the SAME formula used by Interview Readiness and Topic Trends
 * (aggregateTopicPercentages, via calculateWeakTopics). What differs is the
 * DATASET, deliberately: weak areas merge every reliable source of raw
 * correct/answered counts —
 *   - Interview History attempts        (interview-only analytics keep using these alone)
 *   - topic-quiz records                (topicPerformanceHistory:v1)
 *   - Weak Areas Practice records       (topicPerformanceHistory:v1)
 *
 * This is not a competing definition of accuracy; it is one formula over an
 * explicitly broader set. Nothing here writes to Interview History, so
 * certificate qualification, interview counts and interview-only trends are
 * untouched.
 */
@Service()
export class WeakAreasService {
  private readonly interviewHistory = inject(InterviewHistoryService);
  private readonly topicHistory = inject(TopicPerformanceHistoryService);

  /** Every reliable attempt-shaped record, from all sources. */
  readonly mergedAttempts = computed<TopicAttemptLike[]>(() => [
    ...this.interviewHistory.history(),
    ...this.topicHistory.asAttempts()
  ]);

  /** Up to three weakest topics, weakest first. Empty when none qualify. */
  readonly weakTopics = computed<WeakTopic[]>(() =>
    calculateWeakTopics(this.mergedAttempts())
  );

  /** True when at least one topic currently qualifies as weak. */
  readonly hasWeakTopics = computed(() => this.weakTopics().length > 0);

  /**
   * True when there is not yet enough reliable data to judge ANY topic — i.e.
   * no topic has reached the minimum answered count. Distinct from "measured
   * everything and nothing is weak", which the UI words differently.
   */
  readonly hasInsufficientData = computed(() => {
    const attempts = this.mergedAttempts();
    if (attempts.length === 0) return true;
    // Any topic that clears the minimum sample means we CAN judge; whether it is
    // weak is a separate question.
    const judged = calculateWeakTopics(attempts, { threshold: 101 });   // 101 ⇒ "every judgeable topic"
    return judged.length === 0;
  });

  /** The stable topic ids the practice generator should draw from. */
  readonly weakTopicIds = computed<string[]>(() => this.weakTopics().map((t) => t.topicId));
}
