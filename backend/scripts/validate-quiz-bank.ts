/**
 * Quiz Bank Quality Validator — developer tooling.
 *
 *   npm run validate:quiz-bank
 *
 * READ ONLY. Reads the quiz bank from PostgreSQL inside a single read-only
 * transaction, validates it, prints a report and exits 0 (no errors) or 1 (errors,
 * or the validator could not run). It never writes, repairs or migrates anything,
 * and it is not part of the application: there is no endpoint, no import, no
 * startup hook.
 *
 * DATABASE_URL comes from the environment / backend/.env (the same variable the
 * server uses). There is deliberately no flag for it. See
 * src/quiz/quality/cli.ts for the full output and exit-status contract.
 */

import { runCli } from '../src/quiz/quality/cli';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log('usage: npm run validate:quiz-bank');
  console.log('Reads DATABASE_URL from the environment. Read-only. Exit 0 = no errors, 1 = errors or could not run.');
  process.exit(0);
}

if (args.length > 0) {
  console.error(`[validate] unknown argument: ${args[0]}`);
  process.exit(1);
}

runCli({
  databaseUrl: process.env['DATABASE_URL'],
  io: {
    out: (text) => console.log(text),
    err: (text) => console.error(text)
  }
}).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    // runCli reports its own failures; reaching here means a bug in it. Say so without any detail.
    console.error('[validate] unexpected failure');
    process.exitCode = 1;
  }
);
