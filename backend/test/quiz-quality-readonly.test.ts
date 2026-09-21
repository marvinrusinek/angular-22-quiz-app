import { Pool } from 'pg';

import {
  READ_ONLY_BEGIN,
  READ_ONLY_CHECK,
  ROLLBACK,
  STATEMENT_TIMEOUT,
  ReadOnlyViolationError,
  assertSelectOnly,
  openReadOnlyDatabase,
  redactSecrets,
  withReadOnlySnapshot,
  type SnapshotClient,
  type SnapshotSource
} from '../src/quiz/quality/read-only-snapshot';

/**
 * The validator's database safety layer.
 *
 * Most tests use a RECORDING FAKE client so they can assert exactly which SQL was
 * sent and in what order. One test (skipped unless QUIZ_QUALITY_IT_DATABASE_URL is
 * set) runs against a real, disposable PostgreSQL to prove that the DATABASE — not
 * just this code — rejects writes inside the read-only transaction.
 */

interface Recorder extends SnapshotClient {
  readonly sql: string[];
  released: number;
}

function recorder(over: { readOnlyState?: string; failOn?: string } = {}): Recorder {
  const sql: string[] = [];
  const rec: Recorder = {
    sql,
    released: 0,
    async query(text: string) {
      sql.push(text);
      if (over.failOn !== undefined && text.startsWith(over.failOn)) throw new Error('driver failure');
      if (text === READ_ONLY_CHECK) return { rows: [{ transaction_read_only: over.readOnlyState ?? 'on' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() {
      rec.released++;
    }
  };
  return rec;
}

const sourceOf = (client: SnapshotClient): SnapshotSource => ({ connect: async () => client });

describe('the read-only transaction', () => {
  it('opens READ ONLY REPEATABLE READ first, verifies it, does the reads, and ALWAYS ends with ROLLBACK', async () => {
    const client = recorder();

    await withReadOnlySnapshot(sourceOf(client), async (db) => {
      await db.query('SELECT 1');
      await db.query('SELECT 2');
    });

    expect(client.sql).toEqual([READ_ONLY_BEGIN, READ_ONLY_CHECK, STATEMENT_TIMEOUT, 'SELECT 1', 'SELECT 2', ROLLBACK]);
    expect(READ_ONLY_BEGIN).toBe('BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ');
  });

  it('NEVER commits', async () => {
    const client = recorder();

    await withReadOnlySnapshot(sourceOf(client), async (db) => {
      await db.query('SELECT 1');
    });

    expect(client.sql.filter((s) => /^\s*commit\b/i.test(s))).toEqual([]);
    expect(client.sql[client.sql.length - 1]).toBe('ROLLBACK');
  });

  it('issues nothing but BEGIN READ ONLY, the read-only check, SET LOCAL, SELECTs and ROLLBACK', async () => {
    const client = recorder();

    await withReadOnlySnapshot(sourceOf(client), async (db) => {
      await db.query('SELECT a FROM t');
    });

    const allowed = (s: string): boolean =>
      s === READ_ONLY_BEGIN || s === READ_ONLY_CHECK || s === STATEMENT_TIMEOUT || s === ROLLBACK || /^SELECT\b/.test(s);
    expect(client.sql.every(allowed)).toBe(true);
  });

  it('rolls back and releases the connection even when the work throws', async () => {
    const client = recorder();

    await expect(
      withReadOnlySnapshot(sourceOf(client), async () => {
        throw new Error('validation blew up');
      })
    ).rejects.toThrow('validation blew up');

    expect(client.sql[client.sql.length - 1]).toBe(ROLLBACK);
    expect(client.released).toBe(1);
  });

  it('releases the connection on success exactly once', async () => {
    const client = recorder();

    await withReadOnlySnapshot(sourceOf(client), async () => 'done');

    expect(client.released).toBe(1);
  });

  it('runs no work at all if BEGIN itself fails — and does not try to roll back a transaction that never began', async () => {
    const client = recorder({ failOn: READ_ONLY_BEGIN });
    let ran = false;

    await expect(
      withReadOnlySnapshot(sourceOf(client), async () => {
        ran = true;
      })
    ).rejects.toThrow('driver failure');

    expect(ran).toBe(false);
    expect(client.sql).toEqual([READ_ONLY_BEGIN]);
    expect(client.released).toBe(1);
  });

  it('REFUSES to continue if the session does not report itself read-only (a pooler that ignored the request)', async () => {
    const client = recorder({ readOnlyState: 'off' });
    let ran = false;

    await expect(
      withReadOnlySnapshot(sourceOf(client), async () => {
        ran = true;
      })
    ).rejects.toThrow(ReadOnlyViolationError);

    expect(ran).toBe(false);
    expect(client.sql).toEqual([READ_ONLY_BEGIN, READ_ONLY_CHECK, ROLLBACK]);
    expect(client.released).toBe(1);
  });

  it('returns the work\'s result', async () => {
    await expect(withReadOnlySnapshot(sourceOf(recorder()), async () => 42)).resolves.toBe(42);
  });
});

describe('the SELECT-only guard', () => {
  it.each([
    'SELECT 1',
    'select quiz_id from quizzes',
    '  SELECT\n  q.question_text\n    FROM questions q\n    JOIN quizzes z ON z.id = q.quiz_pk\n   ORDER BY z.display_order;  ',
    'SELECT COUNT(*)::int AS n FROM options WHERE is_correct = 1'
  ])('allows a plain SELECT: %s', (sql) => {
    expect(() => assertSelectOnly(sql)).not.toThrow();
  });

  it.each([
    ['INSERT', "INSERT INTO quizzes (quiz_id) VALUES ('x')"],
    ['UPDATE', "UPDATE quizzes SET milestone = 'x'"],
    ['DELETE', 'DELETE FROM questions'],
    ['TRUNCATE', 'TRUNCATE options'],
    ['CREATE', 'CREATE TABLE t (id int)'],
    ['ALTER', 'ALTER TABLE quizzes ADD COLUMN x int'],
    ['DROP', 'DROP TABLE quizzes'],
    ['GRANT', 'GRANT ALL ON quizzes TO public'],
    ['COPY', 'COPY quizzes TO STDOUT'],
    ['CALL', 'CALL do_something()'],
    ['lower-case delete', 'delete from questions'],
    ['a leading comment', '/* harmless */ DELETE FROM questions'],
    ['BEGIN', 'BEGIN'],
    ['COMMIT', 'COMMIT'],
    ['SET', "SET default_transaction_read_only = off"],
    ['a stacked statement', 'SELECT 1; DELETE FROM questions'],
    ['a stacked statement, mixed case', 'select 1;\nDrOp TABLE quizzes'],
    ['SELECT … INTO (creates a table)', 'SELECT * INTO copy_of_quizzes FROM quizzes'],
    ['a data-modifying CTE', 'WITH gone AS (DELETE FROM questions RETURNING 1) SELECT * FROM gone'],
    ['a locking read', 'SELECT * FROM questions FOR UPDATE'],
    ['a shared locking read', 'SELECT * FROM questions FOR SHARE'],
    ['an empty statement', '   '],
    ['a comment only', '-- nothing']
  ])('REFUSES %s', (_label, sql) => {
    expect(() => assertSelectOnly(sql)).toThrow(ReadOnlyViolationError);
  });

  it('a refused statement NEVER reaches the database client', async () => {
    const client = recorder();

    await expect(
      withReadOnlySnapshot(sourceOf(client), async (db) => {
        await db.query("UPDATE quizzes SET milestone = 'x'");
      })
    ).rejects.toThrow(ReadOnlyViolationError);

    expect(client.sql.some((s) => /update/i.test(s))).toBe(false);
    expect(client.sql[client.sql.length - 1]).toBe(ROLLBACK);
  });

  it('refuses each mutation kind through the guarded Queryable without ever contacting the client', async () => {
    const client = recorder();

    await withReadOnlySnapshot(sourceOf(client), async (db) => {
      for (const sql of ['INSERT INTO t VALUES (1)', 'DELETE FROM t', 'DROP TABLE t', 'SELECT 1; DROP TABLE t']) {
        await expect(db.query(sql)).rejects.toThrow(ReadOnlyViolationError);
      }
    });

    const sent = client.sql.filter((s) => ![READ_ONLY_BEGIN, READ_ONLY_CHECK, STATEMENT_TIMEOUT, ROLLBACK].includes(s));
    expect(sent).toEqual([]);
  });
});

describe('secrets', () => {
  const URL_WITH_SECRET = 'postgresql://quiz_owner:s3cr3t-Passw0rd@ep-example-host.neon.tech/quizdb?sslmode=require';

  it('redacts the whole URL, the password and the user name from any message', () => {
    const message = `connect failed for ${URL_WITH_SECRET}: password authentication failed for user "quiz_owner" (s3cr3t-Passw0rd)`;

    const safe = redactSecrets(message, URL_WITH_SECRET);

    expect(safe).not.toContain('s3cr3t-Passw0rd');
    expect(safe).not.toContain('quiz_owner');
    expect(safe).not.toContain(URL_WITH_SECRET);
    expect(safe).toContain('[REDACTED]');
  });

  it('redacts a percent-encoded password in both encodings', () => {
    const url = 'postgres://user_x:p%40ss%3Aw0rd@host.example/db';

    expect(redactSecrets('bad password p@ss:w0rd / p%40ss%3Aw0rd', url)).not.toMatch(/p@ss:w0rd|p%40ss%3Aw0rd/);
  });

  it('redacts a user:password pair embedded in ANY url in the text', () => {
    expect(redactSecrets('see postgres://someone:hunter22@elsewhere/db', URL_WITH_SECRET)).not.toContain('hunter22');
  });

  it('leaves ordinary text alone', () => {
    expect(redactSecrets('connection timeout after 15000ms', URL_WITH_SECRET)).toBe('connection timeout after 15000ms');
  });

  it.each([
    ['missing', ''],
    ['blank', '   '],
    ['not a postgres URL', 'mysql://u:p@h/db'],
    ['garbage', 'hunter2-secret-not-a-url']
  ])('opening with a %s URL fails WITHOUT echoing it', (_label, value) => {
    let message = '';
    try {
      openReadOnlyDatabase(value);
    } catch (err: unknown) {
      message = (err as Error).message;
    }

    expect(message).toMatch(/DATABASE_URL/);
    expect(message).not.toContain('hunter2-secret');
    expect(message).not.toContain('mysql://');
  });

  it('opening with a valid URL does not connect (the pool is lazy) and can be closed', async () => {
    const database = openReadOnlyDatabase(URL_WITH_SECRET);

    await expect(database.close()).resolves.toBeUndefined();
  });
});

/**
 * REAL PostgreSQL. Skipped by default. Point QUIZ_QUALITY_IT_DATABASE_URL at a
 * DISPOSABLE database (never the development one) to prove the DATABASE itself
 * rejects writes inside the transaction, independent of the application guard.
 */
const IT_URL = (process.env['QUIZ_QUALITY_IT_DATABASE_URL'] ?? '').trim();
const describeReal = IT_URL.length > 0 ? describe : describe.skip;

describeReal('against a real PostgreSQL (disposable database)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: IT_URL, max: 1, ssl: { rejectUnauthorized: false } });
  });
  afterAll(async () => {
    await pool.end();
  });

  const source = (): SnapshotSource => pool as unknown as SnapshotSource;

  it('the session reports read-only and reads succeed', async () => {
    const value = await withReadOnlySnapshot(source(), async (db) => {
      const { rows } = await db.query<{ n: number }>('SELECT 1 AS n');
      return rows[0]?.n;
    });

    expect(value).toBe(1);
  });

  it('the DATABASE rejects a write — even one that bypasses the application guard', async () => {
    const client = await pool.connect();
    try {
      await client.query(READ_ONLY_BEGIN);
      await expect(client.query('CREATE TEMP TABLE should_never_exist (id int)')).rejects.toThrow(/read-only transaction/i);
      await client.query(ROLLBACK);

      await client.query(READ_ONLY_BEGIN);
      await expect(client.query('SELECT set_config(\'default_transaction_read_only\', \'off\', false)')).resolves.toBeDefined();
      // Even after trying to switch the default off, THIS transaction stays read-only.
      await expect(client.query('CREATE TEMP TABLE still_never (id int)')).rejects.toThrow(/read-only transaction/i);
      await client.query(ROLLBACK);
    } finally {
      client.release();
    }
  });

  it('leaves nothing behind: no table exists afterwards', async () => {
    const { rows } = await pool.query("SELECT to_regclass('pg_temp.should_never_exist') AS t");

    expect((rows[0] as { t: unknown }).t).toBeNull();
  });
});
