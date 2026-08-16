import type { Queryable } from '../db/database';
import { loadQuizBankFromDatabase, loadQuizResourcesFromDatabase } from './quiz.db-source';
import { readQuizDataFile, type LoadOptions } from './quiz.loader';
import { validateAndNormalize } from './quiz.validation';
import type {
  PrivateOption,
  PrivateQuestion,
  PrivateQuiz,
  QuizBankStats,
  QuizMetadata,
  QuizResource
} from './quiz.types';

/**
 * The ONLY module that reads the answer key.
 *
 * Built by a factory rather than a singleton so tests construct isolated
 * instances with fixtures and no global state leaks between them. The bank is
 * parsed and validated ONCE at construction; nothing rereads the file per
 * request.
 *
 * Everything returned is deeply frozen, so a consumer cannot mutate the master
 * bank — a shuffle or an answer-state reset in a later stage operates on its
 * own copies.
 */

export interface QuizRepository {
  readonly stats: QuizBankStats;
  getQuizMetadata(): readonly QuizMetadata[];
  getQuizById(quizId: string): PrivateQuiz | undefined;
  getQuestionById(questionId: string): PrivateQuestion | undefined;
  /**
   * Resolve an option WITHIN a question. The only supported lookup: option ids
   * are not globally unique, so an option must never be resolved on its own.
   */
  getOptionForQuestion(questionId: string, optionId: number): PrivateOption | undefined;
  getEligibleQuestions(filter?: EligibilityFilter): readonly PrivateQuestion[];
  /**
   * The Results-page links for a quiz, in display order.
   *
   * Always an array. An unknown quiz and a quiz with no links both answer
   * empty here — the caller distinguishes them with `getQuizById`, exactly as
   * the questions route does, so this method needs no not-found signal of its
   * own.
   */
  getResourcesForQuiz(quizId: string): readonly QuizResource[];
}

export interface EligibilityFilter {
  /** Source quiz ids to draw from. Omitted/empty means every topic. */
  readonly topicIds?: readonly string[];
  /** 'mixed' (or omitted) means every difficulty. */
  readonly difficulty?: string | null;
}

export interface RepositoryOptions extends LoadOptions {
  /** Path to the private file. Ignored when `source` is supplied. */
  readonly dataPath?: string;
  /** Pre-parsed data for tests, so no file is touched. */
  readonly source?: unknown;
  /**
   * Results-page links, grouped by quiz id. Omitted means none — a repository
   * built without them serves empty resource lists rather than failing, which
   * is what keeps every existing construction site working unchanged.
   */
  readonly resources?: ReadonlyMap<string, readonly QuizResource[]>;
}

/** Recursive freeze — the bank must be immutable after load. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/**
 * Build the repository from PostgreSQL — the authoritative source.
 *
 * There is deliberately NO fallback to `data/quiz.json`: if the database has no
 * bank, this throws and the server refuses to start, rather than quietly
 * serving a stale file that is not supposed to exist in production.
 *
 * The bank is read ONCE at startup and held frozen in memory, exactly as the
 * file loader did. That keeps every consumer — the assessment builder, the
 * session service, the routes — synchronous and unchanged.
 */
export async function createQuizRepositoryFromDatabase(db: Queryable): Promise<QuizRepository> {
  const source = await loadQuizBankFromDatabase(db);
  // Loaded from the same database, in the same startup pass. There is no file
  // fallback for these either: an unreadable resources table means no links,
  // never a read of `data/quiz.json`.
  const resources = await loadQuizResourcesFromDatabase(db);
  return createQuizRepository({ source, resources });
}

export function createQuizRepository(options: RepositoryOptions = {}): QuizRepository {
  const raw =
    options.source !== undefined
      ? options.source
      : readQuizDataFile(options.dataPath ?? './data/quiz.json', options);

  // Throws QuizDataError on any problem — an invalid bank must not start.
  const { quizzes } = validateAndNormalize(raw);
  const frozenQuizzes = deepFreeze(quizzes) as readonly PrivateQuiz[];

  const quizById = new Map<string, PrivateQuiz>();
  const questionById = new Map<string, PrivateQuestion>();
  const allQuestions: PrivateQuestion[] = [];
  let optionCount = 0;

  for (const quiz of frozenQuizzes) {
    quizById.set(quiz.quizId, quiz);
    for (const question of quiz.questions) {
      questionById.set(question.questionId, question);
      allQuestions.push(question);
      optionCount += question.options.length;
    }
  }

  const metadata: readonly QuizMetadata[] = deepFreeze(
    frozenQuizzes.map((quiz) => ({
      quizId: quiz.quizId,
      milestone: quiz.milestone,
      summary: quiz.summary,
      image: quiz.image,
      difficulty: quiz.difficulty,
      questionCount: quiz.questions.length
    }))
  );

  const stats: QuizBankStats = deepFreeze({
    quizCount: frozenQuizzes.length,
    questionCount: allQuestions.length,
    optionCount
  });

  const frozenAll = deepFreeze(allQuestions) as readonly PrivateQuestion[];

  // Frozen like the rest of the bank, so a route handler cannot mutate the
  // shared list it hands out.
  const NO_RESOURCES = deepFreeze([]) as readonly QuizResource[];
  const resourcesByQuiz = new Map<string, readonly QuizResource[]>();
  for (const [quizId, list] of options.resources ?? []) {
    resourcesByQuiz.set(quizId, deepFreeze([...list]) as readonly QuizResource[]);
  }

  return {
    stats,

    getQuizMetadata: () => metadata,

    getQuizById: (quizId) => quizById.get(quizId),

    getQuestionById: (questionId) => questionById.get(questionId),

    getResourcesForQuiz: (quizId) => resourcesByQuiz.get(quizId) ?? NO_RESOURCES,

    getOptionForQuestion(questionId, optionId) {
      const question = questionById.get(questionId);
      if (!question) return undefined;
      return question.options.find((option) => option.optionId === optionId);
    },

    getEligibleQuestions(filter: EligibilityFilter = {}) {
      const topicIds = filter.topicIds;
      const difficulty = filter.difficulty;
      const wantAllTopics = !topicIds || topicIds.length === 0;
      const wantAllDifficulties =
        difficulty === undefined || difficulty === null || difficulty === 'mixed';

      if (wantAllTopics && wantAllDifficulties) return frozenAll;

      const topics = wantAllTopics ? null : new Set(topicIds);

      return frozenAll.filter((question) => {
        if (topics && !topics.has(question.sourceQuizId)) return false;
        if (wantAllDifficulties) return true;
        return quizById.get(question.sourceQuizId)?.difficulty === difficulty;
      });
    }
  };
}

/**
 * Startup summary. Counts ONLY — never questions, options, correctness or
 * explanations, so a log file can never become an answer key.
 */
export function describeBank(stats: QuizBankStats): string {
  return `Loaded ${stats.quizCount} quizzes, ${stats.questionCount} questions, ${stats.optionCount} options`;
}
