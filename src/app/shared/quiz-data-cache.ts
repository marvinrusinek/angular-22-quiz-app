import { Quiz, QuizResource } from '@shared/models';

// Module-level cache populated at bootstrap by the APP_INITIALIZER
// in main.ts (which fetches assets/data/quiz.json once). Consumers read via
// the getters below instead of importing a static array — this keeps
// the 1100-line dataset out of the main JS bundle and lets us swap
// the data source without touching every consumer.

let _quizzes: Quiz[] = [];
let _resources: QuizResource[] = [];

export function getQuizData(): Quiz[] {
  return _quizzes;
}

export function getQuizResources(): QuizResource[] {
  return _resources;
}

export function setQuizDataCache(quizzes: Quiz[], resources: QuizResource[]): void {
  _quizzes = quizzes;
  _resources = resources;
}
