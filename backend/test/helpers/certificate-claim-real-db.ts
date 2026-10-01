import * as fs from 'node:fs';
import * as path from 'node:path';

import { Pool } from 'pg';

import { fromPool, type DatabaseHandle } from '../../src/db/database';

/**
 * A real Postgres connection for the certificate-claims suite, gated on
 * TEST_DATABASE_URL — same convention as quiz-bank-schema.test.ts.
 *
 * WHY THIS EXISTS ALONGSIDE certificate-claim-db.ts (the pg-mem helper):
 * pg-mem does not model real transaction-abort semantics (a failed
 * statement does not poison the rest of the transaction the way it does on
 * real Postgres — see confirmVerificationToken's SAVEPOINT usage) or real
 * multi-connection concurrency (its own pool wrapper queues one client at a
 * time). Both gaps are exactly what this feature's crash-safety and
 * concurrent-issuance guarantees depend on, so they are asserted here
 * against an actual server, not approximated.
 *
 * Tables are created fresh (DROP ... CASCADE then re-apply migration 009)
 * each time this is called, so tests stay isolated without needing a whole
 * throwaway database per run — acceptable because CI/local runs one
 * ephemeral container for the whole suite, never a shared persistent one.
 */
export async function realCertificateClaimTestDb(): Promise<DatabaseHandle> {
  const databaseUrl = (process.env['TEST_DATABASE_URL'] ?? '').trim();
  if (databaseUrl.length === 0) {
    throw new Error('realCertificateClaimTestDb() called without TEST_DATABASE_URL set');
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  const db = fromPool(pool, 'real-pg (certificate-claims)');

  await db.query(`
    DROP TABLE IF EXISTS certificate_notification_outbox CASCADE;
    DROP TABLE IF EXISTS certificate_retrieval_tokens CASCADE;
    DROP TABLE IF EXISTS issued_certificates CASCADE;
    DROP TABLE IF EXISTS certificate_verification_tokens CASCADE;
    DROP TABLE IF EXISTS certificate_claims CASCADE;
  `);

  const sql = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'db', 'migrations', '009_certificate_claims.sql'),
    'utf8'
  );
  await db.query(sql);

  return db;
}
