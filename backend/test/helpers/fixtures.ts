import { createQuizRepository, type QuizRepository } from '../../src/quiz/quiz.repository';
import type { AppDependencies } from '../../src/dependencies';

/**
 * A tiny in-memory bank. Health/CORS/error tests use this so they never depend
 * on the real private data file.
 */
export const FIXTURE_SOURCE = {
  quizzes: [
    {
      quizId: 'rxjs',
      milestone: 'RxJS',
      // Deliberately contains the WORDS "correct", "answer" and "explanation"
      // in free text — the guard inspects property NAMES, never values.
      summary: 'Learn which answer is correct and read the explanation.',
      image: 'rxjs.svg',
      difficulty: 'intermediate',
      questions: [
        {
          questionText: 'Which answer is correct?',
          explanation: 'PRIVATE-EXPLANATION-RXJS',
          options: [
            { text: 'A multicast observable', correct: true },
            { text: 'A pipe' },
            { text: 'A directive' }
          ]
        },
        {
          questionText: 'Select all reactive operators',
          explanation: 'PRIVATE-EXPLANATION-MULTI',
          options: [
            { text: 'map', correct: true },
            { text: 'filter', correct: true },
            { text: 'ngIf' }
          ]
        }
      ]
    },
    {
      quizId: 'signals',
      milestone: 'Signals',
      summary: 'Signals basics',
      image: 'signals.svg',
      difficulty: 'beginner',
      questions: [
        {
          questionText: 'True or False: signals are reactive.',
          explanation: 'PRIVATE-EXPLANATION-TF',
          options: [{ text: 'True', correct: true }, { text: 'False' }]
        }
      ]
    }
  ],
  resources: []
};

export function fixtureRepository(): QuizRepository {
  return createQuizRepository({ source: FIXTURE_SOURCE });
}

/**
 * Stage 15 complete: `backend/data/quiz.json` (the real private bank) is gone.
 * Every caller that used to need "realistic scale" (Interview assessment-
 * building/allocation tests included) now uses this same synthetic bank —
 * it was grown specifically to cover that need (7 quizzes, 66 questions,
 * enough per-topic capacity for `questionCount: 30` requests spread across
 * 3 topics) rather than being replaced by a second parallel fixture.
 *
 * A larger (7-quiz, 66-question) synthetic bank covering single/multiple/
 * trueFalse questions, an "all of the above" option, facts, and a genuine
 * option-id collision across quizzes (any two quizzes share a question at
 * the same source index, so e.g. both `fixture-widgets` and `fixture-gadgets`
 * legitimately have an option id 401 — the id formula is scoped to a
 * question's position within ITS quiz, never global).
 */
export function syntheticBankRepository(): QuizRepository {
  return createQuizRepository({ dataPath: 'test/helpers/synthetic-quiz-bank.json' });
}

export function fixtureDependencies(): AppDependencies {
  return { quizRepository: fixtureRepository() };
}

/**
 * `INTERVIEW_PRESETS` (backend/src/interview/interview-presets.ts) hardcodes
 * a REAL, product-defined topic-id vocabulary — public structure (which
 * curriculum topics belong to which role preset), not secret bank content.
 * `preset-builder.test.ts` verifies the capacity/allocation ALGORITHM against
 * that exact vocabulary, so this fixture reuses the same id strings with
 * entirely FAKE synthetic question content (20 quizzes, 6 questions each,
 * difficulty-tagged to comfortably cover every preset's quota). Used ONLY by
 * that one test file — never imported anywhere, never touches PostgreSQL.
 */
export function presetTopicsRepository(): QuizRepository {
  return createQuizRepository({ dataPath: 'test/helpers/synthetic-preset-topics.json' });
}
