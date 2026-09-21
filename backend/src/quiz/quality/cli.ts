/**
 * The command-line behaviour of the Quiz Bank Quality Validator, as a function.
 *
 * `scripts/validate-quiz-bank.ts` is a thin wrapper that passes in the environment;
 * everything that decides output and exit status lives here so it can be tested
 * without spawning a process or touching a database.
 *
 * EXIT STATUS
 *
 *   0  no ERROR findings (warnings and info do not fail the run)
 *   1  one or more ERROR findings, OR the validator could not run
 *      (missing/invalid configuration, connection failure, read-only refusal, …)
 *
 * OUTPUT SAFETY
 *
 *   The connection string is read from DATABASE_URL only — there is deliberately no
 *   `--database-url` flag, because an argument lands in shell history and process
 *   listings. It is never printed. The database is named as `host/database`
 *   (the same description the importer prints); credentials never appear.
 *   Every error that comes from the driver is passed through `redactSecrets`.
 *   The report itself is built only from counts, rule codes, positions and
 *   rule-written messages, so no row, option text or correctness can appear in it.
 */

import { describeConnection } from '../../db/database';
import { EXIT_FAILED, exitCodeFor, renderReport } from './findings';
import { openReadOnlyDatabase, redactSecrets, type ReadOnlyDatabase } from './read-only-snapshot';
import { runQuizBankValidation } from './validate-quiz-bank';

export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

export interface CliOptions {
  /** DATABASE_URL, as found in the environment. Never printed. */
  readonly databaseUrl: string | undefined;
  readonly io: CliIo;
  /** Injected in tests; defaults to a real read-only connection pool. */
  readonly open?: (databaseUrl: string) => ReadOnlyDatabase;
}

export async function runCli(options: CliOptions): Promise<number> {
  const { io } = options;
  const url = (options.databaseUrl ?? '').trim();

  if (url.length === 0) {
    io.err('[validate] DATABASE_URL is not configured — set it in backend/.env or the environment');
    return EXIT_FAILED;
  }

  let database: ReadOnlyDatabase;
  try {
    database = (options.open ?? openReadOnlyDatabase)(url);
  } catch (err: unknown) {
    io.err(`[validate] cannot open the database: ${redactSecrets(messageOf(err), url)}`);
    return EXIT_FAILED;
  }

  try {
    io.out(`Database: ${describeConnection(url)} (read-only snapshot)`);
    io.out('');

    const report = await runQuizBankValidation(database.source);
    io.out(renderReport(report));
    return exitCodeFor(report);
  } catch (err: unknown) {
    io.err(`[validate] validation could not run: ${redactSecrets(messageOf(err), url)}`);
    return EXIT_FAILED;
  } finally {
    try {
      await database.close();
    } catch {
      // Closing an idle pool must never change the outcome.
    }
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
