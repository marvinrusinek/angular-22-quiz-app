import { mkdtempSync, rmSync, readdirSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Pool } from 'pg';

import { fromPool, type DatabaseHandle } from '../src/db/database';
import { migrate, migrationsDirectory } from '../src/db/migrate';
import { createTestPool, MIGRATION_007_ORIGINAL_ALTER } from './helpers/pg-mem-pool';

/**
 * Schema-level regression coverage for migration
 * 007_interview_session_idempotency.sql — reproduced missing entirely before
 * this file (no test anywhere referenced `idempotency_key_hash` or
 * `idempotency_request_hash`), even though the migration's own doc comment
 * describes real security properties (hash length, paired presence,
 * uniqueness) that nothing was verifying at the database level.
 *
 * Runs against BOTH pg-mem and (when TEST_DATABASE_URL is set) a real,
 * disposable PostgreSQL — pg-mem alone would not have caught the
 * "Corrupted alias" incompatibility this migration originally hit (see
 * test/helpers/pg-mem-pool.ts's workAroundPgMemCorruptedAliasBug), so this
 * suite exercises the SAME constraints against the real engine too, proving
 * the pg-mem workaround changed nothing about what is actually enforced.
 */

const CLOCK = () => 1_700_000_000_000;

let sessionCounter = 0;
function nextIds(): { id: string; attemptId: string } {
  sessionCounter += 1;
  return { id: `sess_idem_${sessionCounter}`, attemptId: `att_idem_${sessionCounter}` };
}

/**
 * A FRESH, never-before-used 64-character hash value, every single call —
 * never a shared constant reused across tests. A prior version of this
 * file reused fixed constants (KEY_HASH_A etc.) across unrelated tests: by
 * the time later negative tests ran, that value was already present in
 * the table from an earlier test, so their generic `.rejects.toThrow()`
 * could pass from the UNIQUE constraint on idempotency_key_hash alone —
 * even if the hash-length CHECK being "tested" were missing entirely.
 * A monotonic counter makes that collision structurally impossible.
 */
let hashCounter = 0;
function freshHash(): string {
  hashCounter += 1;
  const marker = hashCounter.toString(16).padStart(8, '0');
  return marker.repeat(8).slice(0, 64);
}

interface ConstraintNames {
  readonly keyHashFormat: string;
  readonly requestHashFormat: string;
  readonly pairedNullability: string;
}

/** The real auto-generated constraint names Postgres gives the two inline, unnamed CHECKs on migration 007's ORIGINAL (unmodified) statement. */
const REAL_PG_CONSTRAINT_NAMES: ConstraintNames = {
  keyHashFormat: 'interview_sessions_idempotency_key_hash_check',
  requestHashFormat: 'interview_sessions_idempotency_request_hash_check',
  pairedNullability: 'idempotency_hash_present_iff_key_present'
};

/** The explicit names this project's pg-mem-safe rewrite (pg-mem-pool.ts) gives the same three CHECKs. */
const PGMEM_CONSTRAINT_NAMES: ConstraintNames = {
  keyHashFormat: 'idempotency_key_hash_format',
  requestHashFormat: 'idempotency_request_hash_format',
  pairedNullability: 'idempotency_hash_present_iff_key_present'
};

interface PgErrorLike {
  readonly code?: string;
  readonly constraint?: string;
  readonly message?: string;
}

/**
 * Asserts the promise rejects due to a CHECK violation on SPECIFICALLY
 * `constraintName` — never a UNIQUE violation, and never any other
 * failure. Real Postgres reports SQLSTATE 23514 (check_violation) and the
 * exact constraint name directly on the error object. pg-mem does NOT
 * populate `.code` for a CHECK violation at all (verified directly by
 * probing it — only a UNIQUE violation gets a `.code`), so the constraint
 * name embedded in its error message is the reliable fallback there.
 * Either way, a 23505 (UNIQUE) can never satisfy this assertion — which is
 * exactly the masking gap a prior review found.
 */
async function expectCheckViolation(promise: Promise<unknown>, constraintName: string): Promise<void> {
  let caught: PgErrorLike | undefined;
  try {
    await promise;
  } catch (err) {
    caught = err as PgErrorLike;
  }
  if (!caught) {
    throw new Error(`expected a CHECK violation on "${constraintName}", but the insert succeeded`);
  }

  expect(caught.code).not.toBe('23505');
  if (caught.code !== undefined) {
    expect(caught.code).toBe('23514');
  }
  if (caught.constraint !== undefined) {
    expect(caught.constraint).toBe(constraintName);
  } else {
    expect(caught.message ?? '').toContain(constraintName);
  }
}

/** SQLSTATE 23505 (unique_violation) — reported with `.code` by BOTH pg-mem and real Postgres, verified directly. */
async function expectUniqueViolation(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code: '23505' });
}

interface InsertOverrides {
  readonly idempotencyKeyHash?: string | null;
  readonly idempotencyRequestHash?: string | null;
}

async function insertSession(db: DatabaseHandle, overrides: InsertOverrides = {}): Promise<void> {
  const { id, attemptId } = nextIds();
  await db.query(
    `INSERT INTO interview_sessions
       (id, token_hash, status, config_json, duration_seconds, created_at, expires_at, attempt_id,
        idempotency_key_hash, idempotency_request_hash)
     VALUES ($1, $2, 'active', '{}', 900, $3, $4, $5, $6, $7)`,
    [
      id, 'a'.repeat(64), CLOCK(), CLOCK() + 3_600_000, attemptId,
      overrides.idempotencyKeyHash ?? null,
      overrides.idempotencyRequestHash ?? null
    ]
  );
}

/** Narrow, local copy of migrations strictly BEFORE `beforeVersion` — mirrors migration-006-quiz-images.test.ts's own pattern. */
function copyMigrationsBefore(beforeVersion: number, destDir: string): void {
  const real = migrationsDirectory();
  for (const file of readdirSync(real)) {
    const match = /^(\d+)_/.exec(file);
    if (!match || Number(match[1]) >= beforeVersion) continue;
    copyFileSync(resolve(real, file), resolve(destDir, file));
  }
}

/**
 * One shared suite body, exercised against whichever already-migrated
 * database `getDb()` returns — this is what guarantees pg-mem and real
 * Postgres assert the exact same thing, not two suites that quietly
 * drifted apart. Every row uses a unique id/attemptId (see nextIds), so
 * these tests are safe to run against ONE shared, already-migrated
 * database — including a real one also used by other describe blocks in
 * this file.
 */
function defineConstraintSuite(getDb: () => DatabaseHandle, names: ConstraintNames): void {
  it('accepts exactly 64 hex characters for both hash columns', async () => {
    await expect(insertSession(getDb(), {
      idempotencyKeyHash: freshHash(),
      idempotencyRequestHash: freshHash()
    })).resolves.toBeUndefined();
  });

  it('allows BOTH columns NULL — the no-idempotency-key caller path', async () => {
    await expect(insertSession(getDb())).resolves.toBeUndefined();
  });

  it('hash-length CHECK rejects an idempotency_key_hash shorter than 64 characters', async () => {
    await expectCheckViolation(
      insertSession(getDb(), { idempotencyKeyHash: 'a'.repeat(63), idempotencyRequestHash: freshHash() }),
      names.keyHashFormat
    );
  });

  it('hash-length CHECK rejects an idempotency_key_hash longer than 64 characters', async () => {
    await expectCheckViolation(
      insertSession(getDb(), { idempotencyKeyHash: 'a'.repeat(65), idempotencyRequestHash: freshHash() }),
      names.keyHashFormat
    );
  });

  it('hash-length CHECK rejects an idempotency_request_hash of the wrong length', async () => {
    // idempotencyKeyHash is a FRESH hash never used elsewhere — so if this
    // insert fails, it cannot be the UNIQUE constraint; it can only be the
    // request-hash CHECK this test actually targets.
    await expectCheckViolation(
      insertSession(getDb(), { idempotencyKeyHash: freshHash(), idempotencyRequestHash: 'short' }),
      names.requestHashFormat
    );
  });

  it('paired-nullability CHECK rejects a key hash present without a request hash', async () => {
    await expectCheckViolation(
      insertSession(getDb(), { idempotencyKeyHash: freshHash() }),
      names.pairedNullability
    );
  });

  it('paired-nullability CHECK rejects a request hash present without a key hash', async () => {
    await expectCheckViolation(
      insertSession(getDb(), { idempotencyRequestHash: freshHash() }),
      names.pairedNullability
    );
  });

  it('UNIQUE constraint rejects two rows presenting the SAME idempotency_key_hash', async () => {
    const db = getDb();
    const sharedKeyHash = freshHash();
    await insertSession(db, { idempotencyKeyHash: sharedKeyHash, idempotencyRequestHash: freshHash() });
    await expectUniqueViolation(
      insertSession(db, { idempotencyKeyHash: sharedKeyHash, idempotencyRequestHash: freshHash() })
    );
  });

  it('UNIQUE constraint allows MULTIPLE rows with a NULL idempotency_key_hash (SQL-standard: NULLs are never equal)', async () => {
    const db = getDb();
    await insertSession(db);
    await expect(insertSession(db)).resolves.toBeUndefined();
  });
}

/**
 * Compatibility with a row that existed BEFORE migration 007 ran: apply
 * only 001-006 to a FRESH database, insert a real row (written while the
 * idempotency columns did not exist), THEN apply 007-009 against that
 * already-populated table, and confirm the pre-existing row survives with
 * NULL hash columns rather than being rejected, altered, or losing data.
 * Needs its OWN fresh database (unlike defineConstraintSuite above) since
 * it depends on migrations 7+ NOT being applied yet when it starts.
 */
function defineCompatibilityTest(openFreshUnmigratedDb: () => Promise<DatabaseHandle>): void {
  it('is compatible with a row that existed BEFORE migration 007 ran — it keeps NULL hash columns, untouched', async () => {
    const db = await openFreshUnmigratedDb();
    const dir = mkdtempSync(join(tmpdir(), 'migration-007-compat-'));
    try {
      copyMigrationsBefore(7, dir);
      await migrate(db, { directory: dir, now: CLOCK });

      await db.query(
        `INSERT INTO interview_sessions (id, token_hash, status, config_json, duration_seconds, created_at, expires_at, attempt_id)
         VALUES ('pre007', $1, 'active', '{}', 900, $2, $3, 'att_pre007')`,
        ['a'.repeat(64), CLOCK(), CLOCK() + 3_600_000]
      );

      // Now apply the rest, including 007, against that already-populated table.
      await migrate(db, { now: CLOCK });

      const { rows } = await db.query<{ idempotency_key_hash: string | null }>(
        `SELECT idempotency_key_hash FROM interview_sessions WHERE id = 'pre007'`
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.idempotency_key_hash).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await db.close();
    }
  });
}

describe('007_interview_session_idempotency — pg-mem compatibility drift', () => {
  it('the pg-mem-safe rewrite in pg-mem-pool.ts still matches this migration as currently written', () => {
    // No database involved — a pure text check, so it runs even without any
    // DB infra at all. If this fails, migration 007 was edited (a renamed
    // constraint, reworded CHECK, added column, ANY change to this exact
    // statement) without updating workAroundPgMemCorruptedAliasBug's
    // MIGRATION_007_ORIGINAL_ALTER to match. That function already fails
    // SAFE on a mismatch (returns the SQL unchanged rather than applying a
    // stale rewrite to different SQL) — but silently, so every pg-mem test
    // touching interview_sessions would start failing again with the
    // original "Corrupted alias" error and no indication why. This test is
    // what turns that into one specific, correctly-attributed failure here.
    const sql = readFileSync(resolve(migrationsDirectory(), '007_interview_session_idempotency.sql'), 'utf8');
    expect(sql).toContain(MIGRATION_007_ORIGINAL_ALTER);
  });
});

describe('007_interview_session_idempotency — schema constraints (pg-mem)', () => {
  let db: DatabaseHandle;

  beforeAll(async () => {
    db = fromPool(createTestPool().pool, 'pg-mem');
    await migrate(db, { now: CLOCK });
  });

  afterAll(async () => {
    await db.close();
  });

  defineConstraintSuite(() => db, PGMEM_CONSTRAINT_NAMES);
  defineCompatibilityTest(async () => fromPool(createTestPool().pool, 'pg-mem'));
});

const realDatabaseUrl = (process.env['TEST_DATABASE_URL'] ?? '').trim();
const describeReal = realDatabaseUrl.length > 0 ? describe : describe.skip;

describeReal('007_interview_session_idempotency — same constraints against REAL PostgreSQL (TEST_DATABASE_URL)', () => {
  // Each describe block below gets its OWN dedicated schema, created and
  // dropped here — never DROP TABLE against the shared default schema:
  // migrations 2/3/5 ALTER tables that migration-002/003 own, so a partial,
  // table-scoped cleanup here would conflict with whatever earlier state
  // another test file left in that schema (reproduced directly: dropping
  // only the interview_sessions-family tables left `questions` behind with
  // migration 5's CHECK constraint already on it, and re-running migrate()
  // then failed re-adding that same constraint — SQLSTATE 42710). A
  // dedicated schema per describe block sidesteps this entirely.
  let db: DatabaseHandle;
  let schema: string;

  beforeAll(async () => {
    schema = `migration_007_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const bootstrap = new Pool({ connectionString: realDatabaseUrl, max: 1 });
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    await bootstrap.end();

    const pool = new Pool({ connectionString: realDatabaseUrl, max: 5, options: `-c search_path=${schema}` });
    db = fromPool(pool, `real-pg (migration 007, schema ${schema})`);
    await migrate(db, { now: CLOCK });
  });

  afterAll(async () => {
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.close();
  });

  defineConstraintSuite(() => db, REAL_PG_CONSTRAINT_NAMES);

  defineCompatibilityTest(async () => {
    const compatSchema = `migration_007_compat_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const bootstrap = new Pool({ connectionString: realDatabaseUrl, max: 1 });
    await bootstrap.query(`CREATE SCHEMA "${compatSchema}"`);
    await bootstrap.end();

    const pool = new Pool({ connectionString: realDatabaseUrl, max: 5, options: `-c search_path=${compatSchema}` });
    const handle = fromPool(pool, `real-pg (migration 007 compat, schema ${compatSchema})`);
    const originalClose = handle.close;
    return {
      ...handle,
      close: async () => {
        await handle.query(`DROP SCHEMA IF EXISTS "${compatSchema}" CASCADE`);
        await originalClose();
      }
    } as DatabaseHandle;
  });
});
