import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { runCli } from '../src/quiz/quality/cli';
import type { ReadOnlyDatabase } from '../src/quiz/quality/read-only-snapshot';
import { fakeConnection, fakeQuestion, fakeQuiz, type FakeBank } from './helpers/quality-fake-db';

/**
 * The CLI contract: output, exit status, and that no secret or answer-key data
 * can appear. `runCli` is exercised with an injected fake database; a few tests
 * also run the real script as a child process against configurations that fail
 * before (or instead of) reaching any database.
 */

const SECRET_URL = 'postgresql://cli_user_x:cli_pass_secret_9@ep-example-host.example.com/quizdb?sslmode=require';

interface Run { code: number; out: string; err: string }

async function run(bank: FakeBank | null, over: { databaseUrl?: string | undefined; failWith?: Error } = {}): Promise<Run & { closed: number; opened: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const opened: string[] = [];
  let closed = 0;

  const code = await runCli({
    databaseUrl: 'databaseUrl' in over ? over.databaseUrl : SECRET_URL,
    io: { out: (t) => out.push(t), err: (t) => err.push(t) },
    open: (url): ReadOnlyDatabase => {
      opened.push(url);
      if (over.failWith) return { source: { connect: async () => { throw over.failWith!; } }, close: async () => { closed++; } };
      return { source: fakeConnection(bank ?? { quizzes: [] }).source, close: async () => { closed++; } };
    }
  });

  return { code, out: out.join('\n'), err: err.join('\n'), closed, opened };
}

const cleanBank = (): FakeBank => ({
  quizzes: [
    fakeQuiz('alpha', [fakeQuestion('One?', ['a', 'b', 'c'], [0]), fakeQuestion('Two?', ['a', 'b', 'c'], [0, 1]), fakeQuestion('Three?', ['True', 'False'], [1])])
  ]
});

const warningBank = (): FakeBank => ({
  quizzes: [fakeQuiz('alpha', [fakeQuestion('One?', ['a', 'b', 'c'], [0], { storedType: 'multiple' })], { factsJson: '{bad' })]
});

const errorBank = (): FakeBank => ({
  quizzes: [fakeQuiz('alpha', [fakeQuestion('Zero correct?', ['a', 'b', 'c'], [])])]
});

describe('exit status', () => {
  it('0 for a clean bank, and says so', async () => {
    const r = await run(cleanBank());

    expect(r.code).toBe(0);
    expect(r.out).toContain('Quiz Bank Quality Report');
    expect(r.out).toMatch(/Quizzes:\s+1/);
    expect(r.out).toMatch(/Questions:\s+3/);
    expect(r.out).toMatch(/Errors:\s+0/);
    expect(r.out).toMatch(/Validation passed\.$/);
    expect(r.err).toBe('');
  });

  it('0 for WARNINGS only — and lists them', async () => {
    const r = await run(warningBank());

    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Warnings:\s+2/);
    expect(r.out).toContain('WARNING TYPE_DRIFT [alpha[q0].question_type]');
    expect(r.out).toContain('WARNING FACTS_INVALID_JSON [alpha.facts_json]');
    expect(r.out).toMatch(/Validation completed with warnings\.$/);
  });

  it('1 when there is any ERROR', async () => {
    const r = await run(errorBank());

    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Errors:\s+1/);
    expect(r.out).toContain('ERROR STRUCTURE [alpha[q0]]');
    expect(r.out).toMatch(/Validation failed: 1 error\(s\)\.$/);
  });

  it('1 for an empty bank (the application would refuse to start)', async () => {
    const r = await run({ quizzes: [] });

    expect(r.code).toBe(1);
    expect(r.out).toContain('ERROR EMPTY_BANK [(bank)]');
  });

  it('1 when the validator itself cannot run (a connection failure), reported on stderr', async () => {
    const r = await run(null, { failWith: new Error('connect ECONNREFUSED 127.0.0.1:5432') });

    expect(r.code).toBe(1);
    expect(r.err).toContain('validation could not run');
    expect(r.err).toContain('ECONNREFUSED');
  });

  it('1 when DATABASE_URL is missing or blank — without opening anything', async () => {
    for (const databaseUrl of [undefined, '', '   ']) {
      const r = await run(cleanBank(), { databaseUrl });

      expect(r.code).toBe(1);
      expect(r.err).toContain('DATABASE_URL is not configured');
      expect(r.opened).toEqual([]);
    }
  });

  it('closes the database whatever the outcome', async () => {
    expect((await run(cleanBank())).closed).toBe(1);
    expect((await run(errorBank())).closed).toBe(1);
    expect((await run(null, { failWith: new Error('boom') })).closed).toBe(1);
  });

  it('1 when opening the database throws, without leaking the URL', async () => {
    const out: string[] = [];
    const err: string[] = [];

    const code = await runCli({
      databaseUrl: SECRET_URL,
      io: { out: (t) => out.push(t), err: (t) => err.push(t) },
      open: () => { throw new Error(`bad url ${SECRET_URL}`); }
    });

    expect(code).toBe(1);
    expect(err.join('\n')).not.toContain('cli_pass_secret_9');
    expect(err.join('\n')).not.toContain('cli_user_x');
  });
});

describe('what the output never contains', () => {
  const HOSTILE_MARKERS = ['ZZ_QUESTION_MARK_5', 'ZZ_CORRECT_MARK_6', 'ZZ_WRONG_MARK_7', 'ZZ_EXPLANATION_MARK_8'];

  // Errors AND warnings AND ambiguity, all with marker text in every content field.
  const hostileBank = (): FakeBank => ({
    quizzes: [
      fakeQuiz('alpha', [
        fakeQuestion(`${HOSTILE_MARKERS[0]} zero`, [`${HOSTILE_MARKERS[2]}-a`, `${HOSTILE_MARKERS[2]}-b`], [], { explanation: HOSTILE_MARKERS[3]! }),
        fakeQuestion(`${HOSTILE_MARKERS[0]} ambiguity`, [`${HOSTILE_MARKERS[1]}é`, `${HOSTILE_MARKERS[1]}é`, 'other'], [0], { storedType: 'multiple', explanation: HOSTILE_MARKERS[3]!, code: null, codeFilename: 'orphan.ts' })
      ], { factsJson: '[""]' })
    ]
  });

  it('no question, option, explanation or answer text — in the report or on stderr', async () => {
    const r = await run(hostileBank());
    const all = r.out + r.err;

    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Errors:\s+[1-9]/);
    for (const marker of HOSTILE_MARKERS) expect(all).not.toContain(marker);
    expect(all).not.toContain('orphan.ts');
  });

  it('no answer-key vocabulary or values: no is_correct, no correct-option lists', async () => {
    const r = await run(hostileBank());

    expect(r.out + r.err).not.toMatch(/is_correct|isCorrect|correctOption|correct_option|"correct"\s*:/i);
  });

  it('no credentials or connection string', async () => {
    const r = await run(cleanBank());
    const all = r.out + r.err;

    expect(all).not.toContain('cli_pass_secret_9');
    expect(all).not.toContain('cli_user_x');
    expect(all).not.toContain(SECRET_URL);
    expect(all).not.toContain('postgresql://');
  });

  it('names the database as host/database only', async () => {
    const r = await run(cleanBank());

    expect(r.out.split('\n')[0]).toBe('Database: ep-example-host.example.com/quizdb (read-only snapshot)');
  });

  it('driver errors are redacted before printing', async () => {
    const r = await run(null, { failWith: new Error(`password authentication failed for user "cli_user_x" (cli_pass_secret_9) at ${SECRET_URL}`) });

    expect(r.code).toBe(1);
    expect(r.err).not.toContain('cli_pass_secret_9');
    expect(r.err).not.toContain('cli_user_x');
    expect(r.err).toContain('[REDACTED]');
  });
});

describe('the real script (child process) — configurations that fail before reaching any database', () => {
  const backendDir = join(__dirname, '..');
  const runScript = (env: Record<string, string>, args: string[] = []) => {
    const result = spawnSync(
      process.execPath,
      ['--require', 'ts-node/register', 'scripts/validate-quiz-bank.ts', ...args],
      // A minimal environment: it must not inherit the developer's real DATABASE_URL.
      { cwd: backendDir, env: { PATH: process.env['PATH'] ?? '', SystemRoot: process.env['SystemRoot'] ?? '', ...env }, encoding: 'utf8', timeout: 120_000 }
    );
    return { code: result.status, out: `${result.stdout}`, err: `${result.stderr}`, all: `${result.stdout}${result.stderr}` };
  };

  it('exits 1 with a clear message when DATABASE_URL is not set', () => {
    const r = runScript({});

    expect(r.code).toBe(1);
    expect(r.err).toContain('DATABASE_URL is not configured');
  });

  it('exits 1 for a non-postgres URL, without echoing it', () => {
    const r = runScript({ DATABASE_URL: 'mysql://cli_user_x:cli_pass_secret_9@somewhere/db' });

    expect(r.code).toBe(1);
    expect(r.all).not.toContain('cli_pass_secret_9');
    expect(r.all).not.toContain('mysql://');
  });

  it('exits 1 on a connection failure and prints no credential (a closed LOCAL port — nothing external is contacted)', () => {
    const r = runScript({ DATABASE_URL: 'postgresql://cli_user_x:cli_pass_secret_9@127.0.0.1:1/quizdb' });

    expect(r.code).toBe(1);
    expect(r.all).toContain('validation could not run');
    expect(r.all).not.toContain('cli_pass_secret_9');
    expect(r.all).not.toContain('cli_user_x');
  });

  it('rejects an unknown argument — in particular there is no way to pass a URL on the command line', () => {
    const r = runScript({ DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/db' }, ['--database-url', 'postgresql://x:y@h/d']);

    expect(r.code).toBe(1);
    expect(r.err).toContain('unknown argument');
    expect(r.all).not.toContain('postgresql://x:y@h/d');
  });

  it('--help exits 0 and prints usage', () => {
    const r = runScript({}, ['--help']);

    expect(r.code).toBe(0);
    expect(r.out).toContain('usage: npm run validate:quiz-bank');
  });
});
