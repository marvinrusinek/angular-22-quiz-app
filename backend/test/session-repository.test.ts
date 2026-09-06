import { migrate } from '../src/db/migrate';
import {
  parseSelectedOptionIds,
  SessionRepositoryError
} from '../src/interview/session.repository';
import {
  CLOCK, memoryDb, question, reopen, sessionInput, type TestDb
} from './helpers/db';

let ctx: TestDb;

beforeEach(async () => { ctx = await memoryDb(); });
afterEach(() => ctx.handle.close());

/** Raw SQL, for asserting the SCHEMA rejects what the repository never sends. */
const raw = (sql: string, params: readonly unknown[] = []) => ctx.handle.query(sql, params);

async function countRows(table: string): Promise<number> {
  const { rows } = await ctx.handle.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM ${table}`
  );
  return Number(rows[0]!['n']);
}

// Constraint-violation wording shared by pg-mem and real Postgres. Asserted as
// text rather than SQLSTATE because pg-mem populates `code` for unique
// violations only.
const CHECK_VIOLATION = /check constraint/i;
const FOREIGN_KEY_VIOLATION = /foreign key constraint/i;
const UNIQUE_VIOLATION = /duplicate key|unique constraint|primary key/i;

describe('atomic session creation', () => {
  it('creates the session, its questions and its options in one go', async () => {
    const record = await ctx.repo.createSessionSnapshot(sessionInput());

    expect(record.id).toBe('sess_1');
    expect(record.status).toBe('active');
    expect(record.submittedAt).toBeNull();
    expect(record.submittedByExpiry).toBe(false);
    expect(record.result).toBeNull();
    expect(record.config.topicIds).toEqual(['rxjs']);

    const snapshot = (await ctx.repo.getSessionSnapshot('sess_1'))!;
    expect(snapshot.questions).toHaveLength(1);
    expect(snapshot.questions[0]!.options).toHaveLength(2);
  });

  it('ROLLS BACK entirely when an option fails partway through', async () => {
    // Two questions; the SECOND has a duplicate display order, which the
    // schema rejects — so the first question's rows must disappear too.
    const bad = sessionInput({
      questions: [
        question(),
        question({
          position: 1,
          questionId: 'rxjs:q:1',
          options: [
            { optionId: 201, text: 'a', displayOrder: 0, isCorrect: true },
            { optionId: 202, text: 'b', displayOrder: 0, isCorrect: false }
          ]
        })
      ]
    });

    await expect(ctx.repo.createSessionSnapshot(bad)).rejects.toThrow(SessionRepositoryError);

    expect(await ctx.repo.getSessionById('sess_1')).toBeNull();
    expect(await countRows('session_questions')).toBe(0);
    expect(await countRows('session_options')).toBe(0);
  });

  it('rejects a duplicate session id', async () => {
    await ctx.repo.createSessionSnapshot(sessionInput());
    await expect(ctx.repo.createSessionSnapshot(sessionInput({ attemptId: 'att_2' })))
      .rejects.toThrow(/uniqueness/i);
  });

  it('rejects a duplicate attempt id', async () => {
    await ctx.repo.createSessionSnapshot(sessionInput());
    await expect(ctx.repo.createSessionSnapshot(sessionInput({ id: 'sess_2' })))
      .rejects.toThrow(/uniqueness/i);
  });

  it('rejects a session with no questions', async () => {
    await expect(ctx.repo.createSessionSnapshot(sessionInput({ questions: [] })))
      .rejects.toThrow(/at least one question/i);
  });

  it('rejects duplicate question positions', async () => {
    const input = sessionInput({
      questions: [question(), question({ questionId: 'rxjs:q:1' })]   // both position 0
    });
    await expect(ctx.repo.createSessionSnapshot(input))
      .rejects.toThrow(/duplicate question position/i);
  });

  it('rejects a duplicate question id within the session', async () => {
    const input = sessionInput({ questions: [question(), question({ position: 1 })] });
    await expect(ctx.repo.createSessionSnapshot(input))
      .rejects.toThrow(/duplicate question id/i);
  });

  it('rejects a duplicate option id within one question', async () => {
    const input = sessionInput({
      questions: [question({
        options: [
          { optionId: 401, text: 'a', displayOrder: 0, isCorrect: true },
          { optionId: 401, text: 'b', displayOrder: 1, isCorrect: false }
        ]
      })]
    });
    await expect(ctx.repo.createSessionSnapshot(input))
      .rejects.toThrow(/duplicate option id/i);
  });

  it('rejects non-contiguous question positions', async () => {
    const input = sessionInput({
      questions: [question(), question({ position: 5, questionId: 'rxjs:q:5' })]
    });
    await expect(ctx.repo.createSessionSnapshot(input)).rejects.toThrow(/contiguous/i);
  });
});

describe('code snippets (session-questions persistence)', () => {
  const SNIPPET = { language: 'typescript' as const, code: 'const x = 1;', filename: 'x.ts' };

  it('defaults to no snippet', async () => {
    await ctx.repo.createSessionSnapshot(sessionInput());
    const snapshot = (await ctx.repo.getSessionSnapshot('sess_1'))!;
    expect(snapshot.questions[0]!.codeSnippet).toBeUndefined();
  });

  it('persists and round-trips a snippet through session creation and hydration', async () => {
    await ctx.repo.createSessionSnapshot(sessionInput({
      questions: [question({ codeSnippet: SNIPPET })]
    }));
    const snapshot = (await ctx.repo.getSessionSnapshot('sess_1'))!;
    expect(snapshot.questions[0]!.codeSnippet).toEqual(SNIPPET);
  });

  it('filename is optional on the snippet', async () => {
    await ctx.repo.createSessionSnapshot(sessionInput({
      questions: [question({ codeSnippet: { language: 'json', code: '{}' } })]
    }));
    const snapshot = (await ctx.repo.getSessionSnapshot('sess_1'))!;
    expect(snapshot.questions[0]!.codeSnippet).toEqual({ language: 'json', code: '{}' });
  });

  it('persists across a rebuilt repository over the same database', async () => {
    await ctx.repo.createSessionSnapshot(sessionInput({
      questions: [question({ codeSnippet: SNIPPET })]
    }));
    const reopened = reopen(ctx.handle);
    const snapshot = (await reopened.repo.getSessionSnapshot('sess_1'))!;
    expect(snapshot.questions[0]!.codeSnippet).toEqual(SNIPPET);
  });

  it('flows into the FROZEN result at finalization, never affecting scoring', async () => {
    await ctx.repo.createSessionSnapshot(sessionInput({
      questions: [question({ codeSnippet: SNIPPET })]
    }));
    const result = await ctx.repo.finalizeSession({
      sessionId: 'sess_1', now: CLOCK.CREATED_AT, topicTitleFor: () => 'RxJS'
    });
    expect(result.review[0]!.codeSnippet).toEqual(SNIPPET);
    expect(result.unanswered).toBe(1);
    expect(result.correct).toBe(0);
  });

  it('the schema requires a language whenever code is present', async () => {
    await ctx.repo.createSessionSnapshot(sessionInput());
    await expect(raw(
      `UPDATE session_questions SET code = 'const x = 1;' WHERE session_id = 'sess_1' AND position = 0`
    )).rejects.toThrow(CHECK_VIOLATION);
  });

  it('the schema rejects an unsupported language', async () => {
    await ctx.repo.createSessionSnapshot(sessionInput());
    await expect(raw(
      `UPDATE session_questions SET code = 'x = 1', code_language = 'python'
       WHERE session_id = 'sess_1' AND position = 0`
    )).rejects.toThrow(CHECK_VIOLATION);
  });
});

describe('setFlagged (Mark for Review persistence)', () => {
  it('defaults every question to unflagged', async () => {
    await ctx.repo.createSessionSnapshot(sessionInput());
    const snapshot = (await ctx.repo.getSessionSnapshot('sess_1'))!;
    expect(snapshot.questions[0]!.flagged).toBe(false);
  });

  it('sets the flag on an UNANSWERED question without creating an answer row', async () => {
    await ctx.repo.createSessionSnapshot(sessionInput());
    const result = await ctx.repo.setFlagged({
      sessionId: 'sess_1', questionId: 'rxjs:q:0', flagged: true, now: CLOCK.CREATED_AT
    });

    expect(result).toEqual({ questionId: 'rxjs:q:0', flagged: true });
    expect((await ctx.repo.getSessionSnapshot('sess_1'))!.questions[0]!.flagged).toBe(true);
    expect(await countRows('session_answers')).toBe(0);
  });

  it('clears the flag', async () => {
    await ctx.repo.createSessionSnapshot(sessionInput());
    await ctx.repo.setFlagged({
      sessionId: 'sess_1', questionId: 'rxjs:q:0', flagged: true, now: CLOCK.CREATED_AT
    });
    await ctx.repo.setFlagged({
      sessionId: 'sess_1', questionId: 'rxjs:q:0', flagged: false, now: CLOCK.CREATED_AT
    });
    expect((await ctx.repo.getSessionSnapshot('sess_1'))!.questions[0]!.flagged).toBe(false);
  });

  it('persists across a rebuilt repository over the same database', async () => {
    await ctx.repo.createSessionSnapshot(sessionInput());
    await ctx.repo.setFlagged({
      sessionId: 'sess_1', questionId: 'rxjs:q:0', flagged: true, now: CLOCK.CREATED_AT
    });

    const reopened = reopen(ctx.handle);
    expect((await reopened.repo.getSessionSnapshot('sess_1'))!.questions[0]!.flagged).toBe(true);
  });

  it('rejects an unknown session', async () => {
    await expect(ctx.repo.setFlagged({
      sessionId: 'nope', questionId: 'rxjs:q:0', flagged: true, now: CLOCK.CREATED_AT
    })).rejects.toThrow(SessionRepositoryError);
  });

  it('rejects a question that does not belong to the session', async () => {
    await ctx.repo.createSessionSnapshot(sessionInput());
    await expect(ctx.repo.setFlagged({
      sessionId: 'sess_1', questionId: 'rxjs:q:99', flagged: true, now: CLOCK.CREATED_AT
    })).rejects.toThrow(SessionRepositoryError);
  });

  it('rejects once the deadline has passed, and marks the session expired', async () => {
    await ctx.repo.createSessionSnapshot(sessionInput());
    const afterDeadline = CLOCK.CREATED_AT + CLOCK.HOUR_MS;

    await expect(ctx.repo.setFlagged({
      sessionId: 'sess_1', questionId: 'rxjs:q:0', flagged: true, now: afterDeadline
    })).rejects.toThrow(SessionRepositoryError);

    expect((await ctx.repo.getSessionById('sess_1'))!.status).toBe('expired');
  });

  it('rejects once the session is submitted', async () => {
    await ctx.repo.createSessionSnapshot(sessionInput());
    await ctx.repo.finalizeSession({
      sessionId: 'sess_1', now: CLOCK.CREATED_AT, topicTitleFor: () => 'RxJS'
    });

    await expect(ctx.repo.setFlagged({
      sessionId: 'sess_1', questionId: 'rxjs:q:0', flagged: true, now: CLOCK.CREATED_AT
    })).rejects.toThrow(SessionRepositoryError);
  });

  it('the persisted column is exactly 0 or 1 — never anything else', async () => {
    await ctx.repo.createSessionSnapshot(sessionInput());
    await ctx.repo.setFlagged({
      sessionId: 'sess_1', questionId: 'rxjs:q:0', flagged: true, now: CLOCK.CREATED_AT
    });
    const { rows } = await raw(
      'SELECT flagged FROM session_questions WHERE session_id = $1 AND position = 0', ['sess_1']
    );
    expect(Number((rows as { flagged: number }[])[0]!.flagged)).toBe(1);
  });

  it('flows into the FROZEN result at finalization, without affecting scoring', async () => {
    await ctx.repo.createSessionSnapshot(sessionInput());
    await ctx.repo.setFlagged({
      sessionId: 'sess_1', questionId: 'rxjs:q:0', flagged: true, now: CLOCK.CREATED_AT
    });

    const result = await ctx.repo.finalizeSession({
      sessionId: 'sess_1', now: CLOCK.CREATED_AT, topicTitleFor: () => 'RxJS'
    });

    expect(result.review[0]!.flagged).toBe(true);
    expect(result.answered).toBe(0);
    expect(result.unanswered).toBe(1);
    expect(result.correct).toBe(0);
  });
});

describe('schema constraints', () => {
  function rawInsertSession(overrides: Record<string, unknown> = {}): Promise<unknown> {
    const row = {
      id: 'raw_1', token_hash: 'h', status: 'active',
      config_json: '{"difficulty":"mixed","topicIds":["rxjs"],"questionCount":1}',
      duration_seconds: 900, created_at: CLOCK.CREATED_AT,
      expires_at: CLOCK.CREATED_AT + CLOCK.HOUR_MS,
      submitted_at: null, submitted_by_expiry: 0, result_json: null, attempt_id: 'raw_att_1',
      ...overrides
    };
    return raw(
      `INSERT INTO interview_sessions
         (id, token_hash, status, config_json, duration_seconds, created_at, expires_at,
          submitted_at, submitted_by_expiry, result_json, attempt_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        row.id, row.token_hash, row.status, row.config_json, row.duration_seconds,
        row.created_at, row.expires_at, row.submitted_at, row.submitted_by_expiry,
        row.result_json, row.attempt_id
      ]
    );
  }

  it('rejects an invalid status', async () => {
    await expect(rawInsertSession({ status: 'paused' })).rejects.toThrow(CHECK_VIOLATION);
  });

  it('rejects a non-positive duration', async () => {
    await expect(rawInsertSession({ duration_seconds: 0 })).rejects.toThrow(CHECK_VIOLATION);
  });

  it('rejects expires_at at or before created_at', async () => {
    await expect(rawInsertSession({ expires_at: CLOCK.CREATED_AT }))
      .rejects.toThrow(CHECK_VIOLATION);
  });

  it('rejects a blank id, token hash or attempt id', async () => {
    await expect(rawInsertSession({ id: '   ' })).rejects.toThrow(CHECK_VIOLATION);
    await expect(rawInsertSession({ token_hash: '' })).rejects.toThrow(CHECK_VIOLATION);
    await expect(rawInsertSession({ attempt_id: '  ' })).rejects.toThrow(CHECK_VIOLATION);
  });

  it('rejects submitted status without submitted_at', async () => {
    await expect(rawInsertSession({ status: 'submitted', submitted_at: null }))
      .rejects.toThrow(CHECK_VIOLATION);
  });

  it('rejects an active session carrying a result', async () => {
    await expect(rawInsertSession({ status: 'active', result_json: '{}' }))
      .rejects.toThrow(CHECK_VIOLATION);
  });

  it('rejects an out-of-range submitted_by_expiry', async () => {
    await expect(rawInsertSession({ submitted_by_expiry: 2 })).rejects.toThrow(CHECK_VIOLATION);
  });

  it('rejects an invalid question type', async () => {
    await ctx.repo.createSessionSnapshot(sessionInput());
    await expect(raw(
      `INSERT INTO session_questions
         (session_id, position, question_id, source_quiz_id, question_text, question_type, explanation)
       VALUES ('sess_1', 1, 'q1', 'rxjs', 'text', 'essay', 'why')`
    )).rejects.toThrow(CHECK_VIOLATION);
  });

  it('rejects blank question text and blank explanation', async () => {
    await ctx.repo.createSessionSnapshot(sessionInput());
    const insert = (text: string, explanation: string) => raw(
      `INSERT INTO session_questions
         (session_id, position, question_id, source_quiz_id, question_text, question_type, explanation)
       VALUES ('sess_1', 1, 'q1', 'rxjs', $1, 'single', $2)`,
      [text, explanation]
    );

    await expect(insert('   ', 'why')).rejects.toThrow(CHECK_VIOLATION);
    await expect(insert('text', '  ')).rejects.toThrow(CHECK_VIOLATION);
  });

  it('rejects a non-boolean is_correct integer', async () => {
    await ctx.repo.createSessionSnapshot(sessionInput());
    await expect(raw(
      `INSERT INTO session_options
         (session_id, question_position, option_id, option_text, display_order, is_correct)
       VALUES ('sess_1', 0, 999, 'x', 9, 7)`
    )).rejects.toThrow(CHECK_VIOLATION);
  });
});

describe('foreign keys and cascades', () => {
  it('REJECTS an orphan question', async () => {
    await expect(raw(
      `INSERT INTO session_questions
         (session_id, position, question_id, source_quiz_id, question_text, question_type, explanation)
       VALUES ('ghost', 0, 'q', 'rxjs', 'text', 'single', 'why')`
    )).rejects.toThrow(FOREIGN_KEY_VIOLATION);
  });

  it('REJECTS an orphan option', async () => {
    await ctx.repo.createSessionSnapshot(sessionInput());
    await expect(raw(
      `INSERT INTO session_options
         (session_id, question_position, option_id, option_text, display_order, is_correct)
       VALUES ('sess_1', 99, 101, 'x', 0, 1)`
    )).rejects.toThrow(FOREIGN_KEY_VIOLATION);
  });

  it('REJECTS an orphan answer', async () => {
    await ctx.repo.createSessionSnapshot(sessionInput());
    await expect(raw(
      `INSERT INTO session_answers
         (session_id, question_position, selected_option_ids, updated_at)
       VALUES ('sess_1', 42, '[101]', 1)`
    )).rejects.toThrow(FOREIGN_KEY_VIOLATION);
  });

  it('CASCADES delete to questions, options and answers', async () => {
    await ctx.repo.createSessionSnapshot(sessionInput());
    await raw(
      `INSERT INTO session_answers (session_id, question_position, selected_option_ids, updated_at)
       VALUES ('sess_1', 0, '[101]', 1)`
    );

    expect(await ctx.repo.deleteSession('sess_1')).toBe(true);

    for (const table of ['session_questions', 'session_options', 'session_answers']) {
      expect(await countRows(table)).toBe(0);
    }
  });

  it('deleteSession reports false for an unknown id', async () => {
    expect(await ctx.repo.deleteSession('nope')).toBe(false);
  });
});

describe('option identity is scoped to its question', () => {
  const twoQuestions = sessionInput({
    questions: [
      question({
        position: 0,
        questionId: 'rxjs:q:3',
        options: [
          { optionId: 401, text: 'RXJS-401', displayOrder: 0, isCorrect: true },
          { optionId: 402, text: 'RXJS-402', displayOrder: 1, isCorrect: false }
        ]
      }),
      question({
        position: 1,
        questionId: 'signals:q:3',
        options: [
          { optionId: 401, text: 'SIGNALS-401', displayOrder: 0, isCorrect: false },
          { optionId: 402, text: 'SIGNALS-402', displayOrder: 1, isCorrect: true }
        ]
      })
    ]
  });

  it('ALLOWS the same option id in different questions', async () => {
    await ctx.repo.createSessionSnapshot(twoQuestions);
    const snapshot = (await ctx.repo.getSessionSnapshot('sess_1'))!;

    const a = snapshot.questions[0]!.options.find((o) => o.optionId === 401)!;
    const b = snapshot.questions[1]!.options.find((o) => o.optionId === 401)!;

    expect(a.text).toBe('RXJS-401');
    expect(b.text).toBe('SIGNALS-401');
    expect(a.isCorrect).toBe(true);
    expect(b.isCorrect).toBe(false);   // same id, opposite correctness
  });

  it('an option is retrievable only within its own question position', async () => {
    await ctx.repo.createSessionSnapshot(twoQuestions);
    const { rows } = await ctx.handle.query<{ option_text: string }>(
      `SELECT option_text FROM session_options
        WHERE session_id = $1 AND question_position = $2 AND option_id = $3`,
      ['sess_1', 1, 401]
    );

    expect(rows[0]!['option_text']).toBe('SIGNALS-401');   // NOT the question-0 option
  });

  it('rejects the SAME option id twice within one question', async () => {
    await ctx.repo.createSessionSnapshot(twoQuestions);
    await expect(raw(
      `INSERT INTO session_options
         (session_id, question_position, option_id, option_text, display_order, is_correct)
       VALUES ('sess_1', 0, 401, 'dupe', 9, 0)`
    )).rejects.toThrow(UNIQUE_VIOLATION);
  });

  it('rejects a duplicate display order within one question', async () => {
    await ctx.repo.createSessionSnapshot(twoQuestions);
    await expect(raw(
      `INSERT INTO session_options
         (session_id, question_position, option_id, option_text, display_order, is_correct)
       VALUES ('sess_1', 0, 999, 'dupe-order', 0, 0)`
    )).rejects.toThrow(UNIQUE_VIOLATION);
  });
});

describe('reads and JSON validation', () => {
  it('finds a session by attempt id', async () => {
    await ctx.repo.createSessionSnapshot(sessionInput());
    expect((await ctx.repo.getSessionByAttemptId('att_1'))?.id).toBe('sess_1');
    expect(await ctx.repo.getSessionByAttemptId('nope')).toBeNull();
  });

  it('returns null for an unknown session', async () => {
    expect(await ctx.repo.getSessionById('nope')).toBeNull();
    expect(await ctx.repo.getSessionSnapshot('nope')).toBeNull();
  });

  it('REJECTS malformed stored config rather than trusting the database', async () => {
    await ctx.repo.createSessionSnapshot(sessionInput());
    await raw("UPDATE interview_sessions SET config_json = 'not json' WHERE id = 'sess_1'");
    await expect(ctx.repo.getSessionById('sess_1')).rejects.toThrow(/unreadable config/i);
  });

  it('rejects a structurally wrong config', async () => {
    await ctx.repo.createSessionSnapshot(sessionInput());
    await raw(`UPDATE interview_sessions SET config_json = '{"difficulty":1}' WHERE id = 'sess_1'`);
    await expect(ctx.repo.getSessionById('sess_1')).rejects.toThrow(/invalid config/i);
  });

  it('validates stored answer arrays on read', () => {
    expect(parseSelectedOptionIds('[101,102]', 'ctx')).toEqual([101, 102]);
    expect(() => parseSelectedOptionIds('[]', 'ctx')).toThrow(/invalid selections/i);
    expect(() => parseSelectedOptionIds('[1,1]', 'ctx')).toThrow(/duplicate/i);
    expect(() => parseSelectedOptionIds('[1.5]', 'ctx')).toThrow(/non-integer/i);
    expect(() => parseSelectedOptionIds('["101"]', 'ctx')).toThrow(/non-integer/i);
    expect(() => parseSelectedOptionIds('nope', 'ctx')).toThrow(/unreadable/i);
    expect(() => parseSelectedOptionIds('{"a":1}', 'ctx')).toThrow(/invalid selections/i);
  });

  it('reads back saved answers through the repository', async () => {
    await ctx.repo.createSessionSnapshot(sessionInput());
    await raw(
      `INSERT INTO session_answers (session_id, question_position, selected_option_ids, updated_at)
       VALUES ('sess_1', 0, '[101]', 123)`
    );

    expect(await ctx.repo.getAnswers('sess_1')).toEqual([
      { position: 0, selectedOptionIds: [101], updatedAt: 123 }
    ]);
  });

  it('mutating a returned record does not change stored data', async () => {
    const record = await ctx.repo.createSessionSnapshot(sessionInput());
    (record.config.topicIds as string[]).push('signals');
    (record as { attemptId: string }).attemptId = 'TAMPERED';

    const fresh = (await ctx.repo.getSessionById('sess_1'))!;
    expect(fresh.config.topicIds).toEqual(['rxjs']);
    expect(fresh.attemptId).toBe('att_1');
  });

  it('mutating a returned snapshot does not change stored data', async () => {
    await ctx.repo.createSessionSnapshot(sessionInput());
    const snapshot = (await ctx.repo.getSessionSnapshot('sess_1'))!;
    (snapshot.questions[0] as { questionText: string }).questionText = 'TAMPERED';
    (snapshot.questions[0]!.options[0] as { isCorrect: boolean }).isCorrect = false;

    const fresh = (await ctx.repo.getSessionSnapshot('sess_1'))!;
    expect(fresh.questions[0]!.questionText).toBe('Which answer is correct?');
    expect(fresh.questions[0]!.options[0]!.isCorrect).toBe(true);
  });
});

describe('state transitions', () => {
  it('markExpired flips an active session', async () => {
    await ctx.repo.createSessionSnapshot(sessionInput());
    expect((await ctx.repo.markExpired('sess_1', CLOCK.CREATED_AT + 1)).status).toBe('expired');
  });

  it('markExpired leaves a submitted session alone', async () => {
    await ctx.repo.createSessionSnapshot(sessionInput());
    await raw(
      `UPDATE interview_sessions SET status = 'submitted', submitted_at = 1 WHERE id = 'sess_1'`
    );

    expect((await ctx.repo.markExpired('sess_1', 2)).status).toBe('submitted');
  });

  it('markExpired throws for an unknown session', async () => {
    await expect(ctx.repo.markExpired('nope', 1)).rejects.toThrow(SessionRepositoryError);
  });
});

/**
 * These asked, under SQLite, whether data survived closing and reopening a
 * FILE. The database is a server now, so the file has no equivalent — what is
 * still worth proving is that nothing is served out of process memory: a fresh
 * repository over the same database must see identical bytes.
 */
describe('persistence across a fresh connection', () => {
  it('reads back through a new repository, and does not rerun migrations', async () => {
    await ctx.repo.createSessionSnapshot(sessionInput());

    expect(await migrate(ctx.handle, { now: () => 999 })).toEqual([]);   // not rerun

    const snapshot = (await reopen(ctx.handle).repo.getSessionSnapshot('sess_1'))!;

    expect(snapshot.session.attemptId).toBe('att_1');
    expect(snapshot.session.status).toBe('active');
    expect(snapshot.questions[0]!.questionText).toBe('Which answer is correct?');
    expect(snapshot.questions[0]!.options.map((o) => o.optionId)).toEqual([101, 102]);
    expect(snapshot.questions[0]!.options[0]!.isCorrect).toBe(true);
  });

  it('FROZEN SNAPSHOT: a changed quiz bank cannot alter a stored session', async () => {
    await ctx.repo.createSessionSnapshot(sessionInput({
      questions: [question({
        questionText: 'ORIGINAL TEXT',
        explanation: 'ORIGINAL EXPLANATION',
        options: [
          { optionId: 101, text: 'ORIGINAL A', displayOrder: 0, isCorrect: true },
          { optionId: 102, text: 'ORIGINAL B', displayOrder: 1, isCorrect: false }
        ]
      })]
    }));

    // The quiz bank being edited or redeployed between sessions must not reach
    // a stored session: it is never consulted on read, so nothing can affect it.
    const snapshot = (await reopen(ctx.handle).repo.getSessionSnapshot('sess_1'))!;

    const stored = snapshot.questions[0]!;
    expect(stored.questionText).toBe('ORIGINAL TEXT');
    expect(stored.explanation).toBe('ORIGINAL EXPLANATION');
    expect(stored.options.map((o) => o.text)).toEqual(['ORIGINAL A', 'ORIGINAL B']);
    expect(stored.options.map((o) => o.displayOrder)).toEqual([0, 1]);
    expect(stored.options.map((o) => o.isCorrect)).toEqual([true, false]);
  });

  it('preserves option ORDER exactly as stored', async () => {
    await ctx.repo.createSessionSnapshot(sessionInput({
      questions: [question({
        options: [
          { optionId: 104, text: 'fourth-first', displayOrder: 0, isCorrect: false },
          { optionId: 101, text: 'first-second', displayOrder: 1, isCorrect: true },
          { optionId: 103, text: 'third-third', displayOrder: 2, isCorrect: false }
        ]
      })]
    }));

    const options = (await reopen(ctx.handle).repo.getSessionSnapshot('sess_1'))!
      .questions[0]!.options;

    expect(options.map((o) => o.optionId)).toEqual([104, 101, 103]);
  });
});

describe('token hash containment', () => {
  it('is stored, but never appears in a snapshot question or option', async () => {
    await ctx.repo.createSessionSnapshot(sessionInput({ tokenHash: 'SECRET-HASH-VALUE' }));
    const snapshot = (await ctx.repo.getSessionSnapshot('sess_1'))!;

    // The record legitimately carries it for internal verification…
    expect(snapshot.session.tokenHash).toBe('SECRET-HASH-VALUE');
    // …but it must not have leaked into the question/option snapshots.
    expect(JSON.stringify(snapshot.questions)).not.toContain('SECRET-HASH-VALUE');
  });
});
