import * as fs from 'node:fs';
import * as path from 'node:path';

import { createTestPool } from './pg-mem-pool';
import { fromPool, type DatabaseHandle } from '../../src/db/database';

/**
 * A fresh in-memory database with ONLY migration 009 applied — not the
 * full chain via src/db/migrate.ts.
 *
 * WHY: migrate.ts's memoryDb()-based helper (test/helpers/db.ts) runs every
 * migration from 001 onward, and migration 007
 * (interview_session_idempotency) hits a confirmed, PRE-EXISTING pg-mem bug
 * ("Corrupted alias") on its cross-column ALTER TABLE ... ADD COLUMN ...
 * ADD CONSTRAINT CHECK pattern — verified to fail identically on a clean
 * checkout with none of this feature's changes applied, so it is unrelated
 * to certificate-claims and out of scope to fix here.
 *
 * Migration 009 has no foreign-key or structural dependency on tables 001-008
 * (six entirely new, self-contained tables), so applying it alone against a
 * fresh pg-mem instance is both correct and sufficient for this feature's
 * own tests, and sidesteps the unrelated bug entirely. Verified directly:
 * migration 009 applies cleanly to a fresh pg-mem instance on its own.
 */
export async function certificateClaimTestDb(): Promise<DatabaseHandle> {
  const { pool } = createTestPool();
  const sql = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'db', 'migrations', '009_certificate_claims.sql'),
    'utf8'
  );
  await pool.query(sql);
  return fromPool(pool, 'pg-mem (certificate-claims only)');
}
