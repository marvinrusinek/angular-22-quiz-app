import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { DatabaseError, describeConnection, fromPool, openDatabase } from '../src/db/database';
import {
  getAppliedMigrations,
  listMigrationFiles,
  migrate,
  migrationsDirectory,
  MigrationError
} from '../src/db/migrate';
import { makeTempDir, removeTempDir } from './helpers/db';
import { createTestPool } from './helpers/pg-mem-pool';

let tempDir: string;
beforeEach(() => { tempDir = makeTempDir(); });
afterEach(() => removeTempDir(tempDir));

const CLOCK = () => 1_700_000_000_000;

/** A migrated, empty database. Migration tests need the handle, not a repo. */
function freshDb() {
  return fromPool(createTestPool().pool, 'pg-mem');
}

describe('opening a connection', () => {
  it('rejects a blank connection string', () => {
    expect(() => openDatabase({ databaseUrl: '   ' })).toThrow(DatabaseError);
    expect(() => openDatabase({ databaseUrl: '' })).toThrow(/not configured/i);
  });

  it('rejects a non-postgres connection string', () => {
    // The most likely migration mistake is a leftover SQLite path. Fail at
    // startup rather than at the first query.
    expect(() => openDatabase({ databaseUrl: './data/sessions.db' }))
      .toThrow(/postgres:\/\//i);
    expect(() => openDatabase({ databaseUrl: 'mysql://u:p@host/db' }))
      .toThrow(DatabaseError);
  });

  it('accepts postgres:// and postgresql://', async () => {
    // Constructing a Pool does not connect, so this stays offline.
    const a = openDatabase({ databaseUrl: 'postgres://u:p@host:5432/db' });
    const b = openDatabase({ databaseUrl: 'POSTGRESQL://u:p@host:5432/db' });
    expect(a.describe).toBe('host/db');
    expect(b.describe).toBe('host/db');
    await a.close();
    await b.close();
  });

  it('NEVER puts credentials in the description — it is logged at startup', () => {
    const description = describeConnection(
      'postgres://admin:sup3r-s3cret@ep-cool-name.neon.tech/interviews?sslmode=require'
    );
    expect(description).toBe('ep-cool-name.neon.tech/interviews');
    expect(description).not.toContain('sup3r-s3cret');
    expect(description).not.toContain('admin');
    expect(description).not.toContain('sslmode');
  });

  it('describes an unparseable url without throwing', () => {
    expect(describeConnection('not a url')).toBe('postgres');
  });
});

describe('transactions', () => {
  it('commits work performed on the pinned client', async () => {
    const db = freshDb();
    await db.transaction(async (client) => {
      await client.query('CREATE TABLE t (x INTEGER)');
      await client.query('INSERT INTO t (x) VALUES ($1)', [1]);
    });
    const { rows } = await db.query<{ x: number }>('SELECT x FROM t');
    expect(rows).toEqual([{ x: 1 }]);
  });

  it('ROLLS BACK everything when the callback throws', async () => {
    const db = freshDb();
    await db.query('CREATE TABLE t (x INTEGER)');

    await expect(
      db.transaction(async (client) => {
        await client.query('INSERT INTO t (x) VALUES ($1)', [1]);
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    const { rows } = await db.query('SELECT x FROM t');
    expect(rows).toHaveLength(0);
  });

  it('propagates the ORIGINAL error, not a rollback failure', async () => {
    const db = freshDb();
    await expect(
      db.transaction(async () => { throw new DatabaseError('original cause'); })
    ).rejects.toThrow('original cause');
  });
});

describe('migration discovery', () => {
  it('finds the real migration set in numeric order', () => {
    const files = listMigrationFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]!.version).toBe(1);
    for (let i = 1; i < files.length; i++) {
      expect(files[i]!.version).toBeGreaterThan(files[i - 1]!.version);
    }
  });

  it('the migrations directory sits next to the compiled module', () => {
    expect(existsSync(migrationsDirectory())).toBe(true);
    expect(existsSync(resolve(migrationsDirectory(), '001_interview_sessions.sql'))).toBe(true);
  });

  it('sorts NUMERICALLY, not lexicographically', () => {
    const dir = resolve(tempDir, 'migrations');
    mkdirSync(dir);
    writeFileSync(resolve(dir, '002_b.sql'), 'CREATE TABLE b (x INTEGER);');
    writeFileSync(resolve(dir, '010_c.sql'), 'CREATE TABLE c (x INTEGER);');
    writeFileSync(resolve(dir, '001_a.sql'), 'CREATE TABLE a (x INTEGER);');

    expect(listMigrationFiles(dir).map((f) => f.version)).toEqual([1, 2, 10]);
  });

  it('REJECTS a duplicate version', () => {
    const dir = resolve(tempDir, 'dupe');
    mkdirSync(dir);
    writeFileSync(resolve(dir, '001_a.sql'), 'SELECT 1;');
    writeFileSync(resolve(dir, '001_b.sql'), 'SELECT 1;');
    expect(() => listMigrationFiles(dir)).toThrow(/duplicate migration version/i);
  });

  it('rejects a badly named file', () => {
    const dir = resolve(tempDir, 'badname');
    mkdirSync(dir);
    writeFileSync(resolve(dir, 'oops.sql'), 'SELECT 1;');
    expect(() => listMigrationFiles(dir)).toThrow(/must look like/i);
  });

  it('rejects an empty migration directory', () => {
    const dir = resolve(tempDir, 'empty');
    mkdirSync(dir);
    expect(() => listMigrationFiles(dir)).toThrow(/no migrations/i);
  });

  it('rejects a missing directory', () => {
    expect(() => listMigrationFiles(resolve(tempDir, 'nope'))).toThrow(MigrationError);
  });
});

describe('migration application', () => {
  it('creates the version table and records the migration', async () => {
    const db = freshDb();
    const applied = await migrate(db, { now: CLOCK });

    // Every migration in the directory, in numeric order.
    expect(applied).toEqual([1, 2, 3]);
    const records = await getAppliedMigrations(db);
    expect(records).toHaveLength(3);
    expect(records[0]).toEqual({
      version: 1,
      name: 'interview_sessions',
      appliedAt: CLOCK()
    });
    // applied_at is epoch MILLIS and must survive the BIGINT round trip as a
    // NUMBER — pg hands back bigints as strings, and INTEGER would overflow.
    expect(typeof records[0]!.appliedAt).toBe('number');
  });

  it('is IDEMPOTENT — a second run applies nothing', async () => {
    const db = freshDb();
    expect(await migrate(db, { now: CLOCK })).toEqual([1, 2, 3]);
    expect(await migrate(db, { now: CLOCK })).toEqual([]);
    expect(await getAppliedMigrations(db)).toHaveLength(3);
  });

  it('creates every expected table', async () => {
    const db = freshDb();
    await migrate(db, { now: CLOCK });

    // Queried rather than read out of a catalog: this asserts the tables are
    // USABLE, and it behaves the same on pg-mem and on real Postgres.
    for (const table of [
      'interview_sessions', 'session_questions', 'session_options',
      'session_answers', 'schema_migrations'
    ]) {
      const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table}`);
      expect(rows[0]!['n']).toBe(table === 'schema_migrations' ? 3 : 0);
    }
  });

  it('does NOT constrain option_id globally — only within a question', async () => {
    const db = freshDb();
    await migrate(db, { now: CLOCK });

    await db.query(
      `INSERT INTO interview_sessions
         (id, token_hash, attempt_id, config_json, duration_seconds,
          created_at, expires_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')`,
      ['s1', 'h'.repeat(64), 'a1', '{}', 900, CLOCK(), CLOCK() + 3_600_000]
    );
    for (const position of [0, 1]) {
      await db.query(
        `INSERT INTO session_questions
           (session_id, position, question_id, source_quiz_id,
            question_text, question_type, explanation)
         VALUES ($1, $2, $3, 'rxjs', 'Q?', 'single', 'Because.')`,
        ['s1', position, `q${position}`]
      );
    }

    // The SAME option_id in two different questions must be allowed: option ids
    // are only unique per question in the source data.
    const insertOption = (position: number) =>
      db.query(
        `INSERT INTO session_options
           (session_id, question_position, option_id, option_text, display_order, is_correct)
         VALUES ($1, $2, 101, 'A', 0, 1)`,
        ['s1', position]
      );

    await insertOption(0);
    await expect(insertOption(1)).resolves.toBeDefined();

    // ...but a duplicate WITHIN one question must still be rejected.
    await expect(insertOption(0)).rejects.toBeDefined();
  });

  it('rolls back COMPLETELY when a migration fails — nothing is recorded', async () => {
    const dir = resolve(tempDir, 'failing');
    mkdirSync(dir);
    writeFileSync(resolve(dir, '001_ok.sql'), 'CREATE TABLE ok (x INTEGER);');
    // Valid first statement, invalid second — proves the transaction covers the
    // whole file, not just the first statement. Postgres has transactional DDL,
    // so the CREATE is rolled back too.
    writeFileSync(
      resolve(dir, '002_bad.sql'),
      'CREATE TABLE partial (x INTEGER);\nTHIS IS NOT SQL;'
    );

    const db = freshDb();
    await expect(migrate(db, { directory: dir, now: CLOCK }))
      .rejects.toThrow(/migration 2 failed/i);

    await expect(db.query('SELECT * FROM ok')).resolves.toBeDefined();          // 1 stands
    await expect(db.query('SELECT * FROM partial')).rejects.toBeDefined();      // 2 undone
    expect((await getAppliedMigrations(db)).map((m) => m.version)).toEqual([1]);
  });

  it('failure messages carry the migration NUMBER but no SQL values', async () => {
    const dir = resolve(tempDir, 'failing2');
    mkdirSync(dir);
    writeFileSync(resolve(dir, '001_bad.sql'), "INSERT INTO nope VALUES ('SECRET-VALUE');");

    // The full error is logged privately; only the sanitized one is thrown.
    const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

    const db = freshDb();
    try {
      await migrate(db, { directory: dir, now: CLOCK });
      throw new Error('expected failure');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/migration 1 failed/i);
      // Driver messages are not a controlled surface — some echo the whole
      // failing statement, values and all.
      expect(message).not.toContain('SECRET-VALUE');
      expect(message).not.toContain('INSERT');
    } finally {
      logged.mockRestore();
    }
  });

  it('applies pending migrations on an already-migrated database', async () => {
    const dir = resolve(tempDir, 'incremental');
    mkdirSync(dir);
    writeFileSync(resolve(dir, '001_a.sql'), 'CREATE TABLE a (x INTEGER);');

    const db = freshDb();
    expect(await migrate(db, { directory: dir, now: CLOCK })).toEqual([1]);

    writeFileSync(resolve(dir, '002_b.sql'), 'CREATE TABLE b (x INTEGER);');
    expect(await migrate(db, { directory: dir, now: CLOCK })).toEqual([2]);
    expect((await getAppliedMigrations(db)).map((m) => m.version)).toEqual([1, 2]);
  });
});

describe('the migration SQL itself', () => {
  it('contains no interpolation placeholders and is committed as .sql', () => {
    const sql = readFileSync(resolve(migrationsDirectory(), '001_interview_sessions.sql'), 'utf8');
    expect(sql).toContain('CREATE TABLE');
    expect(sql).toContain('interview_sessions');
    expect(sql).toContain('ON DELETE CASCADE');
    expect(sql).not.toContain('${');
  });

  it('uses BIGINT for every epoch-millis column', () => {
    // Postgres INTEGER is 32-bit and silently too small for epoch millis
    // (~1.7e12). Every timestamp column must be BIGINT.
    const sql = readFileSync(resolve(migrationsDirectory(), '001_interview_sessions.sql'), 'utf8');
    for (const column of ['created_at', 'expires_at', 'submitted_at', 'updated_at']) {
      const declaration = new RegExp(`${column}\\s+(\\w+)`, 'i').exec(sql);
      expect(declaration?.[1]?.toUpperCase()).toBe('BIGINT');
    }
  });
});
