import { DataType, newDb, type IBackup, type IMemoryDb } from 'pg-mem';
import type { Pool } from 'pg';

/**
 * An in-memory Postgres for the test suite.
 *
 * The alternative was a real server via Docker, which is not available on every
 * machine this repo is developed on, or a hosted test database, which would
 * make the suite depend on the network. pg-mem keeps `npm test` self-contained.
 *
 * WHAT THIS IS NOT: a guarantee that the SQL runs on real Postgres. pg-mem
 * implements a subset. Set TEST_DATABASE_URL to run the same suite against a
 * REAL Postgres (a Neon branch works well) before shipping a schema change.
 *
 * Two gaps are papered over below — `trim`/`length`, and transactions. Both are
 * documented at their implementation.
 */

export interface TestPool {
  readonly pool: Pool;
}

function registerMissingFunctions(db: IMemoryDb): void {
  // Real Postgres has all of these natively; pg-mem implements none of them.
  // The migrations use canonical Postgres SQL — the shims exist so the test
  // double can run the SAME DDL rather than a watered-down variant.
  db.public.registerFunction({
    name: 'trim',
    args: [DataType.text],
    returns: DataType.text,
    implementation: (value: string | null) => (value ?? '').trim()
  });
  db.public.registerFunction({
    name: 'btrim',
    args: [DataType.text],
    returns: DataType.text,
    implementation: (value: string | null) => (value ?? '').trim()
  });
  db.public.registerFunction({
    name: 'length',
    args: [DataType.text],
    returns: DataType.integer,
    implementation: (value: string | null) => (value ?? '').length
  });

  // Used by the quiz-bank normalized key columns. Only the 'g' flag is used by
  // this schema; anything else would be a silent behavioural difference from
  // real Postgres, so it is rejected rather than approximated.
  db.public.registerFunction({
    name: 'regexp_replace',
    args: [DataType.text, DataType.text, DataType.text, DataType.text],
    returns: DataType.text,
    implementation: (value: string | null, pattern: string, replacement: string, flags: string) => {
      if (flags !== 'g') {
        throw new Error(`pg-mem regexp_replace shim supports only the 'g' flag, got '${flags}'`);
      }
      return (value ?? '').replace(new RegExp(pattern, 'g'), replacement);
    }
  });
}

const BEGIN = /^\s*BEGIN\b/i;
const COMMIT = /^\s*COMMIT\b/i;
const ROLLBACK = /^\s*ROLLBACK\b/i;
const SAVEPOINT = /^\s*SAVEPOINT\s+(\S+)/i;
const ROLLBACK_TO_SAVEPOINT = /^\s*ROLLBACK\s+TO\s+SAVEPOINT\s+(\S+)/i;
const RELEASE_SAVEPOINT = /^\s*RELEASE\s+SAVEPOINT\s+(\S+)/i;

/**
 * Transaction emulation.
 *
 * pg-mem's pg adapter ignores BEGIN/COMMIT/ROLLBACK entirely — a rollback
 * leaves the write in place, and `connect()` returns a SHARED object rather
 * than a distinct backend. Left alone, every atomicity assertion in this suite
 * would pass vacuously while proving nothing, which is worse than having no
 * test at all.
 *
 * So BEGIN snapshots the database and ROLLBACK restores that snapshot, giving
 * the all-or-nothing semantics the repository actually depends on.
 *
 * LIMITS, since this is emulation and not the real thing:
 *  - One transaction at a time. `connect()` queues, so the suite behaves like a
 *    pool of size one.
 *  - No isolation. A query issued on the POOL while a transaction is open sees
 *    uncommitted rows; real Postgres would not. Tests here are sequential, so
 *    nothing depends on that distinction.
 *  - Locking, deadlocks and concurrent-writer conflicts are not modelled at
 *    all. Anything relying on those needs TEST_DATABASE_URL.
 *
 * SAVEPOINTS: pg-mem's SQL parser does not accept SAVEPOINT / ROLLBACK TO
 * SAVEPOINT / RELEASE SAVEPOINT at all (a hard parse error, not a silent
 * no-op), so those three are intercepted here the same way BEGIN/COMMIT/
 * ROLLBACK are — each named savepoint is its own `db.backup()` snapshot,
 * layered on top of the outer transaction's. This is what lets
 * confirmVerificationToken's real "SAVEPOINT, catch a unique violation,
 * ROLLBACK TO SAVEPOINT, keep querying in the same transaction" pattern run
 * against this test double at all.
 */
function withTransactions(db: IMemoryDb, raw: Pool): Pool {
  let backup: IBackup | null = null;
  let busy: Promise<void> = Promise.resolve();
  const savepoints = new Map<string, IBackup>();

  const run = async (sql: string, params?: readonly unknown[]): Promise<unknown> => {
    if (BEGIN.test(sql)) {
      backup = db.backup();
      savepoints.clear();
      return { rows: [], rowCount: 0 };
    }
    if (COMMIT.test(sql)) {
      backup = null;
      savepoints.clear();
      return { rows: [], rowCount: 0 };
    }
    const rollbackToSavepoint = ROLLBACK_TO_SAVEPOINT.exec(sql);
    if (rollbackToSavepoint) {
      savepoints.get(rollbackToSavepoint[1] as string)?.restore();
      return { rows: [], rowCount: 0 };
    }
    if (ROLLBACK.test(sql)) {
      backup?.restore();
      backup = null;
      savepoints.clear();
      return { rows: [], rowCount: 0 };
    }
    const savepoint = SAVEPOINT.exec(sql);
    if (savepoint) {
      savepoints.set(savepoint[1] as string, db.backup());
      return { rows: [], rowCount: 0 };
    }
    const releaseSavepoint = RELEASE_SAVEPOINT.exec(sql);
    if (releaseSavepoint) {
      savepoints.delete(releaseSavepoint[1] as string);
      return { rows: [], rowCount: 0 };
    }
    return raw.query(sql as string, params as unknown[]);
  };

  const client = {
    query: run,
    release: () => { /* released by the queue below */ }
  };

  return {
    query: run,

    // Hand out one client at a time, so two overlapping transactions can never
    // stomp on each other's snapshot.
    connect: async () => {
      let releaseTurn: () => void = () => {};
      const turn = new Promise<void>((resolve) => { releaseTurn = resolve; });
      const previous = busy;
      busy = turn;
      await previous;
      return { ...client, release: releaseTurn };
    },

    end: async () => raw.end()
  } as unknown as Pool;
}

/**
 * A fresh, empty in-memory database exposed as a pg Pool.
 *
 * Each call is fully isolated — no state leaks between tests, which is what the
 * old SQLite `:memory:` handle gave us.
 */
export function createTestPool(): TestPool {
  const db = newDb({
    autoCreateForeignKeyIndices: true,
    // pg-mem asserts that its planner consumed every node of a statement's AST.
    // `CREATE TABLE IF NOT EXISTS` on an ALREADY EXISTING table short-circuits
    // without reading the column constraints, so that assertion fires on the
    // second migrate() run even though the statement is a correct no-op. The
    // check is about pg-mem's own coverage, not about our SQL.
    //
    // Disabling it means pg-mem may now silently ignore a construct instead of
    // complaining. The constraints are genuinely enforced regardless — the
    // repository suite asserts real 23505 / 23503 / 23514 failures, which only
    // pass if the schema took effect.
    noAstCoverageCheck: true
  });
  registerMissingFunctions(db);

  const adapter = db.adapters.createPg();
  const raw = new adapter.Pool() as unknown as Pool;

  return { pool: withTransactions(db, raw) };
}
