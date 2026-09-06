import { fromPool, type DatabaseHandle } from '../src/db/database';
import { migrate } from '../src/db/migrate';
import { loadQuizBankFromDatabase, QuizBankSourceError } from '../src/quiz/quiz.db-source';
import {
  createQuizRepository,
  createQuizRepositoryFromDatabase
} from '../src/quiz/quiz.repository';
import { createTestPool } from './helpers/pg-mem-pool';

/**
 * PostgreSQL as the authoritative quiz bank.
 *
 * The property that matters most: a repository built FROM THE DATABASE must be
 * indistinguishable from one built from the JSON file. Interview Mode derives
 * its question and option ids from source position, and those ids appear in its
 * public API — so any drift here would silently change a shipped contract.
 *
 * These tests use a small fixture rather than the real bank, so they assert the
 * MECHANISM. Equivalence against the real 186-question bank is verified
 * separately against real PostgreSQL.
 */

const CLOCK = () => 1_700_000_000_000;

/** Mirrors the real file's conventions: no ids, no `type`, no `correct:false`. */
const FIXTURE = {
  quizzes: [
    {
      quizId: 'rxjs',
      milestone: 'RxJS Basics',
      summary: 'Streams and operators',
      image: 'assets/img/rxjs.png',
      difficulty: 'beginner',
      facts: ['Fact one', 'Fact two'],
      questions: [
        {
          questionText: 'What is a Subject?',
          explanation: 'Because a Subject multicasts.',
          options: [
            { text: 'A multicast observable', correct: true },
            { text: 'A pipe' }
          ]
        },
        {
          questionText: 'Select every operator',
          explanation: 'map and filter are operators.',
          options: [
            { text: 'map', correct: true },
            { text: 'filter', correct: true },
            { text: 'Observable' }
          ]
        }
      ]
    },
    {
      quizId: 'signals',
      milestone: 'Signals',
      summary: 'Reactive primitives',
      image: 'assets/img/signals.png',
      difficulty: 'intermediate',
      facts: [],
      questions: [
        {
          questionText: 'Is a signal synchronous?',
          explanation: 'Reading a signal is synchronous.',
          options: [{ text: 'True', correct: true }, { text: 'False' }]
        }
      ]
    }
  ]
};

async function migratedDb(): Promise<DatabaseHandle> {
  const db = fromPool(createTestPool().pool, 'pg-mem');
  await migrate(db, { now: CLOCK });
  return db;
}

/** Write the fixture using the same column semantics as the import script. */
async function seed(db: DatabaseHandle, source = FIXTURE): Promise<void> {
  for (const [quizIndex, quiz] of source.quizzes.entries()) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO quizzes (quiz_id, milestone, summary, image, difficulty, facts_json, display_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [quiz.quizId, quiz.milestone, quiz.summary, quiz.image, quiz.difficulty,
       JSON.stringify(quiz.facts), quizIndex]
    );
    const quizPk = Number(rows[0]!['id']);

    for (const [questionIndex, question] of quiz.questions.entries()) {
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO questions
           (quiz_pk, question_text, question_type, explanation, display_order)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [
          quizPk,
          question.questionText,
          question.options.filter((o) => 'correct' in o).length > 1 ? 'multiple' : 'single',
          question.explanation,
          questionIndex
        ]
      );
      const questionPk = Number(inserted.rows[0]!['id']);

      for (const [optionIndex, option] of question.options.entries()) {
        await db.query(
          `INSERT INTO options (question_pk, option_text, display_order, is_correct)
           VALUES ($1, $2, $3, $4)`,
          [questionPk, option.text, optionIndex, 'correct' in option ? 1 : 0]
        );
      }
    }
  }
}

describe('the database source reproduces the file source shape', () => {
  it('marks correct options with `correct: true` and OMITS the key otherwise', async () => {
    const db = await migratedDb();
    await seed(db);

    const source = await loadQuizBankFromDatabase(db);
    const quizzes = source.quizzes as readonly { questions: readonly { options: readonly object[] }[] }[];
    const options = quizzes[0]!.questions[0]!.options;

    // The file has no `correct: false` — absence means incorrect. Reproducing
    // that exactly is what lets the SAME validation run over both sources.
    expect(options[0]).toEqual({ text: 'A multicast observable', correct: true });
    expect(options[1]).toEqual({ text: 'A pipe' });
    expect('correct' in options[1]!).toBe(false);
  });

  it('preserves quiz, question and option ORDER', async () => {
    const db = await migratedDb();
    await seed(db);

    const source = await loadQuizBankFromDatabase(db);
    const quizzes = source.quizzes as readonly {
      quizId: string;
      questions: readonly { questionText: string; options: readonly { text: string }[] }[];
    }[];

    expect(quizzes.map((q) => q.quizId)).toEqual(['rxjs', 'signals']);
    expect(quizzes[0]!.questions.map((q) => q.questionText))
      .toEqual(['What is a Subject?', 'Select every operator']);
    expect(quizzes[0]!.questions[1]!.options.map((o) => o.text))
      .toEqual(['map', 'filter', 'Observable']);
  });

  it('carries quiz metadata including facts', async () => {
    const db = await migratedDb();
    await seed(db);

    const [rxjs] = (await loadQuizBankFromDatabase(db)).quizzes as readonly {
      milestone: string; summary: string; image: string; difficulty: string; facts: readonly string[];
    }[];

    expect(rxjs!.milestone).toBe('RxJS Basics');
    expect(rxjs!.summary).toBe('Streams and operators');
    expect(rxjs!.image).toBe('assets/img/rxjs.png');
    expect(rxjs!.difficulty).toBe('beginner');
    expect(rxjs!.facts).toEqual(['Fact one', 'Fact two']);
  });
});

describe('a database-backed repository equals a file-backed one', () => {
  it('produces IDENTICAL questions, ids and answer key', async () => {
    const db = await migratedDb();
    await seed(db);

    const fromFile = createQuizRepository({ source: FIXTURE });
    const fromDatabase = await createQuizRepositoryFromDatabase(db);

    expect(fromDatabase.stats).toEqual(fromFile.stats);
    expect(fromDatabase.getQuizMetadata()).toEqual(fromFile.getQuizMetadata());

    // Interview Mode publishes these ids. Drift here would change a shipped
    // API contract without any code in Interview Mode changing.
    const fileQuestions = fromFile.getEligibleQuestions();
    const dbQuestions = fromDatabase.getEligibleQuestions();
    expect(dbQuestions.map((q) => q.questionId)).toEqual(fileQuestions.map((q) => q.questionId));
    expect(dbQuestions).toEqual(fileQuestions);
  });

  it('derives question TYPE identically, including trueFalse', async () => {
    const db = await migratedDb();
    await seed(db);
    const fromDatabase = await createQuizRepositoryFromDatabase(db);

    const byId = new Map(fromDatabase.getEligibleQuestions().map((q) => [q.questionId, q]));
    expect(byId.get('rxjs:q:0')!.type).toBe('single');
    expect(byId.get('rxjs:q:1')!.type).toBe('multiple');
    // True/False is derived from the OPTION TEXTS, not stored in the source —
    // so it must survive the database round trip too.
    expect(byId.get('signals:q:0')!.type).toBe('trueFalse');
  });

  it('resolves an option only within its own question', async () => {
    const db = await migratedDb();
    await seed(db);
    const repo = await createQuizRepositoryFromDatabase(db);

    // Legacy ids follow (qIdx + 1) * 100 + (oIdx + 1) with BOTH indexes
    // zero-based, so qIdx 0 (the FIRST question) owns 101/102 and qIdx 1 (the
    // SECOND question) owns 201/202/203.
    const option = repo.getOptionForQuestion('rxjs:q:0', 101);
    expect(option?.text).toBe('A multicast observable');
    expect(option?.isCorrect).toBe(true);
    expect(repo.getOptionForQuestion('rxjs:q:1', 201)?.text).toBe('map');

    // An id belonging to a DIFFERENT question must not resolve — option
    // identity is scoped to its question, never global.
    expect(repo.getOptionForQuestion('rxjs:q:1', 101)).toBeUndefined();

    // The same id on a different quiz's question is a legitimate collision.
    expect(repo.getOptionForQuestion('signals:q:0', 101)?.text).toBe('True');
  });

  /**
   * The zero-based mapping, pinned explicitly.
   *
   * These values are LEGACY PROVENANCE and compatibility data. They are not
   * PostgreSQL primary keys, not relational identity, and they are NOT part of
   * the new text-based Topic Quiz contract. This test exists so the formula and
   * its zero-based indexing cannot drift unnoticed — not to promote the ids to
   * public identity.
   */
  it('maps ZERO-BASED qIdx/oIdx to legacy option ids: (qIdx+1)*100 + (oIdx+1)', async () => {
    const db = await migratedDb();
    await seed(db);
    const repo = await createQuizRepositoryFromDatabase(db);

    const questions = repo.getEligibleQuestions().filter((q) => q.sourceQuizId === 'rxjs');

    // qIdx 0 — the FIRST question, two options.
    expect(questions[0]!.sourceQuestionIndex).toBe(0);
    expect(questions[0]!.options.map((o) => o.optionId)).toEqual([101, 102]);

    // qIdx 1 — the SECOND question, three options.
    expect(questions[1]!.sourceQuestionIndex).toBe(1);
    expect(questions[1]!.options.map((o) => o.optionId)).toEqual([201, 202, 203]);

    // The formula, restated independently of the data.
    for (const question of repo.getEligibleQuestions()) {
      const qIdx = question.sourceQuestionIndex;
      question.options.forEach((option, oIdx) => {
        expect(option.sourceOptionIndex).toBe(oIdx);
        expect(option.optionId).toBe((qIdx + 1) * 100 + (oIdx + 1));
      });
    }
  });

  it('keeps legacy ids OUT of relational identity', async () => {
    const db = await migratedDb();
    await seed(db);

    // Stored only as provenance columns; PostgreSQL identity is its own
    // GENERATED surrogate key, and nothing joins on the legacy values.
    const { rows } = await db.query<{ id: string; legacy_option_id: number | null }>(
      'SELECT id, legacy_option_id FROM options ORDER BY id LIMIT 1'
    );
    expect(Number(rows[0]!['id'])).toBeGreaterThan(0);
    // The surrogate id is unrelated to the legacy value.
    expect(Number(rows[0]!['id'])).not.toBe(101);
  });

  it('filters eligible questions by topic and quiz difficulty', async () => {
    const db = await migratedDb();
    await seed(db);
    const repo = await createQuizRepositoryFromDatabase(db);

    expect(repo.getEligibleQuestions({ topicIds: ['signals'] }).map((q) => q.questionId))
      .toEqual(['signals:q:0']);
    expect(repo.getEligibleQuestions({ difficulty: 'beginner' }).map((q) => q.sourceQuizId))
      .toEqual(['rxjs', 'rxjs']);
    expect(repo.getEligibleQuestions({ difficulty: 'mixed' })).toHaveLength(3);
  });
});

describe('fail closed', () => {
  it('REFUSES an empty bank rather than serving zero quizzes', async () => {
    const db = await migratedDb();   // migrated, but never imported

    await expect(loadQuizBankFromDatabase(db)).rejects.toThrow(QuizBankSourceError);
    await expect(loadQuizBankFromDatabase(db)).rejects.toThrow(/run the quiz-bank import/i);
    await expect(createQuizRepositoryFromDatabase(db)).rejects.toThrow(QuizBankSourceError);
  });

  it('does NOT fall back to the JSON file when the database is empty', async () => {
    const db = await migratedDb();

    // A fallback would make a misconfigured server look healthy while serving
    // a stale bank from a file that must not exist in production.
    await expect(createQuizRepositoryFromDatabase(db)).rejects.toBeDefined();
  });

  it('ignores retired quizzes', async () => {
    const db = await migratedDb();
    await seed(db);
    await db.query(`UPDATE quizzes SET status = 'retired' WHERE quiz_id = 'signals'`);

    const repo = await createQuizRepositoryFromDatabase(db);
    expect(repo.getQuizMetadata().map((q) => q.quizId)).toEqual(['rxjs']);
    expect(repo.getQuizById('signals')).toBeUndefined();
  });
});
