/** A single "what to do next" suggestion for the Quiz Selection screen. */
export interface QuizRecommendation {
  quizId: string;
  title: string;
  difficulty: string;
  reason: string;
  actionLabel: 'Start Quiz' | 'Continue Quiz';
}

/**
 * The learning-path result. `recommendation` is null only when everything is
 * done (`allComplete`) or there are no quizzes at all. Nothing here is persisted
 * — it is derived from the existing progress state on each read.
 */
export interface LearningPathState {
  recommendation: QuizRecommendation | null;
  allComplete: boolean;
  /** Total topic quizzes — used by the "completed all N" message. */
  totalCount: number;
}

/**
 * "Recommended for Review": the COMPLETED quiz whose latest valid attempt
 * scored lowest. `latestPercent` comes from that attempt's correct / total,
 * never from a best score.
 */
export interface ReviewRecommendation {
  quizId: string;
  title: string;
  difficulty: string;
  /** Rounded 0-100 score of the latest valid attempt. */
  latestPercent: number;
  /** ISO time of that attempt. */
  completedAt: string;
}
