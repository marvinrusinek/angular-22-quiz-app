/**
 * The validator's ONLY way to talk to PostgreSQL: a read-only, single-snapshot
 * transaction.
 *
 * TWO INDEPENDENT LAYERS, so a mistake in one cannot cause a write:
 *
 *   1. THE DATABASE refuses writes. The transaction is opened with
 *      `BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ`; PostgreSQL itself then
 *      rejects INSERT/UPDATE/DELETE/DDL ("cannot execute … in a read-only
 *      transaction"). Before any work runs, the session is asked whether it really
 *      is read-only, and the run is refused if the answer is not "on" — a server or
 *      pooler that ignored the request must not be trusted.
 *
 *   2. THE APPLICATION refuses anything but a plain single SELECT before it is
 *      sent (`assertSelectOnly`). This is not the safety mechanism — layer 1 is —
 *      it makes a stray write fail loudly at the call site and keeps the rule
 *      unit-testable without a database.
 *
 * REPEATABLE READ gives one coherent snapshot: every query sees the bank as it was
 * when the transaction began, so it cannot change halfway through validation.
 *
 * The transaction ALWAYS ends with ROLLBACK, never COMMIT — there is nothing to
 * keep. It does not run migrations, call the importer or repair anything.
 *
 * SECRETS: nothing here logs or returns the connection string. `redactSecrets`
 * exists for callers that must print an error from the driver.
 */

import { Pool } from 'pg';
import type { QueryResultRow } from 'pg';

import { DatabaseError, type Queryable } from '../../db/database';

export class ReadOnlyViolationError extends Error {
  public override readonly name = 'ReadOnlyViolationError';
}

export const READ_ONLY_BEGIN = 'BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ';
export const READ_ONLY_CHECK = "SELECT current_setting('transaction_read_only') AS transaction_read_only";
export const ROLLBACK = 'ROLLBACK';

/**
 * A stuck query must not hang a developer's terminal. Set INSIDE the transaction with SET LOCAL —
 * a pool startup parameter is rejected by Neon's pooler, and SET LOCAL ends with the transaction.
 */
export const STATEMENT_TIMEOUT = 'SET LOCAL statement_timeout = 60000';

/** Keywords that can never appear in a read-only query. Matched as whole words. */
const FORBIDDEN = [
  'insert', 'update', 'delete', 'truncate', 'create', 'alter', 'drop', 'grant', 'revoke',
  'copy', 'call', 'execute', 'vacuum', 'reindex', 'lock', 'into', 'comment'
];
const FORBIDDEN_PATTERN = new RegExp(`\\b(${FORBIDDEN.join('|')})\\b`, 'i');
const LOCKING_PATTERN = /\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i;

/**
 * Accepts exactly one plain SELECT. Throws before the SQL is sent otherwise.
 * Deliberately conservative: it may refuse a harmless query, never accept a write.
 */
export function assertSelectOnly(sql: string): void {
  const text = sql.trim().replace(/;\s*$/, '');

  if (!/^select\b/i.test(text)) {
    throw new ReadOnlyViolationError('the validator may only run SELECT statements');
  }
  if (text.includes(';')) {
    throw new ReadOnlyViolationError('the validator may only run a single statement');
  }
  if (FORBIDDEN_PATTERN.test(text) || LOCKING_PATTERN.test(text)) {
    throw new ReadOnlyViolationError('the validator may only run read-only SELECT statements');
  }
}

/** The subset of `pg`'s PoolClient this module uses — so tests can supply a recording fake. */
export interface SnapshotClient {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  release(): void;
}

/** `pg.Pool` satisfies this. */
export interface SnapshotSource {
  connect(): Promise<SnapshotClient>;
}

function guarded(client: SnapshotClient): Queryable {
  return {
    async query<R extends QueryResultRow = QueryResultRow>(sql: string, params?: readonly unknown[]) {
      assertSelectOnly(sql);
      const result = await client.query(sql, params);
      return { rows: result.rows as R[], rowCount: result.rowCount };
    }
  };
}

/**
 * Runs `work` inside one read-only REPEATABLE READ snapshot and always rolls back.
 * `work` receives a Queryable that refuses anything but SELECT.
 */
export async function withReadOnlySnapshot<T>(
  source: SnapshotSource,
  work: (db: Queryable) => Promise<T>
): Promise<T> {
  const client = await source.connect();
  let began = false;

  try {
    await client.query(READ_ONLY_BEGIN);
    began = true;

    // Fail closed: do not trust the request, ask the session.
    const check = await client.query(READ_ONLY_CHECK);
    const state = (check.rows[0] as { transaction_read_only?: unknown } | undefined)?.transaction_read_only;
    if (state !== 'on') {
      throw new ReadOnlyViolationError('the database session is not read-only; refusing to continue');
    }

    await client.query(STATEMENT_TIMEOUT);

    return await work(guarded(client));
  } finally {
    if (began) {
      try {
        await client.query(ROLLBACK);
      } catch {
        // The connection is being released regardless; there is nothing to commit.
      }
    }
    client.release();
  }
}

export interface ReadOnlyDatabase {
  readonly source: SnapshotSource;
  readonly close: () => Promise<void>;
}

/**
 * A single-connection pool with the same TLS posture as `openDatabase`
 * (`db/database.ts`): TLS required, certificate chain not verified — the same
 * setting every other Node database consumer in this repository uses for Neon.
 * The URL is validated but never echoed.
 */
export function openReadOnlyDatabase(databaseUrl: string): ReadOnlyDatabase {
  if (typeof databaseUrl !== 'string' || databaseUrl.trim().length === 0) {
    throw new DatabaseError('DATABASE_URL is not configured');
  }
  if (!/^postgres(ql)?:\/\//i.test(databaseUrl.trim())) {
    throw new DatabaseError('DATABASE_URL must be a postgres:// connection string');
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
    idleTimeoutMillis: 30_000
  });

  pool.on('error', () => {
    // Swallowed on purpose: an idle-client error message can carry connection details.
  });

  return {
    source: pool as unknown as SnapshotSource,
    close: () => pool.end()
  };
}

/** Removes the connection string, its password and user name from a message before it is printed. */
export function redactSecrets(text: string, databaseUrl: string): string {
  let out = text;
  const secrets: string[] = [databaseUrl.trim()];

  try {
    const url = new URL(databaseUrl.trim());
    if (url.password) secrets.push(url.password, decodeURIComponent(url.password));
    if (url.username) secrets.push(url.username, decodeURIComponent(url.username));
  } catch {
    // Not a parseable URL: the whole string was already added above.
  }

  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join('[REDACTED]');
  }
  return out.replace(/(:\/\/[^\s:/@]+):[^\s@/]+@/g, '$1:[REDACTED]@');
}
