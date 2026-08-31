import { inject, Service } from '@angular/core';

import { Quiz, QuizDifficulty } from '../../models/Quiz.model';
import {
  DifficultyProgress,
  ProgressSummary,
  QuizProgress,
  QuizProgressSummary
} from '../../models/progress.model';
import { BestScoreService } from './best-score.service';

/** Canonical difficulty order for display (matches the catalog stats row). */
const DIFFICULTY_ORDER: readonly QuizDifficulty[] = ['beginner', 'intermediate', 'advanced'];

/**
 * The single place that derives long-term progress. It reads the current quiz
 * list (passed in) and the shared best-score store, and produces per-quiz and
 * aggregate progress. It holds NO markup, no DOM access, and persists nothing —
 * every value here is derived from data the app already stores.
 *
 * Dependency direction: completion + best scores → Progress Tracking. It does
 * NOT depend on achievement state.
 */
@Service()
export class ProgressService {
  private readonly bestScoreService = inject(BestScoreService);

  /** Per-quiz progress for the given quiz list (does not mutate the input). */
  getQuizProgress(quizzes: Quiz[]): QuizProgress[] {
    const best = this.bestScoreService.getBestScores();
    return (quizzes ?? []).map(quiz => {
      const completed = Object.prototype.hasOwnProperty.call(best, quiz.quizId);
      const score = best[quiz.quizId];
      return {
        quizId: quiz.quizId,
        completed,
        bestScore: completed && typeof score === 'number' ? score : null,
        difficulty: quiz.difficulty
      };
    });
  }

  /** Aggregate progress summary for the given quiz list (does not mutate the input). */
  getProgressSummary(quizzes: Quiz[]): ProgressSummary {
    const list = quizzes ?? [];
    const best = this.bestScoreService.getBestScores();
    const isCompleted = (quiz: Quiz): boolean =>
      Object.prototype.hasOwnProperty.call(best, quiz.quizId);

    const totalCount = list.length;
    const completed = list.filter(isCompleted);
    const completedCount = completed.length;
    const completionPercentage =
      totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

    // New summary metrics — all derived from the SAME best-score store + quiz
    // list, using each quiz's BEST completed attempt (best[] already holds the
    // highest recorded percentage, so retakes never double-count). No new
    // storage, no separate calculation path.
    const bestScores = completed
      .map((quiz) => best[quiz.quizId])
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const averageScore = bestScores.length
      ? Math.round(bestScores.reduce((sum, v) => sum + v, 0) / bestScores.length)
      : 0;
    // Perfect = best score is 100% (all questions correct). Scores are stored as
    // rounded 0–100 percentages, so 100 is exactly a perfect attempt.
    const perfectScores = bestScores.filter((v) => v === 100).length;
    // Total questions across completed quizzes (best attempt each, counted once).
    // Prefer the metadata-sourced questionCount (Quiz Selection's catalog
    // projection carries no `questions` array); fall back to `.questions.length`
    // for any caller still passing an answer-bearing Quiz.
    const questionsCompleted = completed.reduce(
      (sum, quiz) => sum + (quiz.questionCount ?? quiz.questions?.length ?? 0),
      0
    );

    // Only difficulties actually present in the data, in canonical order.
    const byDifficulty: DifficultyProgress[] = [];
    for (const difficulty of DIFFICULTY_ORDER) {
      const group = list.filter(q => (q.difficulty ?? '').toLowerCase() === difficulty);
      if (group.length === 0) continue;  // omit empty groups
      byDifficulty.push({
        difficulty,
        completed: group.filter(isCompleted).length,
        total: group.length
      });
    }

    // Strongest / weakest are ranked among quizzes completed WITH a numeric score.
    // Tie-break: higher/lower best score, then existing display order (list index).
    // No reliable per-quiz timestamps exist, so the timestamp tie-breaker is skipped.
    const ranked = list
      .map((quiz, index) => ({ quiz, index, bestScore: best[quiz.quizId] }))
      .filter(x => isCompleted(x.quiz) && typeof x.bestScore === 'number');

    const toSummary = (x: { quiz: Quiz; bestScore: number }): QuizProgressSummary => ({
      quizId: x.quiz.quizId,
      milestone: x.quiz.milestone,
      bestScore: x.bestScore
    });

    let strongestQuiz: QuizProgressSummary | null = null;
    let weakestQuiz: QuizProgressSummary | null = null;

    if (ranked.length >= 1) {
      const strongest = [...ranked].sort(
        (a, b) => b.bestScore - a.bestScore || a.index - b.index
      )[0];
      strongestQuiz = toSummary(strongest);
    }
    // Hide "weakest / needs review" until at least two quizzes are completed, so a
    // single completed quiz isn't shown as both strongest and weakest.
    if (ranked.length >= 2) {
      const weakest = [...ranked].sort(
        (a, b) => a.bestScore - b.bestScore || a.index - b.index
      )[0];
      weakestQuiz = toSummary(weakest);
    }

    return {
      completedCount,
      totalCount,
      completionPercentage,
      byDifficulty,
      strongestQuiz,
      weakestQuiz,
      averageScore,
      perfectScores,
      questionsCompleted
    };
  }
}
