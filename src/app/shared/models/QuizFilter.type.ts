import type { QuizDifficulty } from './Quiz.model';

// Difficulty FILTER for the QuizSelection list. This is a filter, not a sort:
// it decides WHICH quizzes are shown, and is independent of the two sort
// dimensions in QuizSort.type.ts (which decide their ORDER).
//  - 'all'  = every difficulty (the default)
//  - otherwise only quizzes of that difficulty
export type DifficultyFilter = 'all' | QuizDifficulty;
