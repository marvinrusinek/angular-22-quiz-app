import {
  RAW_OPTIONS_SQL,
  RAW_QUESTIONS_SQL,
  RAW_QUIZZES_SQL,
  RAW_STATEMENTS,
  RETIRED_COUNT_SQL,
  mapRawRows,
  readBankSnapshot
} from '../src/quiz/quality/bank-snapshot';
import {
  READ_ONLY_BEGIN,
  READ_ONLY_CHECK,
  ROLLBACK,
  STATEMENT_TIMEOUT,
  assertSelectOnly,
  withReadOnlySnapshot
} from '../src/quiz/quality/read-only-snapshot';
import { validateQuizBank, runQuizBankValidation } from '../src/quiz/quality/validate-quiz-bank';
import { exitCodeFor } from '../src/quiz/quality/findings';
import { fakeConnection, fakeQuestion, fakeQuiz } from './helpers/quality-fake-db';

/**
 * Data access: which SQL the validator sends, how rows become the raw model, and
 * that everything runs inside the read-only snapshot. No real database.
 */

const twoQuizBank = () => ({
  quizzes: [
    fakeQuiz('alpha', [
      fakeQuestion('A one?', ['x', 'y', 'z'], [0]),
      fakeQuestion('A two?', ['x', 'y', 'z'], [0, 1])
    ], { displayOrder: 0 }),
    fakeQuiz('beta', [fakeQuestion('B one?', ['True', 'False'], [0])], { displayOrder: 1 })
  ]
});

describe('the validator\'s own SQL', () => {
  it.each(RAW_STATEMENTS.map((sql, i) => [i, sql] as const))('statement %i is a plain SELECT the guard accepts', (_i, sql) => {
    expect(() => assertSelectOnly(sql)).not.toThrow();
  });

  it('sends exactly four raw statements', () => {
    expect(RAW_STATEMENTS).toEqual([RAW_QUIZZES_SQL, RETIRED_COUNT_SQL, RAW_QUESTIONS_SQL, RAW_OPTIONS_SQL]);
  });

  it('never selects question text, option text, explanations or the answer key', () => {
    for (const sql of RAW_STATEMENTS) {
      expect(sql).not.toMatch(/question_text|option_text|explanation|is_correct/i);
      expect(sql).not.toMatch(/\bq\.code\s*,|\bcode\s+FROM/i);   // the snippet text itself is not read either
    }
  });

  it('touches only the quiz-bank tables — no interview, session, attempt or history table', () => {
    for (const sql of RAW_STATEMENTS) {
      const tables = [...sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/gi)].map((m) => m[1]!.toLowerCase());

      expect(tables.length).toBeGreaterThan(0);
      for (const table of tables) expect(['quizzes', 'questions', 'options']).toContain(table);
      expect(sql).not.toMatch(/interview|session|attempt|history|resource/i);
    }
  });

  it('reads active quizzes only (plus a count of retired ones)', () => {
    for (const sql of [RAW_QUIZZES_SQL, RAW_QUESTIONS_SQL, RAW_OPTIONS_SQL]) expect(sql).toContain("status = 'active'");
    expect(RETIRED_COUNT_SQL).toContain("status = 'retired'");
  });

  it('every statement has a deterministic ORDER BY (quiz order, then id, then position)', () => {
    for (const sql of [RAW_QUIZZES_SQL, RAW_QUESTIONS_SQL, RAW_OPTIONS_SQL]) expect(sql).toMatch(/ORDER BY/);
    expect(RAW_QUESTIONS_SQL).toMatch(/ORDER BY z\.display_order, z\.quiz_id, q\.display_order/);
  });
});

describe('mapRawRows', () => {
  it('maps quiz, question and option rows and counts retired quizzes', () => {
    const raw = mapRawRows(
      [{ quiz_id: 'a', display_order: 0, facts_json: '[]' }],
      2,
      [
        { quiz_id: 'a', display_order: 0, question_type: 'single', has_code: false, code_filename: null },
        { quiz_id: 'a', display_order: 1, question_type: 'multiple', has_code: true, code_filename: 'x.ts' }
      ],
      [{ quiz_id: 'a', question_order: 1, display_order: 0 }]
    );

    expect(raw.quizzes).toEqual([{ quizId: 'a', displayOrder: 0, factsJson: '[]' }]);
    expect(raw.questions).toEqual([
      { quizId: 'a', displayOrder: 0, storedType: 'single', hasCode: false, codeFilename: null },
      { quizId: 'a', displayOrder: 1, storedType: 'multiple', hasCode: true, codeFilename: 'x.ts' }
    ]);
    expect(raw.options).toEqual([{ quizId: 'a', questionIndex: 1, displayOrder: 0 }]);
    expect(raw.retiredQuizCount).toBe(2);
  });

  it('re-keys option rows by the question\'s RANK, not its display_order VALUE (so gaps do not break the link)', () => {
    const raw = mapRawRows(
      [{ quiz_id: 'a', display_order: 0, facts_json: '[]' }],
      0,
      [
        { quiz_id: 'a', display_order: 4, question_type: 'single', has_code: false, code_filename: null },
        { quiz_id: 'a', display_order: 9, question_type: 'single', has_code: false, code_filename: null }
      ],
      [
        { quiz_id: 'a', question_order: 4, display_order: 0 },
        { quiz_id: 'a', question_order: 9, display_order: 0 }
      ]
    );

    expect(raw.options.map((o) => o.questionIndex)).toEqual([0, 1]);
  });

  it('ranks are per quiz: the same question display_order in two quizzes does not collide', () => {
    const raw = mapRawRows(
      [{ quiz_id: 'a', display_order: 0, facts_json: '[]' }, { quiz_id: 'b', display_order: 1, facts_json: '[]' }],
      0,
      [
        { quiz_id: 'a', display_order: 0, question_type: 'single', has_code: false, code_filename: null },
        { quiz_id: 'b', display_order: 0, question_type: 'single', has_code: false, code_filename: null },
        { quiz_id: 'b', display_order: 1, question_type: 'single', has_code: false, code_filename: null }
      ],
      [{ quiz_id: 'b', question_order: 1, display_order: 0 }]
    );

    expect(raw.options).toEqual([{ quizId: 'b', questionIndex: 1, displayOrder: 0 }]);
  });

  it('throws when an option row points at a question the snapshot does not contain', () => {
    expect(() =>
      mapRawRows([{ quiz_id: 'a', display_order: 0, facts_json: '[]' }], 0, [], [{ quiz_id: 'a', question_order: 0, display_order: 0 }])
    ).toThrow(/does not contain/);
  });

  it('converts numeric strings the driver may return', () => {
    const raw = mapRawRows(
      [{ quiz_id: 'a', display_order: '3' as unknown as number, facts_json: null }],
      '1' as unknown as number,
      [],
      []
    );

    expect(raw.quizzes[0]!.displayOrder).toBe(3);
    expect(raw.retiredQuizCount).toBe(1);
  });
});

describe('readBankSnapshot', () => {
  it('returns the application\'s own loader output plus the raw model, from one connection', async () => {
    const connection = fakeConnection(twoQuizBank());

    const snapshot = await withReadOnlySnapshot(connection.source, readBankSnapshot);

    expect((snapshot.source.quizzes as { quizId: string }[]).map((q) => q.quizId)).toEqual(['alpha', 'beta']);
    expect(snapshot.raw.quizzes.map((q) => q.quizId)).toEqual(['alpha', 'beta']);
    expect(snapshot.raw.questions).toHaveLength(3);
    expect(snapshot.raw.options).toHaveLength(8);
    expect(connection.released()).toBe(1);
  });

  it('reproduces the loader shape: correct:true only on correct options, key omitted otherwise', async () => {
    const snapshot = await withReadOnlySnapshot(fakeConnection(twoQuizBank()).source, readBankSnapshot);
    const first = ((snapshot.source.quizzes as { questions: { options: unknown[] }[] }[])[0]!).questions[0]!;

    expect(first.options).toEqual([{ text: 'x', correct: true }, { text: 'y' }, { text: 'z' }]);
  });

  it('sends ONLY read-only statements, all inside BEGIN READ ONLY … ROLLBACK', async () => {
    const connection = fakeConnection(twoQuizBank());

    await withReadOnlySnapshot(connection.source, readBankSnapshot);

    expect(connection.sql[0]).toBe(READ_ONLY_BEGIN);
    expect(connection.sql[connection.sql.length - 1]).toBe(ROLLBACK);
    const work = connection.sql.filter((s) => ![READ_ONLY_BEGIN, READ_ONLY_CHECK, STATEMENT_TIMEOUT, ROLLBACK].includes(s));
    expect(work.length).toBe(7);                                   // 4 raw + the application loader's 3
    for (const sql of work) expect(() => assertSelectOnly(sql)).not.toThrow();   // INCLUDING the loader's own SQL
    expect(connection.sql.some((s) => /\b(insert|update|delete|commit)\b/i.test(s))).toBe(false);
  });

  it('touches no session, attempt, interview or history table — even in the loader\'s SQL', async () => {
    const connection = fakeConnection(twoQuizBank());

    await withReadOnlySnapshot(connection.source, readBankSnapshot);

    for (const sql of connection.sql) expect(sql).not.toMatch(/interview_|session_|attempt|history/i);
  });

  it('counts retired quizzes and never reads their questions', async () => {
    const bank = twoQuizBank();
    bank.quizzes.push(fakeQuiz('old', [fakeQuestion('Old?', ['a', 'b'], [0])], { displayOrder: 2, status: 'retired' }));

    const snapshot = await withReadOnlySnapshot(fakeConnection(bank).source, readBankSnapshot);

    expect(snapshot.raw.retiredQuizCount).toBe(1);
    expect(snapshot.raw.quizzes.map((q) => q.quizId)).not.toContain('old');
    expect(snapshot.raw.questions.map((q) => q.quizId)).not.toContain('old');
  });

  it('an EMPTY bank does not crash: the application loader is simply not asked to load nothing', async () => {
    const connection = fakeConnection({ quizzes: [] });

    const snapshot = await withReadOnlySnapshot(connection.source, readBankSnapshot);

    expect(snapshot.source).toEqual({ quizzes: [] });
    expect(connection.sql.filter((s) => /question_text/.test(s))).toEqual([]);
  });
});

describe('validateQuizBank / runQuizBankValidation', () => {
  it('an empty bank is one EMPTY_BANK error', async () => {
    const report = await runQuizBankValidation(fakeConnection({ quizzes: [] }).source);

    expect(report.findings.map((f) => f.code)).toEqual(['EMPTY_BANK']);
    expect(exitCodeFor(report)).toBe(1);
    expect(report.counts).toEqual({ quizzes: 0, questions: 0, options: 0 });
  });

  it('an empty bank with retired quizzes also notes them', async () => {
    const report = await runQuizBankValidation(
      fakeConnection({ quizzes: [fakeQuiz('old', [fakeQuestion('Q?', ['a', 'b'], [0])], { status: 'retired' })] }).source
    );

    expect(report.findings.map((f) => f.code)).toEqual(['EMPTY_BANK', 'RETIRED_QUIZZES_SKIPPED']);
  });

  it('counts come from the rows read: quizzes, questions, options', async () => {
    const report = await runQuizBankValidation(fakeConnection(twoQuizBank()).source);

    expect(report.counts).toEqual({ quizzes: 2, questions: 3, options: 8 });
  });

  it('runs the whole read inside the read-only snapshot and rolls back', async () => {
    const connection = fakeConnection(twoQuizBank());

    await runQuizBankValidation(connection.source);

    expect(connection.sql[0]).toBe(READ_ONLY_BEGIN);
    expect(connection.sql[connection.sql.length - 1]).toBe(ROLLBACK);
    expect(connection.released()).toBe(1);
  });

  it('refuses to run at all if the session does not report read-only — and reads no data', async () => {
    const connection = fakeConnection(twoQuizBank(), { readOnlyState: 'off' });

    await expect(runQuizBankValidation(connection.source)).rejects.toThrow(/not read-only/);

    expect(connection.sql.some((s) => /question_text|display_order/.test(s))).toBe(false);
  });

  it('is deterministic: two runs over the same bank give the identical report', async () => {
    const a = await runQuizBankValidation(fakeConnection(twoQuizBank()).source);
    const b = await runQuizBankValidation(fakeConnection(twoQuizBank()).source);

    expect(b).toEqual(a);
  });

  it('validateQuizBank is pure: it needs no connection', async () => {
    const snapshot = await withReadOnlySnapshot(fakeConnection(twoQuizBank()).source, readBankSnapshot);

    expect(validateQuizBank(snapshot).errorCount).toBe(0);
  });
});
