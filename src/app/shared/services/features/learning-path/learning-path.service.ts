import { Service } from '@angular/core';

import { Quiz } from '@shared/models/Quiz.model';
import { LearningPathState, QuizRecommendation } from '@shared/models/learning-path.model';

/**
 * Suggests ONE helpful next topic quiz from the user's existing progress. Pure:
 * given the catalog + which quizzes are completed / in progress, it returns a
 * recommendation. It reads no storage and owns no progress rules — the caller
 * passes the SAME completed / in-progress state the rest of Quiz Selection
 * already derives (BestScoreService completion + quiz status), so nothing is
 * duplicated and Interview Mode (which uses synthetic ids, never a catalog
 * quizId) can never appear in these sets.
 *
 * Rule order: in-progress → new-user intro → mapped follow-up → current
 * difficulty → any incomplete. It only guides; it never locks or forces a path.
 */
@Service()
export class LearningPathService {
  /** Advance to the next difficulty once ~this fraction of a level is completed. */
  private static readonly LEVEL_UP_THRESHOLD = 0.75;

  /** The introductory quiz recommended to brand-new users. */
  private static readonly INTRO_QUIZ_ID = 'create-first-app';

  /**
   * Small, maintainable topic map: completed quizId → the quiz(es) that logically
   * follow it, in priority order. Missing/renamed ids simply don't match a
   * catalog quiz and are skipped (see rule "fail safely"). Keyed by stable
   * quizIds, not titles.
   */
  static readonly TOPIC_FOLLOW_UPS: Readonly<Record<string, readonly string[]>> = {
    'create-first-app': ['templates'],
    templates: ['directives'],
    directives: ['component-tree'],
    'component-tree': ['component-architecture'],
    'dependency-injection': ['dependency-injection-advanced'],
    rxjs: ['signals'],
    signals: ['change-detection'],
    'change-detection': ['performance'],
    forms: ['http'],
    http: ['security'],
    security: ['testing']
  };

  recommend(
    quizzes: readonly Quiz[] | null | undefined,
    completedIds: ReadonlySet<string>,
    inProgressIds: ReadonlySet<string>
  ): LearningPathState {
    const list = (quizzes ?? []).filter((q): q is Quiz => !!q && !!q.quizId);
    const total = list.length;
    const byId = new Map(list.map((q) => [q.quizId, q]));
    const isCompleted = (id: string): boolean => completedIds.has(id);
    const incomplete = list.filter((q) => !isCompleted(q.quizId));

    // No catalog yet (still loading) → nothing to recommend.
    if (total === 0) {
      return { recommendation: null, allComplete: false, totalCount: 0 };
    }

    // Rule 5: every topic quiz is completed → completion state.
    if (incomplete.length === 0) {
      return { recommendation: null, allComplete: true, totalCount: total };
    }

    const state = (quiz: Quiz, reason: string, actionLabel: QuizRecommendation['actionLabel']): LearningPathState => ({
      recommendation: {
        quizId: quiz.quizId,
        title: quiz.milestone ?? quiz.quizId,
        difficulty: quiz.difficulty ?? '',
        reason,
        actionLabel
      },
      allComplete: false,
      totalCount: total
    });

    // Rule 1: continue an in-progress (started, not completed) quiz first.
    const inProgress = list.find((q) => inProgressIds.has(q.quizId) && !isCompleted(q.quizId));
    if (inProgress) {
      return state(inProgress, 'Continue where you left off.', 'Continue Quiz');
    }

    // Rule 4: brand-new user (no completed quizzes) → the introductory quiz.
    if (completedIds.size === 0) {
      const intro = byId.get(LearningPathService.INTRO_QUIZ_ID) ?? incomplete[0];
      return state(intro, 'Start with the Angular fundamentals.', 'Start Quiz');
    }

    // Rule 2: a follow-up of something already completed (fundamentals-first order).
    for (const [prereqId, followUps] of Object.entries(LearningPathService.TOPIC_FOLLOW_UPS)) {
      if (!isCompleted(prereqId)) continue;
      for (const followId of followUps) {
        const followQuiz = byId.get(followId);
        if (followQuiz && !isCompleted(followId)) {
          const prereqTitle = byId.get(prereqId)?.milestone ?? prereqId;
          return state(followQuiz, `Build on your ${prereqTitle} knowledge.`, 'Start Quiz');
        }
      }
    }

    // Rule 3: an incomplete quiz within the user's current difficulty level.
    const current = this.currentDifficulty(list, completedIds);
    const atLevel = incomplete.find((q) => (q.difficulty ?? '').toLowerCase() === current);
    if (atLevel) {
      return state(atLevel, this.difficultyReason(current), 'Start Quiz');
    }

    // Fallback (rule "fail safely"): any incomplete quiz — never nothing while
    // work remains, even if the map/difficulty branches all miss.
    return state(incomplete[0], 'Continue your Angular learning journey.', 'Start Quiz');
  }

  /**
   * Current difficulty from completion: stay at a level until ~75% of it is done,
   * then step up. Levels with no quizzes are treated as already cleared.
   */
  private currentDifficulty(
    list: readonly Quiz[],
    completedIds: ReadonlySet<string>
  ): 'beginner' | 'intermediate' | 'advanced' {
    const completedRatio = (difficulty: string): number => {
      const group = list.filter((q) => (q.difficulty ?? '').toLowerCase() === difficulty);
      if (group.length === 0) return 1;
      return group.filter((q) => completedIds.has(q.quizId)).length / group.length;
    };

    if (completedRatio('beginner') < LearningPathService.LEVEL_UP_THRESHOLD) return 'beginner';
    if (completedRatio('intermediate') < LearningPathService.LEVEL_UP_THRESHOLD) return 'intermediate';
    return 'advanced';
  }

  private difficultyReason(difficulty: string): string {
    switch (difficulty) {
      case 'intermediate':
        return 'You are ready to move into Intermediate topics.';
      case 'advanced':
        return 'You are ready to take on Advanced topics.';
      default:
        return 'Keep building your Angular fundamentals.';
    }
  }
}
