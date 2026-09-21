import {
  RAW_OPTIONS_SQL,
  RAW_QUESTIONS_SQL,
  RAW_QUIZZES_SQL,
  RETIRED_COUNT_SQL
} from '../../src/quiz/quality/bank-snapshot';
import type { SnapshotClient, SnapshotSource } from '../../src/quiz/quality/read-only-snapshot';
import { READ_ONLY_BEGIN, READ_ONLY_CHECK, ROLLBACK, STATEMENT_TIMEOUT } from '../../src/quiz/quality/read-only-snapshot';
import { deriveQuestionType } from '../../src/quiz/quiz.validation';

/**
 * A fake PostgreSQL for the validator's tests: it answers exactly the statements
 * the validator sends, from a declarative description of a bank, and records
 * every statement so tests can assert on what was (and was not) sent.
 *
 * It is deliberately strict: a statement it does not recognise throws, so a query
 * added to the validator without a matching fake fails the tests loudly.
 */

export interface FakeOption { text: string; correct: boolean; displayOrder: number }

export interface FakeQuestion {
  questionText: string;
  explanation: string;
  displayOrder: number;
  storedType: string;
  code: string | null;
  codeLanguage: string | null;
  codeFilename: string | null;
  options: FakeOption[];
}

export interface FakeQuiz {
  quizId: string;
  milestone: string;
  summary: string;
  image: string;
  difficulty: string | null;
  factsJson: string | null;
  displayOrder: number;
  status: 'active' | 'retired';
  questions: FakeQuestion[];
}

export interface FakeBank { quizzes: FakeQuiz[] }

export interface FakeConnection {
  readonly source: SnapshotSource;
  /** Every statement sent, in order. */
  readonly sql: string[];
  readonly released: () => number;
}

type Row = Record<string, unknown>;

function activeQuizzes(bank: FakeBank): FakeQuiz[] {
  return bank.quizzes
    .filter((quiz) => quiz.status === 'active')
    .sort((a, b) => a.displayOrder - b.displayOrder || (a.quizId < b.quizId ? -1 : 1));
}

const byOrder = <T extends { displayOrder: number }>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => a.displayOrder - b.displayOrder);

/** The rows the validator's own raw queries and the application's loader ask for. */
function answer(bank: FakeBank, sql: string): Row[] {
  const quizzes = activeQuizzes(bank);
  const norm = sql.replace(/\s+/g, ' ').trim();

  if (norm === RAW_QUIZZES_SQL.replace(/\s+/g, ' ').trim()) {
    return quizzes.map((q) => ({ quiz_id: q.quizId, display_order: q.displayOrder, facts_json: q.factsJson }));
  }
  if (norm === RETIRED_COUNT_SQL.replace(/\s+/g, ' ').trim()) {
    return [{ n: bank.quizzes.filter((q) => q.status === 'retired').length }];
  }
  if (norm === RAW_QUESTIONS_SQL.replace(/\s+/g, ' ').trim()) {
    return quizzes.flatMap((z) =>
      byOrder(z.questions).map((q) => ({
        quiz_id: z.quizId,
        display_order: q.displayOrder,
        question_type: q.storedType,
        has_code: q.code !== null,
        code_filename: q.codeFilename
      }))
    );
  }
  if (norm === RAW_OPTIONS_SQL.replace(/\s+/g, ' ').trim()) {
    return quizzes.flatMap((z) =>
      byOrder(z.questions).flatMap((q) =>
        byOrder(q.options).map((o) => ({ quiz_id: z.quizId, question_order: q.displayOrder, display_order: o.displayOrder }))
      )
    );
  }

  // The application's own loader (quiz.db-source.ts).
  if (norm.startsWith('SELECT quiz_id, milestone, summary, image, difficulty, facts_json')) {
    return quizzes.map((q) => ({
      quiz_id: q.quizId, milestone: q.milestone, summary: q.summary, image: q.image, difficulty: q.difficulty, facts_json: q.factsJson
    }));
  }
  if (norm.startsWith('SELECT z.quiz_id, q.question_text, q.explanation')) {
    return quizzes.flatMap((z) =>
      byOrder(z.questions).map((q) => ({
        quiz_id: z.quizId, question_text: q.questionText, explanation: q.explanation, display_order: q.displayOrder,
        code: q.code, code_language: q.codeLanguage, code_filename: q.codeFilename
      }))
    );
  }
  if (norm.startsWith('SELECT z.quiz_id, q.display_order AS question_order, o.option_text')) {
    return quizzes.flatMap((z) =>
      byOrder(z.questions).flatMap((q) =>
        byOrder(q.options).map((o) => ({
          quiz_id: z.quizId, question_order: q.displayOrder, option_text: o.text, is_correct: o.correct ? 1 : 0, display_order: o.displayOrder
        }))
      )
    );
  }

  throw new Error(`fake database: unrecognised statement: ${norm.slice(0, 80)}`);
}

export function fakeConnection(bank: FakeBank, over: { readOnlyState?: string } = {}): FakeConnection {
  const sql: string[] = [];
  let released = 0;

  const client: SnapshotClient = {
    async query(text: string) {
      sql.push(text);
      if (text === READ_ONLY_BEGIN || text === STATEMENT_TIMEOUT || text === ROLLBACK) return { rows: [], rowCount: 0 };
      if (text === READ_ONLY_CHECK) return { rows: [{ transaction_read_only: over.readOnlyState ?? 'on' }], rowCount: 1 };
      const rows = answer(bank, text);
      return { rows, rowCount: rows.length };
    },
    release() {
      released++;
    }
  };

  return { source: { connect: async () => client }, sql, released: () => released };
}

// ── builders ────────────────────────────────────────────────────────────────

/** A well-formed question: `correctIndexes` are the correct options; the stored type is the DERIVED one. */
export function fakeQuestion(
  questionText: string,
  optionTexts: readonly string[],
  correctIndexes: readonly number[],
  over: Partial<FakeQuestion> = {}
): FakeQuestion {
  return {
    questionText,
    explanation: 'Because.',
    displayOrder: 0,
    storedType: deriveQuestionType(optionTexts, correctIndexes.length),
    code: null,
    codeLanguage: null,
    codeFilename: null,
    options: optionTexts.map((text, i) => ({ text, correct: correctIndexes.includes(i), displayOrder: i })),
    ...over
  };
}

export function fakeQuiz(quizId: string, questions: FakeQuestion[], over: Partial<FakeQuiz> = {}): FakeQuiz {
  return {
    quizId,
    milestone: `Title ${quizId}`,
    summary: '',
    image: '',
    difficulty: 'beginner',
    factsJson: '[]',
    displayOrder: 0,
    status: 'active',
    // Give each question a contiguous display order unless the caller set one explicitly.
    questions: questions.map((q, i) => ({ ...q, displayOrder: q.displayOrder !== 0 || i === 0 ? q.displayOrder : i })),
    ...over
  };
}

interface FixtureQuestion {
  questionText: string;
  explanation: string;
  options: { text: string; correct?: boolean }[];
  codeSnippet?: { language: string; code: string; filename?: string };
}
interface FixtureQuiz {
  quizId: string; milestone: string; summary?: string; image?: string; difficulty?: string; facts?: string[];
  questions: FixtureQuestion[];
}

/** Builds a fake bank from the synthetic fixture file (the same one E2E and the parity suite seed). */
export function bankFromFixture(fixture: { quizzes: FixtureQuiz[] }): FakeBank {
  return {
    quizzes: fixture.quizzes.map((quiz, quizIndex) => ({
      quizId: quiz.quizId,
      milestone: quiz.milestone,
      summary: quiz.summary ?? '',
      image: quiz.image ?? '',
      difficulty: quiz.difficulty ?? null,
      factsJson: JSON.stringify(quiz.facts ?? []),
      displayOrder: quizIndex,
      status: 'active' as const,
      questions: quiz.questions.map((q, questionIndex) => {
        const texts = q.options.map((o) => o.text);
        const correct = q.options.map((o, i) => (o.correct ? i : -1)).filter((i) => i >= 0);
        return {
          questionText: q.questionText,
          explanation: q.explanation,
          displayOrder: questionIndex,
          storedType: deriveQuestionType(texts, correct.length),
          code: q.codeSnippet?.code ?? null,
          codeLanguage: q.codeSnippet?.language ?? null,
          codeFilename: q.codeSnippet?.filename ?? null,
          options: q.options.map((o, i) => ({ text: o.text, correct: o.correct === true, displayOrder: i }))
        };
      })
    }))
  };
}
