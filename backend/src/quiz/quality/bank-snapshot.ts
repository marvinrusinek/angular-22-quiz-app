/**
 * Reads ONE coherent snapshot of the quiz bank for validation.
 *
 * It produces the two inputs the validator needs from a single read-only
 * transaction (see `read-only-snapshot.ts`), so the bank cannot change between
 * them:
 *
 *   `source`  what the APPLICATION would load — the existing
 *             `loadQuizBankFromDatabase`, reused unchanged. This is what
 *             `validateAndNormalize` then turns into `PrivateQuiz` /
 *             `PrivateQuestion`. Using the application's own loader means the
 *             validator judges exactly what the server would judge.
 *
 *   `raw`     the few columns that loader DROPS or silently repairs (stored
 *             question type, quiz display order, facts_json, filename-without-code,
 *             display-order values). The queries below select ONLY those.
 *
 * SCOPE. Quiz-bank content only. No interview, session, attempt or history table
 * is touched, and the raw queries never select question text, option text,
 * explanations or the `is_correct` column — that is how the rule layer is kept
 * incapable of leaking them. (The application's loader does read them, because it
 * must build `PrivateQuestion`; they stay in memory and are never reported.)
 *
 * Only ACTIVE quizzes are read: the application does not serve retired ones.
 *
 * Every statement is a constant SELECT, so `assertSelectOnly` accepts them and a
 * test proves it.
 */

import type { Queryable } from '../../db/database';
import { loadQuizBankFromDatabase } from '../quiz.db-source';
import type { QuizBankSource } from '../quiz.types';
import type {
  RawBankSnapshot,
  RawOptionRow,
  RawQuestionRow,
  RawQuizRow
} from './raw-rules';

export const RAW_QUIZZES_SQL = `
  SELECT quiz_id, display_order, facts_json
    FROM quizzes
   WHERE status = 'active'
   ORDER BY display_order, quiz_id`;

export const RETIRED_COUNT_SQL = `
  SELECT COUNT(*)::int AS n
    FROM quizzes
   WHERE status = 'retired'`;

export const RAW_QUESTIONS_SQL = `
  SELECT z.quiz_id, q.display_order, q.question_type,
         (q.code IS NOT NULL) AS has_code, q.code_filename
    FROM questions q
    JOIN quizzes z ON z.id = q.quiz_pk
   WHERE z.status = 'active'
   ORDER BY z.display_order, z.quiz_id, q.display_order`;

export const RAW_OPTIONS_SQL = `
  SELECT z.quiz_id, q.display_order AS question_order, o.display_order
    FROM options o
    JOIN questions q ON q.id = o.question_pk
    JOIN quizzes z ON z.id = q.quiz_pk
   WHERE z.status = 'active'
   ORDER BY z.display_order, z.quiz_id, q.display_order, o.display_order`;

/** Every statement this module sends itself (the loader's own are tested separately). */
export const RAW_STATEMENTS: readonly string[] = [
  RAW_QUIZZES_SQL,
  RETIRED_COUNT_SQL,
  RAW_QUESTIONS_SQL,
  RAW_OPTIONS_SQL
];

interface QuizRow { readonly quiz_id: string; readonly display_order: number; readonly facts_json: string | null }
interface CountRow { readonly n: number }
interface QuestionRow {
  readonly quiz_id: string;
  readonly display_order: number;
  readonly question_type: string;
  readonly has_code: boolean;
  readonly code_filename: string | null;
}
interface OptionRow { readonly quiz_id: string; readonly question_order: number; readonly display_order: number }

export interface BankSnapshot {
  readonly source: QuizBankSource;
  readonly raw: RawBankSnapshot;
}

/** Maps rows to the raw model. Pure, and exported so it can be tested without a database. */
export function mapRawRows(
  quizRows: readonly QuizRow[],
  retired: number,
  questionRows: readonly QuestionRow[],
  optionRows: readonly OptionRow[]
): RawBankSnapshot {
  const quizzes: RawQuizRow[] = quizRows.map((row) => ({
    quizId: row.quiz_id,
    displayOrder: Number(row.display_order),
    factsJson: row.facts_json
  }));

  const questions: RawQuestionRow[] = questionRows.map((row) => ({
    quizId: row.quiz_id,
    displayOrder: Number(row.display_order),
    storedType: row.question_type,
    hasCode: row.has_code === true,
    codeFilename: row.code_filename
  }));

  // A question's RANK within its quiz is its identity in the application, so option rows
  // (which carry the question's display_order VALUE) are re-keyed by that rank.
  const rankByQuestion = new Map<string, number>();
  const seenPerQuiz = new Map<string, number>();
  for (const row of questionRows) {
    const rank = seenPerQuiz.get(row.quiz_id) ?? 0;
    rankByQuestion.set(`${row.quiz_id}\u0000${Number(row.display_order)}`, rank);
    seenPerQuiz.set(row.quiz_id, rank + 1);
  }

  const options: RawOptionRow[] = optionRows.map((row) => {
    const questionIndex = rankByQuestion.get(`${row.quiz_id}\u0000${Number(row.question_order)}`);
    if (questionIndex === undefined) {
      throw new Error(`an option row references a question of quiz "${row.quiz_id}" that the snapshot does not contain`);
    }
    return { quizId: row.quiz_id, questionIndex, displayOrder: Number(row.display_order) };
  });

  return { quizzes, questions, options, retiredQuizCount: Number(retired) };
}

/**
 * Reads the whole snapshot. Call it INSIDE `withReadOnlySnapshot` — the Queryable
 * it is given is the read-only one.
 */
export async function readBankSnapshot(db: Queryable): Promise<BankSnapshot> {
  const quizzes = await db.query<QuizRow>(RAW_QUIZZES_SQL);
  const retired = await db.query<CountRow>(RETIRED_COUNT_SQL);
  const questions = await db.query<QuestionRow>(RAW_QUESTIONS_SQL);
  const options = await db.query<OptionRow>(RAW_OPTIONS_SQL);

  const raw = mapRawRows(quizzes.rows, Number(retired.rows[0]?.n ?? 0), questions.rows, options.rows);

  // The application's loader refuses an empty bank by throwing. For the validator that is a
  // FINDING (EMPTY_BANK), not a crash, so it is simply not asked to load nothing.
  const source: QuizBankSource =
    raw.quizzes.length === 0 ? { quizzes: [] } : await loadQuizBankFromDatabase(db);

  return { source, raw };
}
