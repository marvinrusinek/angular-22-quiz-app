import request from 'supertest';
import type { Express } from 'express';

import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { type DatabaseHandle } from '../src/db/database';
import { type SessionRepository } from '../src/interview/session.repository';
import { InterviewSessionService } from '../src/interview/session.service';
import { hashToken, extractBearerToken, isWellFormedToken, tokenMatches } from '../src/interview/session.token';
import { seededRandomSource } from '../src/interview/assessment.random';
import { presetTopicsRepository } from './helpers/fixtures';
import { memoryDb } from './helpers/db';

/** Mutable test clock — expiry is driven deliberately, never by wall time. */
let clock = 1_700_000_000_000;
let handle: DatabaseHandle;
let sessions: SessionRepository;
let app: Express;

beforeEach(async () => {
  clock = 1_700_000_000_000;
  const ctx = await memoryDb();
  handle = ctx.handle;
  sessions = ctx.repo;

  const service = new InterviewSessionService({
    quizRepository: presetTopicsRepository(),
    sessionRepository: sessions,
    now: () => clock,
    random: seededRandomSource(4242)
  });

  app = createApp(
    loadConfig({ NODE_ENV: 'test', ALLOWED_ORIGINS: 'http://localhost:4200' } as NodeJS.ProcessEnv),
    { quizRepository: presetTopicsRepository(), sessionRepository: sessions, interviewSessionService: service }
  );
});
afterEach(() => handle.close());

const CUSTOM = { mode: 'custom', difficulty: 'mixed', topicIds: ['typescript', 'templates'], questionCount: 10 };
const PRESET = { mode: 'preset', presetId: 'junior' };

async function create(body: unknown = CUSTOM) {
  return request(app).post('/api/interview-sessions').send(body as object);
}

function keysDeep(value: unknown, out: string[] = []): string[] {
  if (value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) { for (const item of value) keysDeep(item, out); return out; }
  for (const [key, nested] of Object.entries(value)) { out.push(key); keysDeep(nested, out); }
  return out;
}

const BANNED = [
  'correct', 'isCorrect', 'is_correct', 'correctOptionIds', 'answerKey', 'expectedAnswers',
  'explanation', 'tokenHash', 'token_hash', 'attemptId', 'result_json', 'result',
  'sourceQuestionIndex', 'sourceOptionIndex'
];

describe('POST /api/interview-sessions — custom', () => {
  it('creates an active session with the requested count', async () => {
    const res = await create();
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('active');
    expect(res.body.questions).toHaveLength(10);
    expect(res.body.answers).toEqual([]);
    expect(res.body.config).toEqual({
      mode: 'custom', difficulty: 'mixed', topicIds: ['typescript', 'templates'], questionCount: 10
    });
  });

  it('returns server-authoritative ISO timestamps and remainingSeconds', async () => {
    const res = await create();
    expect(res.body.createdAt).toBe(new Date(clock).toISOString());
    expect(res.body.expiresAt).toBe(new Date(clock + 900_000).toISOString());
    expect(res.body.durationSeconds).toBe(900);
    expect(res.body.remainingSeconds).toBe(900);
  });

  it('returns the session token EXACTLY once, on creation', async () => {
    const res = await create();
    expect(isWellFormedToken(res.body.sessionToken)).toBe(true);
  });

  it('stores only the token HASH — never the raw token', async () => {
    const res = await create();
    const raw = res.body.sessionToken as string;

    const { rows } = await handle.query<{ token_hash: string }>(
      'SELECT token_hash FROM interview_sessions WHERE id = $1',
      [res.body.sessionId]
    );
    const storedHash = rows[0]!['token_hash'];

    expect(storedHash).toBe(hashToken(raw));
    expect(storedHash).not.toBe(raw);

    // The raw token appears nowhere in the stored session row.
    const dump = JSON.stringify((await handle.query('SELECT * FROM interview_sessions')).rows);
    expect(dump).not.toContain(raw);
  });

  it('each POST creates a NEW attempt — not idempotent by design', async () => {
    const a = await create();
    const b = await create();
    expect(a.body.sessionId).not.toBe(b.body.sessionId);
    expect(a.body.sessionToken).not.toBe(b.body.sessionToken);
  });
});

describe('POST /api/interview-sessions — preset', () => {
  it('creates a junior preset session with preset-authoritative values', async () => {
    const res = await create(PRESET);
    expect(res.status).toBe(201);
    expect(res.body.questions).toHaveLength(15);
    expect(res.body.durationSeconds).toBe(1200);
    expect(res.body.config.mode).toBe('preset');
    expect(res.body.config.presetId).toBe('junior');
  });

  it.each([['mid-level', 20, 1800], ['senior', 25, 2400]])(
    '%s preset yields %i questions and %i seconds',
    async (presetId, count, duration) => {
      const res = await create({ mode: 'preset', presetId });
      expect(res.body.questions).toHaveLength(count);
      expect(res.body.durationSeconds).toBe(duration);
    }
  );

  it('REJECTS client-supplied topics, difficulty or count alongside a preset', async () => {
    for (const extra of [{ topicIds: ['typescript'] }, { difficulty: 'advanced' }, { questionCount: 30 }]) {
      const res = await create({ ...PRESET, ...extra });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/may not be supplied with a preset/);
    }
  });

  it('rejects an unknown preset without falling back', async () => {
    const res = await create({ mode: 'preset', presetId: 'architect' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/unknown preset/);
  });
});

describe('request validation', () => {
  it.each([
    ['unknown field', { ...CUSTOM, colour: 'red' }],
    ['client duration', { ...CUSTOM, durationSeconds: 99999 }],
    ['client expiry', { ...CUSTOM, expiresAt: 123 }],
    ['client session id', { ...CUSTOM, sessionId: 'is_hax' }],
    ['client attempt id', { ...CUSTOM, attemptId: 'ia_hax' }],
    ['client token', { ...CUSTOM, sessionToken: 'x'.repeat(43) }],
    ['client correctness', { ...CUSTOM, correctOptionIds: [101] }],
    ['client questions', { ...CUSTOM, questions: [] }],
    ['client score', { ...CUSTOM, score: 100 }],
    ['client status', { ...CUSTOM, status: 'submitted' }]
  ])('rejects %s', async (_label, body) => {
    const res = await create(body);
    expect(res.status).toBe(400);
  });

  it('rejects a prototype-pollution key', async () => {
    const res = await request(app)
      .post('/api/interview-sessions')
      .set('Content-Type', 'application/json')
      .send('{"mode":"custom","__proto__":{"admin":true}}');
    expect(res.status).toBe(400);
  });

  it('rejects an oversized topic list and over-long ids', async () => {
    expect((await create({ ...CUSTOM, topicIds: Array(80).fill('typescript') })).status).toBe(400);
    expect((await create({ ...CUSTOM, topicIds: ['x'.repeat(200)] })).status).toBe(400);
  });

  it.each([
    ['missing mode', { difficulty: 'mixed', topicIds: ['typescript'], questionCount: 10 }],
    ['bad mode', { mode: 'turbo' }],
    ['unknown topic', { ...CUSTOM, topicIds: ['nope'] }],
    ['duplicate topics', { ...CUSTOM, topicIds: ['typescript', 'typescript'] }],
    ['bad count', { ...CUSTOM, questionCount: 15 }],
    ['too few questions available', { ...CUSTOM, topicIds: ['typescript'], questionCount: 30 }]
  ])('rejects %s with a safe message', async (_label, body) => {
    const res = await create(body);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/isCorrect|explanation/);
  });

  it('rejects malformed JSON', async () => {
    const res = await request(app)
      .post('/api/interview-sessions')
      .set('Content-Type', 'application/json')
      .send('{ nope');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/interview-sessions/:id — authentication', () => {
  async function created() {
    const res = await create();
    return { id: res.body.sessionId as string, token: res.body.sessionToken as string };
  }

  it('resumes with the correct token', async () => {
    const { id, token } = await created();
    const res = await request(app)
      .get(`/api/interview-sessions/${id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe(id);
    expect(res.body.questions).toHaveLength(10);
  });

  it('does NOT return the token again on resume', async () => {
    const { id, token } = await created();
    const res = await request(app)
      .get(`/api/interview-sessions/${id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.body.sessionToken).toBeUndefined();
    expect(res.text).not.toContain(token);
  });

  it('accepts a case-insensitive Bearer scheme', async () => {
    const { id, token } = await created();
    for (const scheme of ['Bearer', 'bearer', 'BEARER']) {
      const res = await request(app)
        .get(`/api/interview-sessions/${id}`)
        .set('Authorization', `${scheme} ${token}`);
      expect(res.status).toBe(200);
    }
  });

  it.each([
    ['missing header', undefined],
    ['empty header', ''],
    ['wrong scheme', 'Basic abc'],
    ['no token', 'Bearer'],
    ['malformed token', 'Bearer short'],
    ['wrong token', `Bearer ${'A'.repeat(43)}`]
  ])('returns the SAME generic 401 for %s', async (_label, header) => {
    const { id } = await created();
    const call = request(app).get(`/api/interview-sessions/${id}`);
    if (header !== undefined) call.set('Authorization', header);
    const res = await call;

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'Invalid session credentials' }
    });
  });

  it('an UNKNOWN session is indistinguishable from a wrong token', async () => {
    const { token } = await created();
    const unknown = await request(app)
      .get('/api/interview-sessions/is_does_not_exist')
      .set('Authorization', `Bearer ${token}`);

    const { id } = await created();
    const wrongToken = await request(app)
      .get(`/api/interview-sessions/${id}`)
      .set('Authorization', `Bearer ${'B'.repeat(43)}`);

    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrongToken.body);
  });

  it("REJECTS another session's valid token (session/token must belong together)", async () => {
    const a = await created();
    const b = await created();
    const res = await request(app)
      .get(`/api/interview-sessions/${a.id}`)
      .set('Authorization', `Bearer ${b.token}`);
    expect(res.status).toBe(401);
  });

  it('does NOT accept the token via query, route or cookie', async () => {
    const { id, token } = await created();

    expect((await request(app).get(`/api/interview-sessions/${id}?token=${token}`)).status).toBe(401);
    expect((await request(app).get(`/api/interview-sessions/${id}`).set('Cookie', `token=${token}`)).status)
      .toBe(401);
  });
});

describe('token helpers', () => {
  it('extracts only from a well-formed Bearer header', () => {
    const token = 'a'.repeat(43);
    expect(extractBearerToken(`Bearer ${token}`)).toBe(token);
    expect(extractBearerToken(`bearer  ${token}`)).toBe(token);
    expect(extractBearerToken(`Bearer ${token} extra`)).toBeNull();
    expect(extractBearerToken('Bearer tooshort')).toBeNull();
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it('matches only the exact token', () => {
    const token = 'c'.repeat(43);
    expect(tokenMatches(token, hashToken(token))).toBe(true);
    expect(tokenMatches('d'.repeat(43), hashToken(token))).toBe(false);
    expect(tokenMatches('bad', hashToken(token))).toBe(false);
  });
});

describe('active response contains no private data', () => {
  it('creation response has no banned keys', async () => {
    const res = await create();
    const keys = keysDeep(res.body);
    for (const banned of BANNED) expect(keys).not.toContain(banned);
  });

  it('resume response has no banned keys', async () => {
    const created = await create();
    const res = await request(app)
      .get(`/api/interview-sessions/${created.body.sessionId}`)
      .set('Authorization', `Bearer ${created.body.sessionToken}`);

    const keys = keysDeep(res.body);
    for (const banned of BANNED) expect(keys).not.toContain(banned);
  });

  it('RAW body carries no answer-key markers', async () => {
    const res = await create(PRESET);
    for (const marker of ['"isCorrect"', '"correct"', '"explanation"', '"tokenHash"', '"attemptId"']) {
      expect(res.text).not.toContain(marker);
    }
  });

  it('no real explanation text from the bank leaks', async () => {
    const repository = presetTopicsRepository();
    const res = await create();
    for (const question of res.body.questions) {
      const explanation = repository.getQuestionById(question.questionId)!.explanation;
      expect(res.text).not.toContain(explanation.slice(0, 30));
    }
  });

  it('questions expose only the four safe fields', async () => {
    const res = await create();
    for (const question of res.body.questions) {
      expect(Object.keys(question).sort())
        .toEqual(['options', 'questionId', 'questionText', 'sourceQuizId', 'type']);
      for (const option of question.options) {
        expect(Object.keys(option).sort()).toEqual(['optionId', 'text']);
      }
    }
  });

  it('carries EXPLICIT type so the client never needs correctness', async () => {
    const res = await create({ mode: 'preset', presetId: 'senior' });
    for (const question of res.body.questions) {
      expect(['single', 'multiple', 'trueFalse']).toContain(question.type);
    }
  });

  it('a MULTIPLE-answer question keeps its type with no correctness present', async () => {
    const res = await create({ mode: 'preset', presetId: 'senior' });
    const multi = res.body.questions.filter((q: { type: string }) => q.type === 'multiple');
    expect(multi.length).toBeGreaterThan(0);

    for (const question of multi) {
      // Check property NAMES, not the serialized text: a question may legitimately
      // ASK "which statements are correct?", and rejecting that would be the
      // false positive the whole name-based guard exists to avoid.
      const keys = keysDeep(question);
      for (const banned of ['correct', 'isCorrect', 'is_correct', 'correctOptionIds']) {
        expect(keys).not.toContain(banned);
      }
      // The client can still render checkboxes, purely from `type`.
      expect(question.type).toBe('multiple');
    }
  });
});

describe('order stability', () => {
  it('resume returns the SAME question and option order — no reshuffle', async () => {
    const created = await create({ mode: 'preset', presetId: 'mid-level' });
    const resume = await request(app)
      .get(`/api/interview-sessions/${created.body.sessionId}`)
      .set('Authorization', `Bearer ${created.body.sessionToken}`);

    expect(resume.body.questions.map((q: { questionId: string }) => q.questionId))
      .toEqual(created.body.questions.map((q: { questionId: string }) => q.questionId));

    for (const [index, question] of resume.body.questions.entries()) {
      expect(question.options.map((o: { optionId: number }) => o.optionId))
        .toEqual(created.body.questions[index].options.map((o: { optionId: number }) => o.optionId));
    }
  });

  it('remainingSeconds decreases with the server clock', async () => {
    const created = await create();
    clock += 300_000;
    const resume = await request(app)
      .get(`/api/interview-sessions/${created.body.sessionId}`)
      .set('Authorization', `Bearer ${created.body.sessionToken}`);
    expect(resume.body.remainingSeconds).toBe(600);
  });
});

describe('expiry', () => {
  it('rejects an expired session and MARKS it expired', async () => {
    const created = await create();
    clock += 901_000;

    const res = await request(app)
      .get(`/api/interview-sessions/${created.body.sessionId}`)
      .set('Authorization', `Bearer ${created.body.sessionToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SESSION_EXPIRED');
    expect(res.text).not.toContain('questionText');

    expect((await sessions.getSessionById(created.body.sessionId))!.status).toBe('expired');
  });

  it('does not trust a stored "active" past its deadline', async () => {
    const created = await create();
    expect((await sessions.getSessionById(created.body.sessionId))!.status).toBe('active');
    clock += 10_000_000;

    const res = await request(app)
      .get(`/api/interview-sessions/${created.body.sessionId}`)
      .set('Authorization', `Bearer ${created.body.sessionToken}`);
    expect(res.status).toBe(409);
  });

  it('a SUBMITTED session is not served through the active route', async () => {
    const created = await create();
    await handle.query(
      `UPDATE interview_sessions SET status = 'submitted', submitted_at = $1 WHERE id = $2`,
      [clock, created.body.sessionId]
    );

    const res = await request(app)
      .get(`/api/interview-sessions/${created.body.sessionId}`)
      .set('Authorization', `Bearer ${created.body.sessionToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.text).not.toContain('questionText');
    expect(res.text).not.toContain('result');
  });
});

describe('transport concerns', () => {
  it('both routes are no-store', async () => {
    const created = await create();
    expect(created.headers['cache-control']).toBe('no-store');

    const resume = await request(app)
      .get(`/api/interview-sessions/${created.body.sessionId}`)
      .set('Authorization', `Bearer ${created.body.sessionToken}`);
    expect(resume.headers['cache-control']).toBe('no-store');
  });

  it('no token appears in a Location header', async () => {
    const res = await create();
    expect(res.headers['location']).toBeUndefined();
  });

  it('CORS preflight permits POST and Authorization for an allowed origin', async () => {
    const res = await request(app)
      .options('/api/interview-sessions')
      .set('Origin', 'http://localhost:4200')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type');

    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:4200');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-headers']?.toLowerCase()).toContain('authorization');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('an unlisted origin gets no CORS grant', async () => {
    const res = await request(app)
      .post('/api/interview-sessions')
      .set('Origin', 'https://evil.example.com')
      .send(CUSTOM);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('route surface', () => {
  it.each([
    ['get', '/api/interview-sessions/is_x/review'],
    ['get', '/api/interview-sessions/is_x/score']
  ])('%s %s -> 404 (no such route)', async (method, path) => {
    const res = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[method]!(path);
    expect(res.status).toBe(404);
  });

  it.each([
    ['answers (Stage 7)', 'put', '/api/interview-sessions/is_x/answers/q1'],
    ['submit (Stage 8)', 'post', '/api/interview-sessions/is_x/submit'],
    ['result (Stage 8)', 'get', '/api/interview-sessions/is_x/result']
  ])('%s is registered and requires authentication', async (_label, method, path) => {
    const res = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[method]!(path);
    expect(res.status).toBe(401);   // not 404 — the route exists
  });
});

describe('persistence integrity', () => {
  it('the stored snapshot matches what was returned', async () => {
    const res = await create();
    const stored = (await sessions.getSessionSnapshot(res.body.sessionId))!;

    expect(stored.questions).toHaveLength(10);
    expect(stored.questions.map((q) => q.questionId))
      .toEqual(res.body.questions.map((q: { questionId: string }) => q.questionId));
    // Correctness IS stored — it simply never crosses the boundary.
    expect(stored.questions.some((q) => q.options.some((o) => o.isCorrect))).toBe(true);
  });

  it('a failed creation leaves nothing behind', async () => {
    await create({ ...CUSTOM, topicIds: ['nope'] });
    for (const table of ['interview_sessions', 'session_questions']) {
      const { rows } = await handle.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM ${table}`
      );
      expect(Number(rows[0]!['n'])).toBe(0);
    }
  });
});
