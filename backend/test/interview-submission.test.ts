import request from 'supertest';
import type { Express } from 'express';

import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { type DatabaseHandle } from '../src/db/database';
import { createSessionRepository, type SessionRepository } from '../src/interview/session.repository';
import { InterviewSessionService } from '../src/interview/session.service';
import { seededRandomSource } from '../src/interview/assessment.random';
import { computeTimeUsedSeconds, isSelectionCorrect, scoreInterview } from '../src/interview/result.scoring';
import { assertResultInvariants, FrozenResultError, parseFrozenResult } from '../src/interview/result.types';
import type { SessionQuestionSnapshot } from '../src/interview/session.types';
import { presetTopicsRepository } from './helpers/fixtures';
import { memoryDb } from './helpers/db';

let clock = 1_700_000_000_000;
let handle: DatabaseHandle;
let sessions: SessionRepository;
let app: Express;

function buildApp(repo: SessionRepository): Express {
  const service = new InterviewSessionService({
    quizRepository: presetTopicsRepository(),
    sessionRepository: repo,
    now: () => clock,
    random: seededRandomSource(31337)
  });
  return createApp(
    loadConfig({ NODE_ENV: 'test', ALLOWED_ORIGINS: 'http://localhost:4200' } as NodeJS.ProcessEnv),
    { quizRepository: presetTopicsRepository(), sessionRepository: repo, interviewSessionService: service }
  );
}

beforeEach(async () => {
  clock = 1_700_000_000_000;
  const ctx = await memoryDb();
  handle = ctx.handle;
  sessions = ctx.repo;
  app = buildApp(sessions);
});
afterEach(() => handle.close());

interface QuestionDto {
  questionId: string;
  questionText: string;
  type: 'single' | 'multiple' | 'trueFalse';
  options: { optionId: number; text: string }[];
}
interface Created { id: string; token: string; questions: QuestionDto[] }

const CUSTOM = { mode: 'custom', difficulty: 'mixed', topicIds: ['typescript', 'templates'], questionCount: 10 };

async function createSession(body: unknown = CUSTOM): Promise<Created> {
  const res = await request(app).post('/api/interview-sessions').send(body as object);
  expect(res.status).toBe(201);
  return { id: res.body.sessionId, token: res.body.sessionToken, questions: res.body.questions };
}

const save = (s: Created, qid: string, ids: number[]) =>
  request(app).put(`/api/interview-sessions/${s.id}/answers/${qid}`)
    .set('Authorization', `Bearer ${s.token}`).send({ selectedOptionIds: ids });

const submit = (s: Created, body: unknown = {}, token = s.token) =>
  request(app).post(`/api/interview-sessions/${s.id}/submit`)
    .set('Authorization', `Bearer ${token}`).send(body as object);

const getResult = (s: Created, token = s.token) =>
  request(app).get(`/api/interview-sessions/${s.id}/result`).set('Authorization', `Bearer ${token}`);

/** The frozen answer key — read from the SESSION snapshot, never the response. */
async function correctIdsFor(sessionId: string, questionId: string): Promise<number[]> {
  const snapshot = (await sessions.getSessionSnapshot(sessionId))!;
  const question = snapshot.questions.find((q) => q.questionId === questionId)!;
  return question.options.filter((o) => o.isCorrect).map((o) => o.optionId);
}
async function wrongIdFor(sessionId: string, questionId: string): Promise<number> {
  const snapshot = (await sessions.getSessionSnapshot(sessionId))!;
  const question = snapshot.questions.find((q) => q.questionId === questionId)!;
  return question.options.find((o) => !o.isCorrect)!.optionId;
}

function keysDeep(value: unknown, out: string[] = []): string[] {
  if (value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) { for (const item of value) keysDeep(item, out); return out; }
  for (const [key, nested] of Object.entries(value)) { out.push(key); keysDeep(nested, out); }
  return out;
}

/**
 * `correct` is deliberately absent from this list: on a submitted result it is
 * the AGGREGATE COUNT of correct answers, not a per-option flag. The per-option
 * forms (`isCorrect`, `is_correct`) remain banned.
 */
const SUBMITTED_BANNED = [
  'is_correct', 'isCorrect', 'tokenHash', 'token_hash', 'attemptId',
  'sourceQuestionIndex', 'sourceOptionIndex', 'databasePath', 'dataPath',
  'result_json', 'config_json', 'selected_option_ids'
];

// ── pure scoring ─────────────────────────────────────────────────────

describe('correctness is exact set equality', () => {
  it.each([
    ['exact single', [101], [101], true],
    ['wrong single', [101], [102], false],
    ['unanswered', [101], [], false],
    ['exact multiple set', [101, 103], [103, 101], true],
    ['missing one correct', [101, 103], [101], false],
    ['one extra incorrect', [101, 103], [101, 102, 103], false],
    ['all options when not all correct', [101], [101, 102, 103], false]
  ])('%s', (_label, correctIds, selected, expected) => {
    expect(isSelectionCorrect(correctIds, selected)).toBe(expected);
  });
});

describe('scoreInterview totals', () => {
  function question(position: number, correctIds: number[], allIds: number[]): SessionQuestionSnapshot {
    return {
      position,
      questionId: `q:${position}`,
      sourceQuizId: position < 2 ? 'rxjs' : 'signals',
      questionText: `Question ${position}?`,
      type: correctIds.length > 1 ? 'multiple' : 'single',
      explanation: `Explanation ${position}`,
      options: allIds.map((id, i) => ({
        optionId: id, text: `opt ${id}`, displayOrder: i, isCorrect: correctIds.includes(id)
      }))
    };
  }

  const questions = [
    question(0, [101], [101, 102]),
    question(1, [201], [201, 202]),
    question(2, [301, 303], [301, 302, 303]),
    question(3, [401], [401, 402])
  ];

  const score = (answers: [number, number[]][]) =>
    scoreInterview({
      questions,
      answersByPosition: new Map(answers),
      topicTitleFor: (id) => (id === 'rxjs' ? 'RxJS' : 'Signals')
    });

  it('counts correct, incorrect and unanswered', () => {
    const result = score([[0, [101]], [1, [202]], [2, [301, 303]]]);
    expect(result).toMatchObject({
      total: 4, answered: 3, unanswered: 1, correct: 2, incorrect: 1, percentage: 50
    });
  });

  it('maintains the invariants', () => {
    for (const answers of [
      [] as [number, number[]][],
      [[0, [101]]] as [number, number[]][],
      [[0, [101]], [1, [201]], [2, [301, 303]], [3, [401]]] as [number, number[]][]
    ]) {
      const r = score(answers);
      expect(r.correct + r.incorrect + r.unanswered).toBe(r.total);
      expect(r.answered).toBe(r.correct + r.incorrect);
    }
  });

  it('percentage is over TOTAL, not answered', () => {
    // One correct out of four = 25%, even though only one was answered.
    expect(score([[0, [101]]]).percentage).toBe(25);
  });

  it('perfect and zero scores', () => {
    expect(score([[0, [101]], [1, [201]], [2, [301, 303]], [3, [401]]]).percentage).toBe(100);
    expect(score([[0, [102]], [1, [202]]]).percentage).toBe(0);
  });

  it('rounds the percentage', () => {
    // 1/3 questions correct in a 3-question set → 33
    const three = [question(0, [101], [101, 102]), question(1, [201], [201, 202]), question(2, [301], [301, 302])];
    const r = scoreInterview({
      questions: three,
      answersByPosition: new Map([[0, [101]]]),
      topicTitleFor: (id) => id
    });
    expect(r.percentage).toBe(33);
  });

  it('groups per topic with adding-up buckets', () => {
    const r = score([[0, [101]], [1, [202]], [2, [301, 303]]]);
    const rxjs = r.byTopic.find((b) => b.topicId === 'rxjs')!;
    const signals = r.byTopic.find((b) => b.topicId === 'signals')!;

    expect(rxjs).toMatchObject({ title: 'RxJS', correct: 1, incorrect: 1, unanswered: 0, total: 2, percentage: 50 });
    expect(signals).toMatchObject({ title: 'Signals', correct: 1, incorrect: 0, unanswered: 1, total: 2, percentage: 50 });
    for (const bucket of r.byTopic) {
      expect(bucket.correct + bucket.incorrect + bucket.unanswered).toBe(bucket.total);
    }
  });

  it('review keeps question and option order and carries the frozen data', () => {
    const r = score([[2, [303, 301]]]);
    expect(r.review.map((q) => q.questionId)).toEqual(['q:0', 'q:1', 'q:2', 'q:3']);
    const multi = r.review[2]!;
    expect(multi.options.map((o) => o.optionId)).toEqual([301, 302, 303]);
    expect(multi.correctOptionIds).toEqual([301, 303]);
    expect(multi.selectedOptionIds).toEqual([303, 301]);
    expect(multi.explanation).toBe('Explanation 2');
  });
});

describe('time used', () => {
  const base = { expiresAt: 1_000_000, durationSeconds: 900 };

  it('manual submit before the deadline uses elapsed time', () => {
    expect(computeTimeUsedSeconds({ ...base, now: base.expiresAt - 300_000 }))
      .toEqual({ timeUsedSeconds: 600, timeRemainingSeconds: 300 });
  });

  it('submission at or after the deadline uses the FULL duration', () => {
    expect(computeTimeUsedSeconds({ ...base, now: base.expiresAt }).timeUsedSeconds).toBe(900);
    expect(computeTimeUsedSeconds({ ...base, now: base.expiresAt + 999_999 }).timeUsedSeconds).toBe(900);
  });

  it('is never negative and never exceeds the duration', () => {
    for (const now of [0, base.expiresAt - 1, base.expiresAt, base.expiresAt + 1e9]) {
      const t = computeTimeUsedSeconds({ ...base, now });
      expect(t.timeUsedSeconds).toBeGreaterThanOrEqual(0);
      expect(t.timeUsedSeconds).toBeLessThanOrEqual(base.durationSeconds);
    }
  });
});

// ── finalization ─────────────────────────────────────────────────────

describe('submission', () => {
  it('finalizes an active session before the deadline', async () => {
    const session = await createSession();
    const q0 = session.questions[0]!;
    await save(session, q0.questionId, await correctIdsFor(session.id, q0.questionId));

    clock += 120_000;
    const res = await submit(session);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('submitted');
    expect(res.body.submittedByExpiry).toBe(false);
    expect(res.body.total).toBe(10);
    expect(res.body.correct).toBe(1);
    expect(res.body.timeUsedSeconds).toBe(120);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('scores a mixture of correct, incorrect and unanswered', async () => {
    const session = await createSession();
    const [q0, q1] = session.questions;
    await save(session, q0!.questionId, await correctIdsFor(session.id, q0!.questionId));
    await save(session, q1!.questionId, [await wrongIdFor(session.id, q1!.questionId)]);

    const res = await submit(session);
    expect(res.body).toMatchObject({ total: 10, answered: 2, unanswered: 8, correct: 1, incorrect: 1 });
    expect(res.body.correct + res.body.incorrect + res.body.unanswered).toBe(res.body.total);
  });

  it('submits with NO answers at all', async () => {
    const session = await createSession();
    const res = await submit(session);
    expect(res.body).toMatchObject({ answered: 0, unanswered: 10, correct: 0, incorrect: 0, percentage: 0 });
  });

  it('submits with ALL answers correct', async () => {
    const session = await createSession();
    for (const question of session.questions) {
      await save(session, question.questionId, await correctIdsFor(session.id, question.questionId));
    }
    const res = await submit(session);
    expect(res.body.percentage).toBe(100);
    expect(res.body.correct).toBe(10);
  });

  it('marks submitted_by_expiry when submitted AT the deadline', async () => {
    const session = await createSession();
    clock += 900_000;
    const res = await submit(session);
    expect(res.body.submittedByExpiry).toBe(true);
    expect(res.body.timeUsedSeconds).toBe(900);
  });

  it('finalizes a session already marked EXPIRED by a failed answer save', async () => {
    const session = await createSession();
    const q0 = session.questions[0]!;
    await save(session, q0.questionId, await correctIdsFor(session.id, q0.questionId));

    clock += 900_001;
    await save(session, q0.questionId, [await wrongIdFor(session.id, q0.questionId)]);   // marks expired
    expect((await sessions.getSessionById(session.id))!.status).toBe('expired');

    const res = await submit(session);
    expect(res.status).toBe(200);
    expect(res.body.submittedByExpiry).toBe(true);
    expect(res.body.correct).toBe(1);   // the last SAVED answer counted
    expect((await sessions.getSessionById(session.id))!.status).toBe('submitted');
  });

  it('is IDEMPOTENT — repeated submits return the identical result', async () => {
    const session = await createSession();
    await save(session, session.questions[0]!.questionId, await correctIdsFor(session.id, session.questions[0]!.questionId));

    const first = await submit(session);
    clock += 60_000;              // time moves on; the frozen result must not
    const second = await submit(session);

    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  it('CONCURRENT submissions produce one result, and both callers agree', async () => {
    const session = await createSession();
    const [a, b] = await Promise.all([submit(session), submit(session)]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual(b.body);

    const { rows } = await handle.query<{ status: string; submitted_at: string | number }>(
      'SELECT status, submitted_at FROM interview_sessions WHERE id = $1',
      [session.id]
    );
    expect(rows[0]!['status']).toBe('submitted');
    // submitted_at is BIGINT, which pg returns as a string.
    expect(Number(rows[0]!['submitted_at'])).toBe(clock);
  });

  it('rejects a submit body carrying any field', async () => {
    const session = await createSession();
    for (const body of [
      { submittedByExpiry: true }, { score: 100 }, { percentage: 99 },
      { result: {} }, { correctOptionIds: [1] }, { answers: [] },
      { submittedAt: 1 }, { durationSeconds: 1 }, { attemptId: 'x' }, { nope: 1 }
    ]) {
      const res = await submit(session, body);
      expect(res.status).toBe(400);
    }
  });

  it('accepts an empty body', async () => {
    const session = await createSession();
    expect((await submit(session, {})).status).toBe(200);
  });

  it.each([
    ['missing', undefined],
    ['wrong', 'A'.repeat(43)]
  ])('returns a generic 401 for a %s token', async (_label, token) => {
    const session = await createSession();
    const call = request(app).post(`/api/interview-sessions/${session.id}/submit`).send({});
    if (token) call.set('Authorization', `Bearer ${token}`);
    const res = await call;
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('answers are locked after submission', () => {
  it('rejects a post-submission answer write with 409 and changes nothing', async () => {
    const session = await createSession();
    const q0 = session.questions[0]!;
    const original = await correctIdsFor(session.id, q0.questionId);
    await save(session, q0.questionId, original);
    await submit(session);

    const res = await save(session, q0.questionId, [await wrongIdFor(session.id, q0.questionId)]);
    expect(res.status).toBe(409);

    const stored = await sessions.getAnswers(session.id);
    expect(stored[0]!.selectedOptionIds).toEqual([...original].sort((a, b) => a - b));
  });

  it('the active resume route no longer serves the session', async () => {
    const session = await createSession();
    await submit(session);
    const res = await request(app)
      .get(`/api/interview-sessions/${session.id}`)
      .set('Authorization', `Bearer ${session.token}`);

    expect(res.status).toBe(409);
    expect(res.text).not.toContain('questionText');
  });
});

describe('GET /result', () => {
  it('returns the frozen result for a submitted session', async () => {
    const session = await createSession();
    const submitted = await submit(session);
    const fetched = await getResult(session);

    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual(submitted.body);
    expect(fetched.headers['cache-control']).toBe('no-store');
  });

  it('REJECTS an active session — no result exists yet', async () => {
    const session = await createSession();
    const res = await getResult(session);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.text).not.toContain('questionText');
  });

  it('FINALIZES an expired-but-unfinalized session (documented decision)', async () => {
    const session = await createSession();
    await save(session, session.questions[0]!.questionId, await correctIdsFor(session.id, session.questions[0]!.questionId));
    clock += 900_001;

    const res = await getResult(session);
    expect(res.status).toBe(200);
    expect(res.body.submittedByExpiry).toBe(true);
    expect((await sessions.getSessionById(session.id))!.status).toBe('submitted');

    // …and remains stable afterwards.
    expect((await getResult(session)).body).toEqual(res.body);
  });

  it('returns a generic 401 before revealing whether a result exists', async () => {
    const session = await createSession();
    await submit(session);
    const res = await getResult(session, 'B'.repeat(43));
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Invalid session credentials' } });
  });

  it("another session's token cannot read this result", async () => {
    const a = await createSession();
    const b = await createSession();
    await submit(a);
    expect((await getResult(a, b.token)).status).toBe(401);
  });
});

describe('response security', () => {
  it('the submitted result MAY carry correctOptionIds and explanation', async () => {
    const session = await createSession();
    const res = await submit(session);
    const keys = keysDeep(res.body);
    expect(keys).toContain('correctOptionIds');
    expect(keys).toContain('explanation');
  });

  it('the submitted result carries NO internal fields', async () => {
    const session = await createSession();
    const res = await submit(session);
    const keys = keysDeep(res.body);
    for (const banned of SUBMITTED_BANNED) expect(keys).not.toContain(banned);
  });

  it('review options expose only optionId and text', async () => {
    const session = await createSession();
    const res = await submit(session);
    for (const question of res.body.review) {
      for (const option of question.options) {
        expect(Object.keys(option).sort()).toEqual(['optionId', 'text']);
      }
    }
  });

  it('ACTIVE routes still reject correctness and explanations', async () => {
    const session = await createSession();
    const created = await request(app).post('/api/interview-sessions').send(CUSTOM);
    const resume = await request(app)
      .get(`/api/interview-sessions/${created.body.sessionId}`)
      .set('Authorization', `Bearer ${created.body.sessionToken}`);

    const keys = keysDeep(resume.body);
    for (const banned of ['correctOptionIds', 'explanation', 'correct', 'isCorrect', 'score', 'percentage', 'result']) {
      expect(keys).not.toContain(banned);
    }
    void session;
  });

  it('a question ASKING about "correct" is not blocked — keys, not values', async () => {
    const session = await createSession();
    const res = await submit(session);
    const asking = res.body.review.filter((q: { questionText: string }) =>
      /correct|result|score/i.test(q.questionText));
    expect(res.status).toBe(200);
    void asking;   // presence is incidental; the point is the 200 above
  });

  it('never repeats the session token', async () => {
    const session = await createSession();
    expect((await submit(session)).text).not.toContain(session.token);
    expect((await getResult(session)).text).not.toContain(session.token);
  });
});

describe('frozen result integrity', () => {
  it('survives a rebuilt app and a CHANGED quiz bank', async () => {
    // Under SQLite this closed and reopened a FILE. The database is a server
    // now, so what still matters is that the frozen result is read from storage
    // rather than regenerated: the app and repository are rebuilt from scratch
    // over the same database, as they would be after a redeploy.
    const session = await createSession();
    const q0 = session.questions[0]!;
    const correct = (await sessions.getSessionSnapshot(session.id))!.questions
      .find((q) => q.questionId === q0.questionId)!
      .options.filter((o) => o.isCorrect).map((o) => o.optionId);

    await request(app).put(`/api/interview-sessions/${session.id}/answers/${q0.questionId}`)
      .set('Authorization', `Bearer ${session.token}`)
      .send({ selectedOptionIds: correct });

    const submitted = await submit(session);

    app = buildApp(createSessionRepository(handle));

    const fetched = await getResult(session);
    expect(fetched.status).toBe(200);
    // Byte-for-byte identical: totals, review, options, explanations, order.
    expect(fetched.body).toEqual(submitted.body);
  });

  it('tampering with a saved answer AFTER submission does not change the result', async () => {
    const session = await createSession();
    const q0 = session.questions[0]!;
    await save(session, q0.questionId, await correctIdsFor(session.id, q0.questionId));
    const submitted = await submit(session);

    // Direct database tampering — the frozen result must ignore it.
    await handle.query('UPDATE session_answers SET selected_option_ids = $1', ['[999999]']);
    expect((await getResult(session)).body).toEqual(submitted.body);
  });

  it('malformed stored result JSON fails safely instead of regenerating', async () => {
    const session = await createSession();
    await submit(session);

    await handle.query(
      'UPDATE interview_sessions SET result_json = $1 WHERE id = $2',
      ['{ not json', session.id]
    );

    const res = await getResult(session);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL');
    expect(res.text).not.toContain('questionText');
  });

  it('a stored result violating its invariants is rejected on read', () => {
    expect(() => parseFrozenResult({ sessionId: 'x' }, 'x')).toThrow(FrozenResultError);
    expect(() =>
      assertResultInvariants({
        sessionId: 'x', status: 'submitted', submittedAt: 0, submittedByExpiry: false,
        total: 3, answered: 1, unanswered: 1, correct: 1, incorrect: 0, percentage: 33,
        durationSeconds: 900, timeUsedSeconds: 10, timeRemainingSeconds: 890,
        config: { mode: 'custom', topicIds: [], questionCount: 3 },
        performance: { byTopic: [] }, review: []
      })
    ).toThrow(/must equal total/);
  });
});

/**
 * Wire-shape guarantees for the RESULT endpoints.
 *
 * Post-submission responses are authorized to carry `correctOptionIds`,
 * `explanation` and the aggregate `correct` count — that is the user's earned
 * data. They must still never carry per-option correctness flags or any backend
 * internal, so a `SELECT *` row or a widened mapper fails loudly here rather
 * than shipping storage details to the browser.
 */
describe('result response contains no internal fields', () => {
  /** Every property name anywhere in a parsed body. */
  function keysOf(value: unknown, out = new Set<string>()): Set<string> {
    if (value === null || typeof value !== 'object') return out;
    if (Array.isArray(value)) {
      for (const item of value) keysOf(item, out);
      return out;
    }
    for (const [key, nested] of Object.entries(value)) {
      out.add(key);
      keysOf(nested, out);
    }
    return out;
  }

  const BANNED = [
    'isCorrect', 'is_correct', 'tokenHash', 'token_hash', 'sessionToken',
    'attemptId', 'attempt_id', 'sourceQuestionIndex', 'source_question_index',
    'sourceOptionIndex', 'source_option_index', 'databasePath', 'database_path',
    'dataPath', 'data_path', 'quizDataPath', 'allowedOrigins',
    'result_json', 'resultJson', 'config_json', 'configJson'
  ];

  it.each(['submit', 'result'])('%s response carries no internal field', async (route) => {
    const session = await createSession();
    const q0 = session.questions[0]!;
    await save(session, q0.questionId, await correctIdsFor(session.id, q0.questionId));

    const res = route === 'submit' ? await submit(session) : (await submit(session), await getResult(session));
    expect(res.status).toBe(200);

    const present = [...keysOf(res.body)].filter((k) => BANNED.includes(k));
    expect(present).toEqual([]);
  });

  it('DOES carry the authorized review material', async () => {
    const session = await createSession();
    const res = await submit(session);

    const keys = keysOf(res.body);
    expect(keys.has('correctOptionIds')).toBe(true);
    expect(keys.has('explanation')).toBe(true);
    expect(keys.has('correct')).toBe(true);      // aggregate count
    expect(keys.has('selectedOptionIds')).toBe(true);
  });

  it('ACTIVE responses still carry no correctness or explanation', async () => {
    const session = await createSession();
    const created = keysOf(session.questions);
    for (const banned of ['correct', 'isCorrect', 'correctOptionIds', 'explanation']) {
      expect(created.has(banned)).toBe(false);
    }

    const resumed = await request(app)
      .get(`/api/interview-sessions/${session.id}`)
      .set('Authorization', `Bearer ${session.token}`);
    const resumeKeys = keysOf(resumed.body);
    for (const banned of ['correct', 'isCorrect', 'correctOptionIds', 'explanation', 'sessionToken']) {
      expect(resumeKeys.has(banned)).toBe(false);
    }
  });
});
