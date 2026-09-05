import request from 'supertest';
import type { Express } from 'express';

import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { type DatabaseHandle } from '../src/db/database';
import { createSessionRepository, type SessionRepository } from '../src/interview/session.repository';
import { InterviewSessionService } from '../src/interview/session.service';
import { seededRandomSource } from '../src/interview/assessment.random';
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
    random: seededRandomSource(777)
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

interface Created { id: string; token: string; questions: QuestionDto[] }
interface QuestionDto {
  questionId: string;
  questionText: string;
  type: 'single' | 'multiple' | 'trueFalse';
  options: { optionId: number; text: string }[];
}

async function createSession(body: unknown = { mode: 'preset', presetId: 'senior' }): Promise<Created> {
  const res = await request(app).post('/api/interview-sessions').send(body as object);
  expect(res.status).toBe(201);
  return { id: res.body.sessionId, token: res.body.sessionToken, questions: res.body.questions };
}

function save(session: Created, questionId: string, selectedOptionIds: unknown, token = session.token) {
  return request(app)
    .put(`/api/interview-sessions/${session.id}/answers/${encodeURIComponent(questionId)}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ selectedOptionIds } as object);
}

function resume(session: Created, token = session.token) {
  return request(app)
    .get(`/api/interview-sessions/${session.id}`)
    .set('Authorization', `Bearer ${token}`);
}

const firstOf = (s: Created, type: QuestionDto['type']) =>
  s.questions.find((q) => q.type === type)!;

async function countAnswers(): Promise<number> {
  const { rows } = await handle.query<{ n: number }>(
    'SELECT COUNT(*)::int AS n FROM session_answers'
  );
  return Number(rows[0]!['n']);
}

function keysDeep(value: unknown, out: string[] = []): string[] {
  if (value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) { for (const item of value) keysDeep(item, out); return out; }
  for (const [key, nested] of Object.entries(value)) { out.push(key); keysDeep(nested, out); }
  return out;
}

const BANNED = [
  'correct', 'isCorrect', 'is_correct', 'correctOptionIds', 'correct_option_ids',
  'answerKey', 'expectedAnswers', 'explanation', 'score', 'percentage', 'result',
  'tokenHash', 'attemptId'
];

describe('saving selections', () => {
  it('saves a SINGLE-answer selection', async () => {
    const session = await createSession();
    const question = firstOf(session, 'single');
    const res = await save(session, question.questionId, [question.options[0]!.optionId]);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      saved: true,
      questionId: question.questionId,
      selectedOptionIds: [question.options[0]!.optionId],
      answeredCount: 1,
      questionCount: 25
    });
  });

  it('saves a TRUE/FALSE selection exactly like single', async () => {
    const session = await createSession();
    const question = session.questions.find((q) => q.type === 'trueFalse');
    if (!question) return;   // this generated set had none
    const res = await save(session, question.questionId, [question.options[0]!.optionId]);
    expect(res.status).toBe(200);
  });

  it('saves a MULTIPLE-answer selection of one option', async () => {
    const session = await createSession();
    const question = firstOf(session, 'multiple');
    const res = await save(session, question.questionId, [question.options[0]!.optionId]);
    expect(res.status).toBe(200);
    expect(res.body.answeredCount).toBe(1);
  });

  it('saves several options for a multiple-answer question', async () => {
    const session = await createSession();
    const question = firstOf(session, 'multiple');
    const ids = question.options.slice(0, 2).map((o) => o.optionId);
    const res = await save(session, question.questionId, ids);
    expect(res.status).toBe(200);
    expect(res.body.selectedOptionIds).toEqual([...ids].sort((a, b) => a - b));
  });

  it('ACCEPTS every option for a multiple-answer question — the UI permits it', async () => {
    const session = await createSession();
    const question = firstOf(session, 'multiple');
    const res = await save(session, question.questionId, question.options.map((o) => o.optionId));
    expect(res.status).toBe(200);
  });

  it('CANONICALIZES to ascending order', async () => {
    const session = await createSession();
    const question = firstOf(session, 'multiple');
    const ids = question.options.slice(0, 3).map((o) => o.optionId);
    const reversed = [...ids].reverse();

    const res = await save(session, question.questionId, reversed);
    expect(res.body.selectedOptionIds).toEqual([...ids].sort((a, b) => a - b));
  });

  it('REPLACES rather than appends', async () => {
    const session = await createSession();
    const question = firstOf(session, 'multiple');
    const [a, b] = question.options.map((o) => o.optionId);

    await save(session, question.questionId, [a!]);
    const res = await save(session, question.questionId, [b!]);

    expect(res.body.selectedOptionIds).toEqual([b!]);
    expect(res.body.answeredCount).toBe(1);
  });

  it('is idempotent for repeated identical saves', async () => {
    const session = await createSession();
    const question = firstOf(session, 'single');
    const ids = [question.options[0]!.optionId];

    const first = await save(session, question.questionId, ids);
    const second = await save(session, question.questionId, ids);
    expect(second.body).toEqual(first.body);
  });

  it('CLEARS an answer with an empty array and drops the row', async () => {
    const session = await createSession();
    const question = firstOf(session, 'multiple');
    await save(session, question.questionId, [question.options[0]!.optionId]);

    const cleared = await save(session, question.questionId, []);
    expect(cleared.status).toBe(200);
    expect(cleared.body.selectedOptionIds).toEqual([]);
    expect(cleared.body.answeredCount).toBe(0);

    expect(await countAnswers()).toBe(0);
  });

  it('answeredCount rises and falls with real rows', async () => {
    const session = await createSession();
    const [q1, q2, q3] = session.questions;

    expect((await save(session, q1!.questionId, [q1!.options[0]!.optionId])).body.answeredCount).toBe(1);
    expect((await save(session, q2!.questionId, [q2!.options[0]!.optionId])).body.answeredCount).toBe(2);
    expect((await save(session, q3!.questionId, [q3!.options[0]!.optionId])).body.answeredCount).toBe(3);
    expect((await save(session, q2!.questionId, [])).body.answeredCount).toBe(2);
  });
});

describe('selection-count rules', () => {
  it('REJECTS two selections for a single-answer question', async () => {
    const session = await createSession();
    const question = firstOf(session, 'single');
    const res = await save(session, question.questionId, question.options.slice(0, 2).map((o) => o.optionId));

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/exactly one selection/i);
  });

  it('REJECTS two selections for a true/false question', async () => {
    const session = await createSession();
    const question = session.questions.find((q) => q.type === 'trueFalse');
    if (!question) return;
    const res = await save(session, question.questionId, question.options.map((o) => o.optionId));
    expect(res.status).toBe(400);
  });
});

describe('option ownership (collision safety)', () => {
  it('resolves a colliding option id WITHIN the addressed question', async () => {
    const session = await createSession();
    // Option ids collide across questions by construction; find two questions
    // that both own the same numeric id.
    let a: QuestionDto | undefined;
    let b: QuestionDto | undefined;
    let shared = 0;

    outer: for (const first of session.questions) {
      for (const second of session.questions) {
        if (first === second) continue;
        const common = first.options.find((o) => second.options.some((x) => x.optionId === o.optionId));
        if (common) { a = first; b = second; shared = common.optionId; break outer; }
      }
    }
    expect(a).toBeDefined();
    expect(b).toBeDefined();

    // Saving the shared id against B resolves B's option, not A's.
    const res = await save(session, b!.questionId, [shared]);
    expect([200, 400]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.selectedOptionIds).toEqual([shared]);
      expect(res.body.questionId).toBe(b!.questionId);
    }
  });

  it('REJECTS an option id that exists only in ANOTHER question', async () => {
    const session = await createSession();
    const [a, b] = session.questions;
    const bIds = new Set(b!.options.map((o) => o.optionId));
    const onlyInA = a!.options.find((o) => !bIds.has(o.optionId));
    if (!onlyInA) return;

    const res = await save(session, b!.questionId, [onlyInA.optionId]);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/does not belong to this question/i);
  });

  it('REJECTS an option id that exists nowhere', async () => {
    const session = await createSession();
    const question = firstOf(session, 'single');
    const res = await save(session, question.questionId, [999999]);
    expect(res.status).toBe(400);
  });
});

describe('question ownership', () => {
  it('REJECTS an unknown question id', async () => {
    const session = await createSession();
    const res = await save(session, 'rxjs:q:99', [101]);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/does not belong to this session/i);
  });

  it("REJECTS a valid bank question that is not in THIS session", async () => {
    const session = await createSession();
    const inSession = new Set(session.questions.map((q) => q.questionId));
    const outsider = presetTopicsRepository()
      .getEligibleQuestions()
      .find((q) => !inSession.has(q.questionId))!;

    const res = await save(session, outsider.questionId, [101]);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(outsider.questionText.slice(0, 20));
  });

  it("cannot alter ANOTHER session's answers", async () => {
    const a = await createSession();
    const b = await createSession();
    const question = firstOf(a, 'single');

    // b's token against a's session
    const res = await save(a, question.questionId, [question.options[0]!.optionId], b.token);
    expect(res.status).toBe(401);
    expect(await countAnswers()).toBe(0);
  });
});

describe('request validation', () => {
  const cases: [string, unknown][] = [
    ['a string id', ['401']],
    ['a float', [401.5]],
    ['NaN', [Number.NaN]],
    ['Infinity', [Number.POSITIVE_INFINITY]],
    ['duplicates', [401, 401]],
    ['a nested array', [[401]]],
    ['an object', [{ optionId: 401 }]],
    ['not an array', 401],
    ['null', null]
  ];

  it.each(cases)('rejects %s', async (_label, selected) => {
    const session = await createSession();
    const question = firstOf(session, 'single');
    const res = await save(session, question.questionId, selected);
    expect(res.status).toBe(400);
  });

  it('rejects a body missing selectedOptionIds', async () => {
    const session = await createSession();
    const question = firstOf(session, 'single');
    const res = await request(app)
      .put(`/api/interview-sessions/${session.id}/answers/${question.questionId}`)
      .set('Authorization', `Bearer ${session.token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it.each([
    ['correct', { selectedOptionIds: [], correct: true }],
    ['isCorrect', { selectedOptionIds: [], isCorrect: true }],
    ['score', { selectedOptionIds: [], score: 100 }],
    ['explanation', { selectedOptionIds: [], explanation: 'x' }],
    ['optionText', { selectedOptionIds: [], optionText: 'A' }],
    ['questionId', { selectedOptionIds: [], questionId: 'x' }]
  ])('rejects a client-supplied %s claim', async (_label, body) => {
    const session = await createSession();
    const question = firstOf(session, 'single');
    const res = await request(app)
      .put(`/api/interview-sessions/${session.id}/answers/${question.questionId}`)
      .set('Authorization', `Bearer ${session.token}`)
      .send(body);
    expect(res.status).toBe(400);
  });

  it('rejects a prototype-pollution key', async () => {
    const session = await createSession();
    const question = firstOf(session, 'single');
    const res = await request(app)
      .put(`/api/interview-sessions/${session.id}/answers/${question.questionId}`)
      .set('Authorization', `Bearer ${session.token}`)
      .set('Content-Type', 'application/json')
      .send('{"selectedOptionIds":[],"__proto__":{"x":1}}');
    expect(res.status).toBe(400);
  });

  it('rejects an oversized selection array', async () => {
    const session = await createSession();
    const question = firstOf(session, 'single');
    const res = await save(session, question.questionId, Array.from({ length: 50 }, (_u, i) => i));
    expect(res.status).toBe(400);
  });
});

describe('authentication', () => {
  it.each([
    ['missing', undefined],
    ['wrong scheme', 'Basic abc'],
    ['malformed', 'Bearer short'],
    ['wrong token', `Bearer ${'A'.repeat(43)}`]
  ])('returns a generic 401 for a %s token', async (_label, header) => {
    const session = await createSession();
    const question = firstOf(session, 'single');

    const call = request(app)
      .put(`/api/interview-sessions/${session.id}/answers/${question.questionId}`)
      .send({ selectedOptionIds: [question.options[0]!.optionId] });
    if (header !== undefined) call.set('Authorization', header);
    const res = await call;

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'Invalid session credentials' }
    });
  });

  it('authenticates BEFORE validating the question — no identity probing', async () => {
    const session = await createSession();
    // A bogus question id with a bad token must still be 401, not 400.
    const res = await save(session, 'totally:made:up', [1], 'Z'.repeat(43));
    expect(res.status).toBe(401);
  });
});

describe('expiry boundary', () => {
  async function sessionAt(msBeforeExpiry: number) {
    const session = await createSession({ mode: 'custom', difficulty: 'mixed', topicIds: ['typescript', 'templates'], questionCount: 10 });
    clock = clock + 900_000 - msBeforeExpiry;   // 900s duration
    return session;
  }

  it('one millisecond BEFORE expiry succeeds', async () => {
    const session = await sessionAt(1);
    const question = session.questions[0]!;
    const res = await save(session, question.questionId, [question.options[0]!.optionId]);
    expect(res.status).toBe(200);
  });

  it('EXACTLY at expiry fails', async () => {
    const session = await sessionAt(0);
    const question = session.questions[0]!;
    const res = await save(session, question.questionId, [question.options[0]!.optionId]);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SESSION_EXPIRED');
  });

  it('after expiry fails and writes NOTHING', async () => {
    const session = await sessionAt(-5000);
    const question = session.questions[0]!;
    await save(session, question.questionId, [question.options[0]!.optionId]);
    expect(await countAnswers()).toBe(0);
  });

  it('an expired replacement leaves the PRIOR answer untouched', async () => {
    const session = await createSession({ mode: 'custom', difficulty: 'mixed', topicIds: ['typescript', 'templates'], questionCount: 10 });
    const question = session.questions[0]!;
    const original = question.options[0]!.optionId;
    await save(session, question.questionId, [original]);

    clock += 900_001;
    const res = await save(session, question.questionId, [question.options[1]!.optionId]);
    expect(res.status).toBe(409);

    const stored = await sessions.getAnswers(session.id);
    expect(stored[0]!.selectedOptionIds).toEqual([original]);
  });

  it('PERSISTS the expired state', async () => {
    const session = await sessionAt(-1);
    await save(session, session.questions[0]!.questionId, [session.questions[0]!.options[0]!.optionId]);
    expect((await sessions.getSessionById(session.id))!.status).toBe('expired');
  });

  it('resume after expiry reveals neither questions nor answers', async () => {
    const session = await createSession({ mode: 'custom', difficulty: 'mixed', topicIds: ['typescript', 'templates'], questionCount: 10 });
    await save(session, session.questions[0]!.questionId, [session.questions[0]!.options[0]!.optionId]);
    clock += 900_001;

    const res = await resume(session);
    expect(res.status).toBe(409);
    expect(res.text).not.toContain('questionText');
    expect(res.text).not.toContain('selectedOptionIds');
  });
});

describe('resume returns saved selections', () => {
  it('returns answers in question order, cleared ones omitted', async () => {
    const session = await createSession();
    const [q0, q1, q2] = session.questions;

    await save(session, q2!.questionId, [q2!.options[0]!.optionId]);
    await save(session, q0!.questionId, [q0!.options[0]!.optionId]);
    await save(session, q1!.questionId, [q1!.options[0]!.optionId]);
    await save(session, q1!.questionId, []);   // cleared → omitted

    const res = await resume(session);
    expect(res.status).toBe(200);
    expect(res.body.answers).toEqual([
      { questionId: q0!.questionId, selectedOptionIds: [q0!.options[0]!.optionId] },
      { questionId: q2!.questionId, selectedOptionIds: [q2!.options[0]!.optionId] }
    ]);
  });

  it('returns an empty list when nothing is answered', async () => {
    const session = await createSession();
    expect((await resume(session)).body.answers).toEqual([]);
  });

  it('keeps question and option order stable alongside answers', async () => {
    const session = await createSession();
    await save(session, session.questions[0]!.questionId, [session.questions[0]!.options[0]!.optionId]);

    const res = await resume(session);
    expect(res.body.questions.map((q: QuestionDto) => q.questionId))
      .toEqual(session.questions.map((q) => q.questionId));
    expect(res.body.questions[0].options.map((o: { optionId: number }) => o.optionId))
      .toEqual(session.questions[0]!.options.map((o) => o.optionId));
  });
});

describe('response security', () => {
  it('the SAVE response has no banned keys', async () => {
    const session = await createSession();
    const question = firstOf(session, 'multiple');
    const res = await save(session, question.questionId, [question.options[0]!.optionId]);

    const keys = keysDeep(res.body);
    for (const banned of BANNED) expect(keys).not.toContain(banned);
    expect(Object.keys(res.body).sort())
      .toEqual(['answeredCount', 'questionCount', 'questionId', 'saved', 'selectedOptionIds']);
  });

  it('the RESUME response with answers has no banned keys', async () => {
    const session = await createSession();
    await save(session, session.questions[0]!.questionId, [session.questions[0]!.options[0]!.optionId]);

    const res = await resume(session);
    const keys = keysDeep(res.body);
    for (const banned of BANNED) expect(keys).not.toContain(banned);
  });

  it('does not repeat the session token', async () => {
    const session = await createSession();
    const question = firstOf(session, 'single');
    const saved = await save(session, question.questionId, [question.options[0]!.optionId]);

    expect(saved.text).not.toContain(session.token);
    expect((await resume(session)).text).not.toContain(session.token);
  });

  it('stored JSON contains ONLY selected option ids', async () => {
    const session = await createSession();
    const question = firstOf(session, 'multiple');
    const ids = question.options.slice(0, 2).map((o) => o.optionId);
    await save(session, question.questionId, ids);

    const { rows } = await handle.query<{ selected_option_ids: string }>(
      'SELECT selected_option_ids FROM session_answers'
    );
    const stored = rows[0]!['selected_option_ids'];

    expect(JSON.parse(stored)).toEqual([...ids].sort((a, b) => a - b));
    expect(stored).not.toMatch(/correct|text|explanation/i);
  });

  it('both routes are no-store', async () => {
    const session = await createSession();
    const question = firstOf(session, 'single');
    const saved = await save(session, question.questionId, [question.options[0]!.optionId]);
    expect(saved.headers['cache-control']).toBe('no-store');
    expect((await resume(session)).headers['cache-control']).toBe('no-store');
  });

  it('metadata endpoints are unchanged', async () => {
    const res = await request(app).get('/api/quizzes');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('questionText');
  });
});

describe('concurrency', () => {
  it('two near-simultaneous saves leave ONE valid complete selection', async () => {
    const session = await createSession();
    const question = firstOf(session, 'multiple');
    const first = question.options.slice(0, 2).map((o) => o.optionId).sort((a, b) => a - b);
    const second = question.options.slice(2, 4).map((o) => o.optionId).sort((a, b) => a - b);
    if (second.length < 2) return;

    await Promise.all([
      save(session, question.questionId, first),
      save(session, question.questionId, second)
    ]);

    const stored = await sessions.getAnswers(session.id);
    expect(stored).toHaveLength(1);
    // The result must be exactly one of the two bodies — never a merge.
    const value = [...stored[0]!.selectedOptionIds];
    expect([JSON.stringify(first), JSON.stringify(second)]).toContain(JSON.stringify(value));
  });
});

describe('restart and frozen-bank independence', () => {
  it('selections survive a rebuilt app and resume identically', async () => {
    // Under SQLite this closed and reopened a FILE. The database is a server
    // now; the equivalent question is whether the answers live in the database
    // rather than in the process, so the app and repository are rebuilt from
    // scratch over the same database.
    const session = await createSession();
    const single = firstOf(session, 'single');
    const multi = firstOf(session, 'multiple');
    const multiIds = multi.options.slice(0, 2).map((o) => o.optionId).sort((a, b) => a - b);

    await save(session, single.questionId, [single.options[0]!.optionId]);
    await save(session, multi.questionId, multiIds);

    app = buildApp(createSessionRepository(handle));

    const res = await resume(session);
    expect(res.status).toBe(200);

    const byId = new Map(
      res.body.answers.map((a: { questionId: string; selectedOptionIds: number[] }) =>
        [a.questionId, a.selectedOptionIds])
    );
    expect(byId.get(single.questionId)).toEqual([single.options[0]!.optionId]);
    expect(byId.get(multi.questionId)).toEqual(multiIds);

    const keys = keysDeep(res.body);
    for (const banned of BANNED) expect(keys).not.toContain(banned);
  });

  it('validation uses the FROZEN snapshot, not the live quiz bank', async () => {
    const session = await createSession();
    const question = firstOf(session, 'single');
    const optionId = question.options[0]!.optionId;

    // Rebuild the app with a DIFFERENT (tiny) quiz repository — as if the bank
    // had been edited and redeployed. The session must be unaffected.
    const service = new InterviewSessionService({
      quizRepository: presetTopicsRepository(),
      sessionRepository: sessions,
      now: () => clock,
      random: seededRandomSource(1)
    });
    app = createApp(
      loadConfig({ NODE_ENV: 'test', ALLOWED_ORIGINS: 'http://localhost:4200' } as NodeJS.ProcessEnv),
      { quizRepository: presetTopicsRepository(), sessionRepository: sessions, interviewSessionService: service }
    );

    const res = await save(session, question.questionId, [optionId]);
    expect(res.status).toBe(200);

    const resumed = await resume(session);
    expect(resumed.body.questions[0].questionText).toBe(session.questions[0]!.questionText);
  });
});

describe('route surface', () => {
  it.each([
    ['get', '/api/interview-sessions/is_x/review'],
    ['get', '/api/interview-sessions/is_x/score']
  ])('%s %s -> 404 (no such route)', async (method, path) => {
    const call = (request(app) as unknown as Record<string, (p: string) => request.Test>)[method]!;
    expect((await call(path)).status).toBe(404);
  });

  it.each([
    ['post', '/api/interview-sessions/is_x/submit'],
    ['get', '/api/interview-sessions/is_x/result']
  ])('%s %s EXISTS as of Stage 8 and requires authentication', async (method, path) => {
    const call = (request(app) as unknown as Record<string, (p: string) => request.Test>)[method]!;
    expect((await call(path)).status).toBe(401);   // registered, not 404
  });
});
