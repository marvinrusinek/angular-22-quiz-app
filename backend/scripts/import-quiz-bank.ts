/**
 * Import the private quiz bank into PostgreSQL.
 *
 * RUN MANUALLY. Never wired into a build, a test, or server startup — importing
 * is an operator action against a specific database with a specific file.
 *
 *   npm --prefix backend run import:quiz-bank -- --file ../private/quiz.json
 *   npm --prefix backend run import:quiz-bank -- --file ./data/quiz.json --dry-run
 *
 * THE SOURCE FILE MUST NOT LIVE IN THE PUBLIC REPOSITORY once the migration is
 * complete. During the transition it still does, and this script warns when the
 * path it was given is inside the working tree.
 *
 * ── Why it reuses validateAndNormalize ─────────────────────────────
 *
 * The same validation that guards the JSON path also guards the import, so
 * PostgreSQL cannot end up holding data the JSON loader would have rejected —
 * and the derived question type and legacy ids are computed by exactly one
 * implementation rather than two that could drift.
 *
 * ── Idempotency ────────────────────────────────────────────────────
 *
 * One transaction. Each quiz is upserted, then its questions are DELETED and
 * reinserted (options cascade). A full replace rather than a merge, so a
 * question removed from the source is also removed from the database — a merge
 * would silently leave orphans that no longer exist in the bank.
 *
 * Interview sessions are unaffected: they store frozen snapshots and hold no
 * foreign key into these tables.
 */

import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { openDatabase, type DatabaseHandle, type Queryable } from '../src/db/database';
import { migrate } from '../src/db/migrate';
import { validateAndNormalize } from '../src/quiz/quiz.validation';
import type { PrivateQuiz } from '../src/quiz/quiz.types';

interface Args {
  readonly file: string;
  readonly databaseUrl: string;
  readonly dryRun: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let file = '';
  let databaseUrl = (process.env['DATABASE_URL'] ?? '').trim();
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--file') file = argv[++i] ?? '';
    else if (arg === '--database-url') databaseUrl = argv[++i] ?? '';
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: import-quiz-bank --file <path> [--database-url <url>] [--dry-run]');
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }

  if (!file) fail('--file is required');
  if (!databaseUrl) fail('DATABASE_URL is not set and --database-url was not given');
  return { file, databaseUrl, dryRun };
}

function fail(message: string): never {
  console.error(`[import] ${message}`);
  process.exit(1);
}

/**
 * Warn when the source sits inside the repository.
 *
 * Not fatal: during the migration the bank is still committed at
 * `backend/data/quiz.json`, and that file is what we import FROM. Once the
 * removal stage lands, the source must live outside the working tree.
 */
function warnIfInsideRepo(filePath: string): void {
  const repoRoot = resolve(__dirname, '..', '..');
  const rel = relative(repoRoot, resolve(filePath));
  if (!rel.startsWith('..')) {
    console.warn(
      `[import] WARNING: source is inside the repository (${rel}).\n` +
      '[import] This is expected during the migration, but the real bank must\n' +
      '[import] live OUTSIDE the public repo before the removal stage.'
    );
  }
}

/** Counts only — never text, correctness or explanations. */
interface ImportSummary {
  quizzes: number;
  questions: number;
  options: number;
  correctOptions: number;
  resources: number;
}

/**
 * Display-only trivia, read from the RAW source.
 *
 * `facts` is not part of the normalized private model — the backend has never
 * needed it — but QuizFactComponent and the Results page do use it, so it is
 * stored now rather than lost when the Angular asset is removed. Extracted
 * defensively: anything that is not an array of strings becomes an empty list.
 */
function factsByQuizId(raw: unknown): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  const source = raw as { quizzes?: unknown } | null;
  const list = Array.isArray(source) ? source : (Array.isArray(source?.quizzes) ? source.quizzes : []);

  for (const entry of list as readonly unknown[]) {
    const quiz = entry as { quizId?: unknown; facts?: unknown };
    if (typeof quiz?.quizId !== 'string') continue;
    const facts = Array.isArray(quiz.facts)
      ? quiz.facts.filter((fact): fact is string => typeof fact === 'string')
      : [];
    out.set(quiz.quizId, facts);
  }
  return out;
}

interface SourceResource {
  readonly title: string;
  readonly url: string;
  readonly host: string;
}

/**
 * The Results-page links, from the file's top-level `resources` block.
 *
 * Extracted the same defensive way as `facts`, and for the same reason: this
 * data is not part of the normalized private model, so nothing upstream has
 * validated it. An item missing `title` or `url` is dropped rather than
 * written, because both are NOT NULL with a non-empty CHECK.
 *
 * The entry's own `milestone` is deliberately ignored — it duplicates
 * `quizzes.milestone` byte for byte, and the panel takes the name it displays
 * from the quiz metadata.
 */
function resourcesByQuizId(raw: unknown): ReadonlyMap<string, readonly SourceResource[]> {
  const out = new Map<string, readonly SourceResource[]>();
  const source = raw as { resources?: unknown } | null;
  if (!Array.isArray(source?.resources)) return out;

  for (const entry of source.resources as readonly unknown[]) {
    const group = entry as { quizId?: unknown; resources?: unknown };
    if (typeof group?.quizId !== 'string' || !Array.isArray(group.resources)) continue;

    const items: SourceResource[] = [];
    for (const item of group.resources as readonly unknown[]) {
      const resource = item as { title?: unknown; url?: unknown; host?: unknown };
      if (typeof resource?.title !== 'string' || !resource.title.trim()) continue;
      if (typeof resource?.url !== 'string' || !resource.url.trim()) continue;
      items.push({
        title: resource.title,
        url: resource.url,
        host: typeof resource.host === 'string' ? resource.host : ''
      });
    }
    out.set(group.quizId, items);
  }
  return out;
}

async function importBank(
  client: Queryable,
  quizzes: readonly PrivateQuiz[],
  facts: ReadonlyMap<string, readonly string[]>,
  resources: ReadonlyMap<string, readonly SourceResource[]>
): Promise<ImportSummary> {
  const summary: ImportSummary = {
    quizzes: 0, questions: 0, options: 0, correctOptions: 0, resources: 0
  };

  for (const [quizIndex, quiz] of quizzes.entries()) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO quizzes (quiz_id, milestone, summary, image, difficulty, facts_json, display_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (quiz_id) DO UPDATE SET
         milestone     = EXCLUDED.milestone,
         summary       = EXCLUDED.summary,
         image         = EXCLUDED.image,
         difficulty    = EXCLUDED.difficulty,
         facts_json    = EXCLUDED.facts_json,
         display_order = EXCLUDED.display_order
       RETURNING id`,
      [
        quiz.quizId,
        quiz.milestone,
        quiz.summary,
        quiz.image,
        quiz.difficulty,
        JSON.stringify(facts.get(quiz.quizId) ?? []),
        quizIndex
      ]
    );
    const quizPk = Number(rows[0]!['id']);
    summary.quizzes++;

    // Full replace — see the header note on idempotency.
    await client.query('DELETE FROM questions WHERE quiz_pk = $1', [quizPk]);
    await client.query('DELETE FROM quiz_resources WHERE quiz_pk = $1', [quizPk]);

    // Array order IS the display order; the source has no other ordering key.
    for (const [resourceIndex, resource] of (resources.get(quiz.quizId) ?? []).entries()) {
      await client.query(
        `INSERT INTO quiz_resources (quiz_pk, title, url, host, display_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [quizPk, resource.title, resource.url, resource.host, resourceIndex]
      );
      summary.resources++;
    }

    for (const [questionIndex, question] of quiz.questions.entries()) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO questions
           (quiz_pk, question_text, question_type, explanation, display_order, legacy_question_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          quizPk,
          question.questionText,
          question.type,
          question.explanation,
          questionIndex,
          question.questionId          // provenance: '<quizId>:q:<index>'
        ]
      );
      const questionPk = Number(inserted.rows[0]!['id']);
      summary.questions++;

      for (const [optionIndex, option] of question.options.entries()) {
        await client.query(
          `INSERT INTO options
             (question_pk, option_text, display_order, is_correct, legacy_option_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            questionPk,
            option.text,
            optionIndex,
            option.isCorrect ? 1 : 0,   // explicit 0; the source omits the key
            option.optionId             // provenance: (q+1)*100+(o+1)
          ]
        );
        summary.options++;
        if (option.isCorrect) summary.correctOptions++;
      }
    }
  }

  return summary;
}

/**
 * Read the bank back out and prove it matches what was imported.
 *
 * Compares COUNTS and TEXT round-trip fidelity — the property the public API
 * contract depends on, since Angular addresses questions and options by their
 * exact text.
 */
async function verify(
  db: DatabaseHandle,
  quizzes: readonly PrivateQuiz[]
): Promise<readonly string[]> {
  const problems: string[] = [];

  const counts = await db.query<{ quizzes: number; questions: number; options: number }>(
    `SELECT (SELECT COUNT(*)::int FROM quizzes)  AS quizzes,
            (SELECT COUNT(*)::int FROM questions) AS questions,
            (SELECT COUNT(*)::int FROM options)   AS options`
  );
  const actual = counts.rows[0]!;

  const expectedQuestions = quizzes.reduce((n, q) => n + q.questions.length, 0);
  const expectedOptions = quizzes.reduce(
    (n, q) => n + q.questions.reduce((m, qq) => m + qq.options.length, 0), 0
  );

  if (Number(actual.quizzes) !== quizzes.length) {
    problems.push(`quiz count: expected ${quizzes.length}, found ${actual.quizzes}`);
  }
  if (Number(actual.questions) !== expectedQuestions) {
    problems.push(`question count: expected ${expectedQuestions}, found ${actual.questions}`);
  }
  if (Number(actual.options) !== expectedOptions) {
    problems.push(`option count: expected ${expectedOptions}, found ${actual.options}`);
  }

  // Byte-for-byte text fidelity. This is the contract the API depends on: a
  // client echoes the exact string it received, and lookup must find it.
  for (const quiz of quizzes) {
    const stored = await db.query<{ question_text: string; display_order: number }>(
      `SELECT q.question_text, q.display_order
         FROM questions q JOIN quizzes z ON z.id = q.quiz_pk
        WHERE z.quiz_id = $1
        ORDER BY q.display_order`,
      [quiz.quizId]
    );
    if (stored.rows.length !== quiz.questions.length) {
      problems.push(`${quiz.quizId}: expected ${quiz.questions.length} questions, found ${stored.rows.length}`);
      continue;
    }
    for (const [index, question] of quiz.questions.entries()) {
      if (stored.rows[index]!.question_text !== question.questionText) {
        problems.push(`${quiz.quizId}[${index}]: question text differs after round trip`);
      }
    }
  }

  // Every question must still resolve by its normalized key — the /check path.
  const ambiguous = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT quiz_pk, question_key FROM questions
        GROUP BY quiz_pk, question_key HAVING COUNT(*) > 1
     ) dupes`
  );
  if (Number(ambiguous.rows[0]!['n']) !== 0) {
    problems.push(`${ambiguous.rows[0]!['n']} ambiguous question key(s) — text lookup unsafe`);
  }

  return problems;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  warnIfInsideRepo(args.file);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(args.file), 'utf8'));
  } catch (err: unknown) {
    fail(`could not read ${args.file}: ${(err as Error).message}`);
  }

  // Same validation as the JSON path — nothing can enter the database that the
  // file loader would have rejected.
  const { quizzes } = validateAndNormalize(raw);
  console.log(
    `[import] source validated: ${quizzes.length} quizzes, ` +
    `${quizzes.reduce((n, q) => n + q.questions.length, 0)} questions`
  );

  const db = openDatabase({ databaseUrl: args.databaseUrl });
  try {
    console.log(`[import] target: ${db.describe}`);
    await migrate(db);

    if (args.dryRun) {
      console.log('[import] --dry-run: validated and connected, no rows written');
      return;
    }

    const resources = resourcesByQuizId(raw);

    // A resource group naming a quiz that does not exist cannot be imported —
    // `quiz_resources.quiz_pk` is a foreign key. Reported rather than silently
    // skipped, because the reason it is orphaned is a data bug worth seeing:
    // `TS_Quiz` names a quiz whose real id is `typescript`, and Angular's own
    // lookup (`find(r => r.quizId === quizId)`) has therefore never displayed
    // those links either. Remapping it here would surface content the app has
    // never shown, so it is dropped, not repaired.
    const known = new Set(quizzes.map((quiz) => quiz.quizId));
    for (const [quizId, items] of resources) {
      if (!known.has(quizId)) {
        console.warn(
          `[import] WARNING: resource group "${quizId}" matches no quiz — ` +
          `${items.length} link(s) NOT imported (unreachable in the app today)`
        );
      }
    }

    const summary = await db.transaction((client) =>
      importBank(client, quizzes, factsByQuizId(raw), resources)
    );
    console.log(
      `[import] wrote ${summary.quizzes} quizzes, ${summary.questions} questions, ` +
      `${summary.options} options (${summary.correctOptions} correct), ` +
      `${summary.resources} resources`
    );

    const problems = await verify(db, quizzes);
    if (problems.length > 0) {
      for (const problem of problems) console.error(`[import] VERIFY FAILED: ${problem}`);
      process.exit(1);
    }
    console.log('[import] verified: counts match and every question round-trips exactly');
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => fail((err as Error).message));
