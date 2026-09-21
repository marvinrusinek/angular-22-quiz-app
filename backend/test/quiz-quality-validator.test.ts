import { exitCodeFor, formatLocator, renderReport, type QualityReport } from '../src/quiz/quality/findings';
import { runQuizBankValidation } from '../src/quiz/quality/validate-quiz-bank';
import {
  bankFromFixture,
  fakeConnection,
  fakeQuestion,
  fakeQuiz,
  type FakeBank,
  type FakeQuestion
} from './helpers/quality-fake-db';
import fixture from './helpers/synthetic-quiz-bank.json';

/**
 * The whole validator, end to end, over a fake PostgreSQL: read-only snapshot →
 * the application's loader → structural validation → domain and raw rules →
 * sorted report → exit code.
 *
 * Every scenario here is synthetic. Nothing touches a real database, and no test
 * mutates the real bank to create a bad record.
 */

async function validate(bank: FakeBank): Promise<QualityReport> {
  return runQuizBankValidation(fakeConnection(bank).source);
}

const codes = (report: QualityReport): string[] => report.findings.map((f) => f.code);
const where = (report: QualityReport, code: string): string[] =>
  report.findings.filter((f) => f.code === code).map((f) => formatLocator(f.locator));

const good = (text: string, over: Partial<FakeQuestion> = {}): FakeQuestion =>
  fakeQuestion(text, ['alpha', 'beta', 'gamma'], [0], over);

const oneQuiz = (questions: FakeQuestion[], over: Parameters<typeof fakeQuiz>[2] = {}): FakeBank => ({
  quizzes: [fakeQuiz('demo', questions, over)]
});

describe('a clean bank', () => {
  it('the repository\'s own synthetic fixture bank produces ZERO errors and exits successfully', async () => {
    const report = await validate(bankFromFixture(fixture as never));

    expect(report.errorCount).toBe(0);
    expect(exitCodeFor(report)).toBe(0);
    expect(report.counts).toEqual({ quizzes: 7, questions: 66, options: 195 });
  });

  it('…and, today, no warnings either (any that appear are a real finding about the fixture)', async () => {
    const report = await validate(bankFromFixture(fixture as never));

    expect(report.findings).toEqual([]);
    expect(renderReport(report)).toMatch(/Validation passed\.$/);
  });

  it('a minimal single-quiz bank is clean', async () => {
    const report = await validate(oneQuiz([good('Q1?'), good('Q2?'), fakeQuestion('T/F?', ['True', 'False'], [0])]));

    expect(report.findings).toEqual([]);
    expect(report.counts).toEqual({ quizzes: 1, questions: 3, options: 8 });
  });
});

describe('structural failures reach the report as ERRORs, unchanged from the application\'s own rules', () => {
  it.each<[string, () => FakeBank, string]>([
    ['zero correct options', () => oneQuiz([fakeQuestion('Q?', ['a', 'b', 'c'], [])]), 'demo[q0]'],
    ['every option correct', () => oneQuiz([fakeQuestion('Q?', ['a', 'b'], [0, 1])]), 'demo[q0]'],
    ['a single option', () => oneQuiz([fakeQuestion('Q?', ['a'], [0])]), 'demo[q0]'],
    ['a quiz with no questions', () => oneQuiz([]), 'demo'],
    ['duplicate normalized question text', () => oneQuiz([good('Same?'), good('  SAME?  ', { displayOrder: 1 })]), 'demo[q1]'],
    ['an unsupported snippet language', () => oneQuiz([good('Q?', { code: 'x', codeLanguage: 'cobol' })]), 'demo[q0].codeSnippet'],
    ['an oversized snippet', () => oneQuiz([good('Q?', { code: 'x'.repeat(2001), codeLanguage: 'json' })]), 'demo[q0].codeSnippet'],
    ['a snippet filename with a path separator', () => oneQuiz([good('Q?', { code: '{}', codeLanguage: 'json', codeFilename: '../x.json' })]), 'demo[q0].codeSnippet']
  ])('%s', async (_label, bank, locator) => {
    const report = await validate(bank());

    expect(report.errorCount).toBeGreaterThan(0);
    expect(exitCodeFor(report)).toBe(1);
    expect(where(report, 'STRUCTURE')).toContain(locator);
  });

  it('an empty bank is EMPTY_BANK', async () => {
    const report = await validate({ quizzes: [] });

    expect(codes(report)).toEqual(['EMPTY_BANK']);
    expect(exitCodeFor(report)).toBe(1);
  });

  it('a broken quiz does not stop the rest of the bank being checked', async () => {
    const bank: FakeBank = {
      quizzes: [
        fakeQuiz('broken', [fakeQuestion('Q?', ['a', 'b'], [])], { displayOrder: 0 }),
        fakeQuiz('healthy', [good('Q?', { storedType: 'multiple' })], { displayOrder: 1 })
      ]
    };

    const report = await validate(bank);

    expect(codes(report)).toEqual(expect.arrayContaining(['STRUCTURE', 'TYPE_DRIFT', 'DOMAIN_RULES_PARTIAL']));
    expect(where(report, 'TYPE_DRIFT')).toEqual(['healthy[q0].question_type']);
  });
});

describe('raw-data warnings (things the loader hides)', () => {
  it('stored question_type differs from the derived type → WARNING, exit 0', async () => {
    const report = await validate(oneQuiz([good('Q?', { storedType: 'multiple' })]));

    expect(codes(report)).toEqual(['TYPE_DRIFT']);
    expect(report.findings[0]!.severity).toBe('WARNING');
    expect(exitCodeFor(report)).toBe(0);
    expect(report.findings[0]!.message).toBe(
      'stored question_type "multiple" differs from the derived type "single"; the application uses the derived type'
    );
  });

  it('a multi-answer question stored as "single" is the drift the application silently ignores', async () => {
    const report = await validate(oneQuiz([fakeQuestion('Q?', ['a', 'b', 'c'], [0, 1], { storedType: 'single' })]));

    expect(where(report, 'TYPE_DRIFT')).toEqual(['demo[q0].question_type']);
  });

  it.each<[string, string | null, string]>([
    ['invalid JSON', '["one",', 'FACTS_INVALID_JSON'],
    ['not an array', '{"a":1}', 'FACTS_NOT_ARRAY'],
    ['a blank entry', '["ok", "  "]', 'FACTS_BAD_ENTRY'],
    ['a non-string entry', '["ok", 5]', 'FACTS_BAD_ENTRY']
  ])('facts_json — %s → %s (WARNING, exit 0)', async (_label, factsJson, code) => {
    const report = await validate(oneQuiz([good('Q?')], { factsJson }));

    expect(codes(report)).toEqual([code]);
    expect(report.findings[0]!.severity).toBe('WARNING');
    expect(exitCodeFor(report)).toBe(0);
  });

  it('duplicate quizzes.display_order → a WARNING on each quiz that shares it', async () => {
    const report = await validate({
      quizzes: [
        fakeQuiz('one', [good('Q?')], { displayOrder: 3 }),
        fakeQuiz('two', [good('Q?')], { displayOrder: 3 }),
        fakeQuiz('three', [good('Q?')], { displayOrder: 4 })
      ]
    });

    expect(where(report, 'QUIZ_DISPLAY_ORDER_DUPLICATE')).toEqual(['one.display_order', 'two.display_order']);
    expect(exitCodeFor(report)).toBe(0);
  });

  it('code_filename with NULL code → WARNING SNIPPET_ORPHAN_FILENAME', async () => {
    const report = await validate(oneQuiz([good('Q?'), good('Q2?', { codeFilename: 'orphan.ts' })]));

    expect(where(report, 'SNIPPET_ORPHAN_FILENAME')).toEqual(['demo[q1].code_filename']);
    expect(report.errorCount).toBe(0);
  });

  it('question display_order gap → WARNING QUESTION_DISPLAY_ORDER_GAP (never an error)', async () => {
    const report = await validate(oneQuiz([good('Q0?', { displayOrder: 0 }), good('Q1?', { displayOrder: 5 }), good('Q2?', { displayOrder: 6 })]));

    expect(codes(report)).toEqual(['QUESTION_DISPLAY_ORDER_GAP']);
    expect(where(report, 'QUESTION_DISPLAY_ORDER_GAP')).toEqual(['demo[q1].display_order']);
    expect(exitCodeFor(report)).toBe(0);
  });

  it('option display_order gap → WARNING OPTION_DISPLAY_ORDER_GAP', async () => {
    const q = good('Q?');
    q.options[2] = { ...q.options[2]!, displayOrder: 7 };

    const report = await validate(oneQuiz([q]));

    expect(where(report, 'OPTION_DISPLAY_ORDER_GAP')).toEqual(['demo[q0].options[2].display_order']);
  });

  it('retired quizzes are counted, not validated → INFO', async () => {
    const report = await validate({
      quizzes: [
        fakeQuiz('live', [good('Q?')], { displayOrder: 0 }),
        fakeQuiz('old', [fakeQuestion('Broken?', ['a', 'b'], [])], { displayOrder: 1, status: 'retired' })
      ]
    });

    expect(codes(report)).toEqual(['RETIRED_QUIZZES_SKIPPED']);
    expect(report.findings[0]!.severity).toBe('INFO');
    expect(report.errorCount).toBe(0);
    expect(report.counts.quizzes).toBe(1);
  });

  it('two "All of the above" options → WARNING MULTIPLE_ALL_OF_THE_ABOVE', async () => {
    const report = await validate(oneQuiz([fakeQuestion('Q?', ['a', 'All of the above', 'all of the above.'], [0])]));

    expect(codes(report)).toEqual(['MULTIPLE_ALL_OF_THE_ABOVE']);
  });
});

describe('the NFC collision, end to end', () => {
  const NFC = 'café';
  const NFD = 'café';

  it('two OPTIONS that differ only in Unicode composition → ERROR, exit 1', async () => {
    const report = await validate(oneQuiz([fakeQuestion('Which?', [NFC, NFD, 'other'], [0])]));

    expect(codes(report)).toEqual(['AMBIGUOUS_OPTION_MATCH']);
    expect(where(report, 'AMBIGUOUS_OPTION_MATCH')).toEqual(['demo[q0].options[1]']);
    expect(exitCodeFor(report)).toBe(1);
  });

  it('two QUESTIONS that differ only in Unicode composition → ERROR, exit 1', async () => {
    const report = await validate(oneQuiz([good(`${NFC}?`), good(`${NFD}?`, { displayOrder: 1 })]));

    expect(codes(report)).toEqual(['AMBIGUOUS_QUESTION_MATCH']);
    expect(where(report, 'AMBIGUOUS_QUESTION_MATCH')).toEqual(['demo[q1]']);
    expect(exitCodeFor(report)).toBe(1);
  });

  it('the collision passes the database key AND startup validation — only this validator sees it', async () => {
    // Guard against a future change to either that would make this rule redundant or wrong.
    const databaseStyleKey = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

    expect(databaseStyleKey(NFC)).not.toBe(databaseStyleKey(NFD));
  });
});

describe('severity model', () => {
  it('ERRORs sort before WARNINGs before INFO, and only ERRORs fail the run', async () => {
    const report = await validate({
      quizzes: [
        fakeQuiz('a', [fakeQuestion('Which?', ['café', 'café', 'x'], [0], { storedType: 'multiple' })], { displayOrder: 0, factsJson: '{' }),
        fakeQuiz('old', [good('Q?')], { displayOrder: 1, status: 'retired' })
      ]
    });

    expect(report.findings.map((f) => f.severity)).toEqual(['ERROR', 'WARNING', 'WARNING', 'INFO']);
    expect(exitCodeFor(report)).toBe(1);
  });

  it('warnings and info alone never fail the run', async () => {
    const report = await validate({
      quizzes: [
        fakeQuiz('a', [good('Q?', { storedType: 'multiple' })], { displayOrder: 0, factsJson: '{' }),
        fakeQuiz('old', [good('Q?')], { displayOrder: 1, status: 'retired' })
      ]
    });

    expect(report.errorCount).toBe(0);
    expect(report.warningCount + report.infoCount).toBeGreaterThan(0);
    expect(exitCodeFor(report)).toBe(0);
  });
});

describe('determinism', () => {
  const messy = (): FakeBank => ({
    quizzes: [
      fakeQuiz('zeta', [fakeQuestion('Which?', ['café', 'café', 'x'], [0], { storedType: 'trueFalse' })], { displayOrder: 2, factsJson: '[""]' }),
      fakeQuiz('alpha', [good('Q?', { codeFilename: 'a.ts' }), good('R?', { displayOrder: 4 })], { displayOrder: 2, factsJson: 'nope' }),
      fakeQuiz('mid', [fakeQuestion('Z?', ['a', 'b'], [])], { displayOrder: 0 })
    ]
  });

  it('the same bank produces byte-identical output on every run', async () => {
    const a = renderReport(await validate(messy()));
    const b = renderReport(await validate(messy()));

    expect(b).toBe(a);
  });

  it('does not depend on the order quizzes or questions arrive from the database', async () => {
    const forward = messy();
    const reversed: FakeBank = { quizzes: [...messy().quizzes].reverse() };

    expect(renderReport(await validate(reversed))).toBe(renderReport(await validate(forward)));
  });
});

describe('reporting safety, end to end', () => {
  const MARKS = ['ZZ_Q_MARK_11', 'ZZ_RIGHT_MARK_22', 'ZZ_WRONG_MARK_33', 'ZZ_EXPL_MARK_44', 'ZZ_FACT_MARK_55', 'ZZ_FILE_MARK_66.ts'];

  // Two quizzes, so EVERY rule family runs: "alpha" fails structural validation (zero correct
  // option); "beta" is structurally sound and trips the added domain and raw rules.
  const hostile = (): FakeBank => ({
    quizzes: [
      fakeQuiz('alpha', [
        fakeQuestion(`${MARKS[0]} a`, [`${MARKS[2]}-1`, `${MARKS[2]}-2`], [], { explanation: MARKS[3]! })
      ], { displayOrder: 0, factsJson: JSON.stringify([MARKS[4], '']) }),
      fakeQuiz('beta', [
        fakeQuestion(`${MARKS[0]} b`, [`${MARKS[1]}é`, `${MARKS[1]}é`, 'All of the above', 'all of the above'], [0], { explanation: MARKS[3]!, storedType: 'trueFalse', codeFilename: MARKS[5]! })
      ], { displayOrder: 1 })
    ]
  });

  it('no question, option, explanation, fact or filename text appears anywhere in the report', async () => {
    const report = await validate(hostile());
    const text = renderReport(report) + JSON.stringify(report);

    expect(codes(report)).toEqual(expect.arrayContaining(['STRUCTURE', 'FACTS_BAD_ENTRY', 'AMBIGUOUS_OPTION_MATCH', 'MULTIPLE_ALL_OF_THE_ABOVE', 'TYPE_DRIFT', 'SNIPPET_ORPHAN_FILENAME']));
    for (const marker of MARKS) expect(text).not.toContain(marker);
  });

  it('no answer-key data: no correctness flag, no correct-option value or index list', async () => {
    const text = renderReport(await validate(hostile()));

    expect(text).not.toMatch(/is_correct|isCorrect|correctOption|correct_option|"correct"\s*:/i);
  });

  it('the database URL and password cannot appear: the validator is never given them', async () => {
    const connection = fakeConnection(hostile());
    const report = await runQuizBankValidation(connection.source);

    expect(renderReport(report)).not.toMatch(/postgres(ql)?:\/\/|password/i);
  });
});

describe('read-only behaviour, end to end', () => {
  it('a full validation sends only BEGIN READ ONLY, its check, SET LOCAL, SELECTs and ROLLBACK — and never COMMIT or a write', async () => {
    const connection = fakeConnection(bankFromFixture(fixture as never));

    await runQuizBankValidation(connection.source);

    expect(connection.sql[0]).toBe('BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ');
    expect(connection.sql[connection.sql.length - 1]).toBe('ROLLBACK');
    expect(connection.sql.some((s) => /^\s*(insert|update|delete|truncate|create|alter|drop|commit)\b/i.test(s))).toBe(false);
    for (const sql of connection.sql.slice(3, -1)) expect(sql.trim()).toMatch(/^SELECT\b/);
    expect(connection.released()).toBe(1);
  });

  it('a session that is not read-only stops the run before any bank data is read', async () => {
    const connection = fakeConnection(bankFromFixture(fixture as never), { readOnlyState: 'off' });

    await expect(runQuizBankValidation(connection.source)).rejects.toThrow(/not read-only/);

    expect(connection.sql.some((s) => /question_text/.test(s))).toBe(false);
  });
});
