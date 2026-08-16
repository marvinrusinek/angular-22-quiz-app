import { fromPool, type DatabaseHandle } from '../src/db/database';
import { migrate } from '../src/db/migrate';
import { createTestPool } from './helpers/pg-mem-pool';

/**
 * The quiz-bank schema (migration 002).
 *
 * PostgreSQL is becoming the authoritative source for questions, options,
 * explanations and the answer key. Two properties matter most and are asserted
 * here rather than assumed:
 *
 *   1. The PUBLIC contract is `quiz_id` + exact text. Question and option text
 *      must be unique within their scope, so a text lookup can never be
 *      ambiguous. An audit proved that holds for today's bank; these tests
 *      prove the DATABASE now enforces it for every future edit.
 *   2. Internal surrogate ids exist for integrity only and must never become
 *      public identity.
 */

const CLOCK = () => 1_700_000_000_000;

async function migratedDb(): Promise<DatabaseHandle> {
  const db = fromPool(createTestPool().pool, 'pg-mem');
  await migrate(db, { now: CLOCK });
  return db;
}

/** Insert a quiz and return its INTERNAL primary key. */
async function insertQuiz(db: DatabaseHandle, quizId = 'rxjs'): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO quizzes (quiz_id, milestone, difficulty, display_order)
     VALUES ($1, $2, 'beginner', 0) RETURNING id`,
    [quizId, `${quizId} milestone`]
  );
  return Number(rows[0]!['id']);
}

async function insertQuestion(
  db: DatabaseHandle,
  quizPk: number,
  text: string,
  displayOrder = 0
): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO questions
       (quiz_pk, question_text, question_type, explanation, display_order)
     VALUES ($1, $2, 'single', 'Because.', $3) RETURNING id`,
    [quizPk, text, displayOrder]
  );
  return Number(rows[0]!['id']);
}

function insertOption(
  db: DatabaseHandle,
  questionPk: number,
  text: string,
  displayOrder = 0,
  isCorrect = 0
) {
  return db.query(
    `INSERT INTO options (question_pk, option_text, display_order, is_correct)
     VALUES ($1, $2, $3, $4)`,
    [questionPk, text, displayOrder, isCorrect]
  );
}

describe('migration 002 applies alongside 001', () => {
  it('creates every quiz-bank table without disturbing the session tables', async () => {
    const db = await migratedDb();

    for (const table of [
      'quizzes', 'questions', 'options',              // 002
      'interview_sessions', 'session_questions'       // 001 still intact
    ]) {
      const { rows } = await db.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM ${table}`
      );
      expect(Number(rows[0]!['n'])).toBe(0);
    }
  });

  it('is idempotent — a second run applies nothing', async () => {
    const db = fromPool(createTestPool().pool, 'pg-mem');
    expect(await migrate(db, { now: CLOCK })).toEqual([1, 2, 3]);
    expect(await migrate(db, { now: CLOCK })).toEqual([]);
  });
});

describe('text uniqueness is enforced BY THE DATABASE', () => {
  it('rejects a duplicate question text within the same quiz', async () => {
    const db = await migratedDb();
    const quiz = await insertQuiz(db);
    await insertQuestion(db, quiz, 'What is a Subject?', 0);

    await expect(insertQuestion(db, quiz, 'What is a Subject?', 1)).rejects.toBeDefined();
  });

  it('rejects text differing only by CASE or WHITESPACE', async () => {
    const db = await migratedDb();
    const quiz = await insertQuiz(db);
    await insertQuestion(db, quiz, 'What is a Subject?', 0);

    // The normalized key is case-insensitive and whitespace-collapsed, so all
    // of these would be ambiguous for a text lookup and must be refused.
    await expect(insertQuestion(db, quiz, 'what is a subject?', 1)).rejects.toBeDefined();
    await expect(insertQuestion(db, quiz, '  What is a Subject?  ', 2)).rejects.toBeDefined();
    await expect(insertQuestion(db, quiz, 'What  is  a  Subject?', 3)).rejects.toBeDefined();
  });

  it('ALLOWS the same question text in a DIFFERENT quiz', async () => {
    const db = await migratedDb();
    const rxjs = await insertQuiz(db, 'rxjs');
    const signals = await insertQuiz(db, 'signals');

    await insertQuestion(db, rxjs, 'Which statement is true?', 0);
    // Uniqueness is scoped to the quiz, because the public contract is
    // (quizId, questionText) — never questionText alone.
    await expect(insertQuestion(db, signals, 'Which statement is true?', 0))
      .resolves.toBeDefined();
  });

  it('rejects duplicate option text within one question', async () => {
    const db = await migratedDb();
    const quiz = await insertQuiz(db);
    const question = await insertQuestion(db, quiz, 'Pick one', 0);

    await insertOption(db, question, 'A multicast observable', 0, 1);
    await expect(insertOption(db, question, 'A multicast observable', 1, 0))
      .rejects.toBeDefined();
    await expect(insertOption(db, question, 'a MULTICAST observable', 2, 0))
      .rejects.toBeDefined();
  });

  it('ALLOWS the same option text on a DIFFERENT question', async () => {
    const db = await migratedDb();
    const quiz = await insertQuiz(db);
    const first = await insertQuestion(db, quiz, 'Question one', 0);
    const second = await insertQuestion(db, quiz, 'Question two', 1);

    await insertOption(db, first, 'True', 0, 1);
    // 'True' legitimately appears on many questions — uniqueness is scoped to
    // the question, matching how /check resolves an option.
    await expect(insertOption(db, second, 'True', 0, 1)).resolves.toBeDefined();
  });

  it('keeps display order unambiguous within a scope', async () => {
    const db = await migratedDb();
    const quiz = await insertQuiz(db);
    await insertQuestion(db, quiz, 'First', 0);
    await expect(insertQuestion(db, quiz, 'Second', 0)).rejects.toBeDefined();

    const question = await insertQuestion(db, quiz, 'Third', 1);
    await insertOption(db, question, 'A', 0, 1);
    await expect(insertOption(db, question, 'B', 0, 0)).rejects.toBeDefined();
  });
});

describe('the normalized key column', () => {
  it('is derived from the text and cannot be set directly', async () => {
    const db = await migratedDb();
    const quiz = await insertQuiz(db);
    await insertQuestion(db, quiz, '  Which   Answer Is   CORRECT?  ', 0);

    const { rows } = await db.query<{ question_key: string; question_text: string }>(
      'SELECT question_key, question_text FROM questions'
    );
    // Stored text is preserved EXACTLY — the client round-trips this string.
    expect(rows[0]!['question_text']).toBe('  Which   Answer Is   CORRECT?  ');
    // The key is normalized for lookup only.
    expect(rows[0]!['question_key']).toBe('which answer is correct?');
  });

  it('follows the text when the text is updated', async () => {
    const db = await migratedDb();
    const quiz = await insertQuiz(db);
    const question = await insertQuestion(db, quiz, 'Original text', 0);

    await db.query('UPDATE questions SET question_text = $1 WHERE id = $2', ['Revised TEXT', question]);

    const { rows } = await db.query<{ question_key: string }>(
      'SELECT question_key FROM questions WHERE id = $1',
      [question]
    );
    // GENERATED ALWAYS means the key can never drift from what it indexes.
    expect(rows[0]!['question_key']).toBe('revised text');
  });
});

describe('relational integrity', () => {
  /**
   * CASCADE delete is NOT asserted here.
   *
   * pg-mem cannot execute a DELETE that cascades into a table carrying a
   * GENERATED column — it fails with `Column "option_key" is a generated
   * column`. That is a limitation of the test double, not of the schema:
   * verified working on real PostgreSQL 18.4, where deleting a quiz removes
   * its questions and options.
   *
   * Asserted below only when TEST_DATABASE_URL points at a real server, so the
   * property is covered rather than quietly dropped.
   */
  const realDatabaseUrl = (process.env['TEST_DATABASE_URL'] ?? '').trim();
  const describeReal = realDatabaseUrl.length > 0 ? describe : describe.skip;

  describeReal('against real PostgreSQL (TEST_DATABASE_URL)', () => {
    it('CASCADES delete from quiz to questions to options', async () => {
      const { openDatabase } = await import('../src/db/database');
      const db = openDatabase({ databaseUrl: realDatabaseUrl });
      try {
        await migrate(db, { now: CLOCK });
        const quiz = await insertQuiz(db, `cascade_${Date.now()}`);
        const question = await insertQuestion(db, quiz, `Doomed ${Date.now()}`, 0);
        await insertOption(db, question, 'A', 0, 1);

        await db.query('DELETE FROM quizzes WHERE id = $1', [quiz]);

        const { rows } = await db.query<{ n: number }>(
          'SELECT COUNT(*)::int AS n FROM questions WHERE id = $1',
          [question]
        );
        expect(Number(rows[0]!['n'])).toBe(0);
      } finally {
        await db.close();
      }
    });
  });

  it('REJECTS an orphan question and an orphan option', async () => {
    const db = await migratedDb();
    await expect(insertQuestion(db, 99_999, 'Ghost', 0)).rejects.toBeDefined();

    const quiz = await insertQuiz(db);
    await insertQuestion(db, quiz, 'Real', 0);
    await expect(insertOption(db, 99_999, 'Ghost option', 0, 1)).rejects.toBeDefined();
  });

  it('rejects a duplicate public quiz_id', async () => {
    const db = await migratedDb();
    await insertQuiz(db, 'rxjs');
    await expect(insertQuiz(db, 'rxjs')).rejects.toBeDefined();
  });

  it('constrains question type, quiz difficulty and correctness', async () => {
    const db = await migratedDb();
    const quiz = await insertQuiz(db);

    await expect(db.query(
      `INSERT INTO questions (quiz_pk, question_text, question_type, explanation, display_order)
       VALUES ($1, 'Bad type', 'essay', 'why', 0)`, [quiz]
    )).rejects.toBeDefined();

    // Difficulty is a QUIZ-level property — the assessment builder filters
    // questions by their quiz's difficulty, not a per-question value.
    await expect(db.query(
      `INSERT INTO quizzes (quiz_id, milestone, difficulty, display_order)
       VALUES ('bad', 'Bad difficulty', 'expert', 1)`
    )).rejects.toBeDefined();

    const question = await insertQuestion(db, quiz, 'Fine', 2);
    await expect(insertOption(db, question, 'Bad correctness', 0, 7)).rejects.toBeDefined();
  });

  it('allows a quiz with no difficulty — the private model types it nullable', async () => {
    const db = await migratedDb();
    await expect(db.query(
      `INSERT INTO quizzes (quiz_id, milestone, display_order) VALUES ('nodiff', 'No difficulty', 0)`
    )).resolves.toBeDefined();
  });

  it('rejects blank text in every text column', async () => {
    const db = await migratedDb();
    const quiz = await insertQuiz(db);

    await expect(insertQuestion(db, quiz, '   ', 0)).rejects.toBeDefined();
    const question = await insertQuestion(db, quiz, 'Fine', 1);
    await expect(insertOption(db, question, '  ', 0, 1)).rejects.toBeDefined();
  });
});

describe('internal ids stay internal', () => {
  it('surrogate keys are generated, not supplied', async () => {
    const db = await migratedDb();
    const quiz = await insertQuiz(db);
    const question = await insertQuestion(db, quiz, 'Generated', 0);

    // GENERATED ALWAYS AS IDENTITY: a caller cannot choose an id, which is what
    // keeps these values meaningless outside the database.
    expect(Number.isFinite(quiz)).toBe(true);
    expect(Number.isFinite(question)).toBe(true);
    await expect(db.query('INSERT INTO quizzes (id, quiz_id, title, display_order) VALUES (1, $1, $2, 0)',
      ['forced', 'Forced id'])).rejects.toBeDefined();
  });

  it('records legacy positional identifiers as provenance only', async () => {
    const db = await migratedDb();
    const quiz = await insertQuiz(db);

    // The old scheme's values are storable for diagnosis, but nothing reads
    // them for lookup and no constraint depends on them.
    await db.query(
      `INSERT INTO questions
         (quiz_pk, question_text, question_type, explanation, display_order, legacy_question_id)
       VALUES ($1, 'Has provenance', 'single', 'why', 0, $2)`,
      [quiz, 'rxjs:q:0']
    );

    const { rows } = await db.query<{ legacy_question_id: string }>(
      'SELECT legacy_question_id FROM questions'
    );
    expect(rows[0]!['legacy_question_id']).toBe('rxjs:q:0');

    // Deliberately NOT unique: two quizzes' legacy ids could collide after a
    // future edit, and that must never break an insert.
    await db.query(
      `INSERT INTO questions
         (quiz_pk, question_text, question_type, explanation, display_order, legacy_question_id)
       VALUES ($1, 'Also has provenance', 'single', 'why', 1, $2)`,
      [quiz, 'rxjs:q:0']
    );
    const { rows: after } = await db.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM questions'
    );
    expect(Number(after[0]!['n'])).toBe(2);
  });
});

/**
 * Migration 003 — the Results-page resource links.
 *
 * The last part of the bank with no source outside `data/quiz.json`. Nothing
 * here is private (they are outbound documentation links), so the properties
 * worth enforcing are structural: they belong to a quiz, they keep a stable
 * order, and a url cannot repeat inside one quiz — the template tracks the
 * rendered list by `resource.url`, so a duplicate would collapse two entries
 * into one.
 */
describe('migration 003 — quiz_resources', () => {
  const insertResource = (
    db: DatabaseHandle,
    quizPk: number,
    url: string,
    displayOrder = 0,
    title = 'A link',
    host = 'Example'
  ) => db.query(
    `INSERT INTO quiz_resources (quiz_pk, title, url, host, display_order)
     VALUES ($1, $2, $3, $4, $5)`,
    [quizPk, title, url, host, displayOrder]
  );

  it('creates the table without disturbing the earlier migrations', async () => {
    const db = await migratedDb();
    for (const table of ['quizzes', 'questions', 'options', 'quiz_resources', 'interview_sessions']) {
      const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table}`);
      expect(Number(rows[0]!['n'])).toBe(0);
    }
  });

  it('CASCADES delete from the quiz', async () => {
    const db = await migratedDb();
    const quiz = await insertQuiz(db);
    await insertResource(db, quiz, 'https://example.test/one');

    await db.query('DELETE FROM quizzes WHERE id = $1', [quiz]);
    const { rows } = await db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM quiz_resources');
    expect(Number(rows[0]!['n'])).toBe(0);
  });

  it('REJECTS an orphan resource', async () => {
    const db = await migratedDb();
    await expect(insertResource(db, 999_999, 'https://example.test/orphan')).rejects.toThrow();
  });

  it('rejects a duplicate url within one quiz', async () => {
    const db = await migratedDb();
    const quiz = await insertQuiz(db);
    await insertResource(db, quiz, 'https://example.test/same', 0);
    await expect(insertResource(db, quiz, 'https://example.test/same', 1)).rejects.toThrow();
  });

  it('ALLOWS the same url on a DIFFERENT quiz', async () => {
    const db = await migratedDb();
    const rxjs = await insertQuiz(db, 'rxjs');
    const signals = await insertQuiz(db, 'signals');
    await insertResource(db, rxjs, 'https://angular.dev');
    await expect(insertResource(db, signals, 'https://angular.dev')).resolves.toBeDefined();
  });

  it('keeps display order unambiguous within a quiz', async () => {
    const db = await migratedDb();
    const quiz = await insertQuiz(db);
    await insertResource(db, quiz, 'https://example.test/a', 0);
    await expect(insertResource(db, quiz, 'https://example.test/b', 0)).rejects.toThrow();
  });

  it('rejects blank title, blank url and a negative order', async () => {
    const db = await migratedDb();
    const quiz = await insertQuiz(db);
    await expect(insertResource(db, quiz, 'https://example.test/x', 0, '   ')).rejects.toThrow();
    await expect(insertResource(db, quiz, '   ', 1)).rejects.toThrow();
    await expect(insertResource(db, quiz, 'https://example.test/y', -1)).rejects.toThrow();
  });

  it('defaults host to empty rather than null', async () => {
    const db = await migratedDb();
    const quiz = await insertQuiz(db);
    await db.query(
      `INSERT INTO quiz_resources (quiz_pk, title, url, display_order)
       VALUES ($1, 'No host', 'https://example.test/nohost', 0)`,
      [quiz]
    );
    const { rows } = await db.query<{ host: string }>('SELECT host FROM quiz_resources');
    expect(rows[0]!['host']).toBe('');
  });
});
