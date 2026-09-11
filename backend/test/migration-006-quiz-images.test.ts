import { mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { fromPool } from '../src/db/database';
import { getAppliedMigrations, migrate, migrationsDirectory } from '../src/db/migrate';
import { makeTempDir, removeTempDir } from './helpers/db';
import { createTestPool } from './helpers/pg-mem-pool';

/**
 * Migration 006 against a DISPOSABLE, LOCAL, in-memory Postgres (pg-mem) —
 * never the real Neon database. Follows the exact pattern already
 * established in db-migrations.test.ts's "applies pending migrations on an
 * already-migrated database": apply 001-005 first, seed rows the way the
 * real bank would already have them, THEN apply 006 so the UPDATE runs
 * against real matching rows instead of an empty table.
 */

const CLOCK = () => 1_700_000_000_000;

const EXPECTED: ReadonlyArray<readonly [quizId: string, image: string]> = [
  ['typescript', 'assets/images/typescript.webp'],
  ['create-first-app', 'assets/images/create-first-app.webp'],
  ['templates', 'assets/images/templates.webp'],
  ['dependency-injection', 'assets/images/dependency-injection.webp'],
  ['component-tree', 'assets/images/component-tree.webp'],
  ['router', 'assets/images/router.webp'],
  ['material', 'assets/images/material.webp'],
  ['forms', 'assets/images/forms.webp'],
  ['angular-cli', 'assets/images/angular-cli.webp'],
];

let tempDir: string;
beforeEach(() => { tempDir = makeTempDir(); });
afterEach(() => removeTempDir(tempDir));

/** Copy migrations 001-005 (only) into a temp dir, mirroring the real set. */
function copyPreExistingMigrations(destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  const real = migrationsDirectory();
  for (const file of readdirSync(real)) {
    if (file.startsWith('006_')) continue;
    copyFileSync(resolve(real, file), resolve(destDir, file));
  }
}

/** Copy migration 006 (only) into an already-migrated temp dir. */
function addMigration006(destDir: string): void {
  const real = migrationsDirectory();
  copyFileSync(resolve(real, '006_fix_quiz_image_urls.sql'), resolve(destDir, '006_fix_quiz_image_urls.sql'));
}

function freshDb() {
  return fromPool(createTestPool().pool, 'pg-mem');
}

async function seedQuiz(db: ReturnType<typeof freshDb>, quizId: string, image: string, displayOrder: number): Promise<void> {
  await db.query(
    `INSERT INTO quizzes (quiz_id, milestone, summary, image, difficulty, facts_json, display_order, status)
     VALUES ($1, $2, '', $3, 'beginner', '[]', $4, 'active')`,
    [quizId, quizId, image, displayOrder]
  );
}

describe('006_fix_quiz_image_urls — against a disposable local (pg-mem) database only', () => {
  it('is a real, discoverable migration file, not yet applied by any prior migration', () => {
    // Guards the numbering claim made before writing the file: 001-005 existed,
    // 006 was unused.
    const files = readdirSync(migrationsDirectory());
    const version006 = files.filter((f) => f.startsWith('006_'));
    expect(version006).toEqual(['006_fix_quiz_image_urls.sql']);
  });

  it('applies as migration version 6, after 1-5', async () => {
    const db = freshDb();
    const applied = await migrate(db, { now: CLOCK });
    expect(applied).toEqual([1, 2, 3, 4, 5, 6]);
    const records = await getAppliedMigrations(db);
    expect(records.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(records[5]).toMatchObject({ version: 6, name: 'fix_quiz_image_urls' });
  });

  it('rewrites exactly the 9 targeted quiz_id rows to their local WebP path', async () => {
    const dir = resolve(tempDir, 'pre006');
    copyPreExistingMigrations(dir);

    const db = freshDb();
    expect(await migrate(db, { directory: dir, now: CLOCK })).toEqual([1, 2, 3, 4, 5]);

    // Seed rows the way the real bank already has them — external URL, plus
    // one control row that migration 006 must NOT touch.
    let order = 0;
    for (const [quizId] of EXPECTED) {
      await seedQuiz(
        db, quizId,
        `https://raw.githubusercontent.com/marvinrusinek/codelab-angular-10-quiz-app/quiz/codelab-master/apps/playground/src/assets/images/${quizId}.png`,
        order++
      );
    }
    await seedQuiz(db, 'rxjs', 'assets/images/rxjs.svg', order++); // control: already local, untouched by 006

    addMigration006(dir);
    expect(await migrate(db, { directory: dir, now: CLOCK })).toEqual([6]);

    for (const [quizId, expectedImage] of EXPECTED) {
      const { rows } = await db.query<{ image: string }>(
        'SELECT image FROM quizzes WHERE quiz_id = $1', [quizId]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.image).toBe(expectedImage);
      // Bare relative path — no leading slash, no scheme — matching the
      // convention already proven to resolve under the GitHub Pages base
      // href (https://marvinrusinek.github.io/angular-22-quiz-app/).
      expect(rows[0]!.image).not.toMatch(/^https?:\/\//);
      expect(rows[0]!.image).not.toMatch(/^\//);
    }

    // Control row is untouched.
    const { rows: control } = await db.query<{ image: string }>(
      "SELECT image FROM quizzes WHERE quiz_id = 'rxjs'"
    );
    expect(control[0]!.image).toBe('assets/images/rxjs.svg');
  });

  it('is idempotent — re-running leaves the same values in place', async () => {
    const dir = resolve(tempDir, 'idempotent');
    copyPreExistingMigrations(dir);

    const db = freshDb();
    await migrate(db, { directory: dir, now: CLOCK });
    let order = 0;
    for (const [quizId] of EXPECTED) {
      await seedQuiz(db, quizId, 'https://raw.githubusercontent.com/example/x.png', order++);
    }

    addMigration006(dir);
    await migrate(db, { directory: dir, now: CLOCK });
    // A second attempt to apply the SAME migration set is a no-op at the
    // migration-runner level (006 is already recorded in schema_migrations) —
    // this is the same guarantee the pre-existing "is IDEMPOTENT" test in
    // db-migrations.test.ts asserts for the real migration set.
    expect(await migrate(db, { directory: dir, now: CLOCK })).toEqual([]);

    const { rows } = await db.query<{ image: string }>(
      "SELECT image FROM quizzes WHERE quiz_id = 'typescript'"
    );
    expect(rows[0]!.image).toBe('assets/images/typescript.webp');
  });

  it('touches only the `image` column — no other field on the 9 rows changes', async () => {
    const dir = resolve(tempDir, 'scope');
    copyPreExistingMigrations(dir);

    const db = freshDb();
    await migrate(db, { directory: dir, now: CLOCK });
    await seedQuiz(db, 'typescript', 'https://raw.githubusercontent.com/example/ts.png', 0);
    await db.query(
      `UPDATE quizzes SET summary = 'a distinctive summary', difficulty = 'advanced' WHERE quiz_id = 'typescript'`
    );

    addMigration006(dir);
    await migrate(db, { directory: dir, now: CLOCK });

    const { rows } = await db.query<{ summary: string; difficulty: string; image: string }>(
      "SELECT summary, difficulty, image FROM quizzes WHERE quiz_id = 'typescript'"
    );
    expect(rows[0]).toEqual({
      summary: 'a distinctive summary',
      difficulty: 'advanced',
      image: 'assets/images/typescript.webp',
    });
  });

  it('contains no interpolation placeholders and only targets the 9 known quiz_ids', () => {
    const { readFileSync } = require('node:fs');
    const sql = readFileSync(resolve(migrationsDirectory(), '006_fix_quiz_image_urls.sql'), 'utf8');
    expect(sql).not.toContain('${');
    for (const [quizId] of EXPECTED) {
      expect(sql).toContain(`quiz_id = '${quizId}'`);
    }
    // Exactly 9 UPDATE statements — no more, no fewer.
    expect((sql.match(/^UPDATE quizzes/gm) ?? []).length).toBe(9);
  });
});
