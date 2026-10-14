import { QuizDifficulty } from './Quiz.model';

/** Per-quiz progress, derived from the quiz list + the best-score store. */
export interface QuizProgress {
  quizId: string;
  completed: boolean;
  bestScore: number | null; // null when not completed (or no reliable score)
  difficulty?: QuizDifficulty;
}

/** Completion progress within a single difficulty group. */
export interface DifficultyProgress {
  difficulty: QuizDifficulty;
  completed: number;
  total: number;
}

/** A completed quiz surfaced as strongest / weakest. */
export interface QuizProgressSummary {
  quizId: string;
  milestone: string;
  bestScore: number;
}

/** Aggregate, derived progress across all quizzes. Nothing here is persisted. */
export interface ProgressSummary {
  completedCount: number;
  totalCount: number;
  completionPercentage: number;
  byDifficulty: DifficultyProgress[];
  strongestQuiz: QuizProgressSummary | null;
  weakestQuiz: QuizProgressSummary | null;
  /** Mean of the best completed score (percent) across completed quizzes; 0 when none. */
  averageScore: number;
  /** Number of completed quizzes whose best score is 100% (all questions correct); 0 when none. */
  perfectScores: number;
  /** Total questions across completed quizzes, counting each quiz's best attempt once; 0 when none. */
  questionsCompleted: number;
}
