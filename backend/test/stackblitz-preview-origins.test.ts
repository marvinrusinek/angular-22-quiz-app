import request from 'supertest';
import type { Express } from 'express';

import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { fromPool, type DatabaseHandle } from '../src/db/database';
import { migrate } from '../src/db/migrate';
import { createQuizRepositoryFromDatabase } from '../src/quiz/quiz.repository';
import { createSessionRepository } from '../src/interview/session.repository';
import { createTestPool } from './helpers/pg-mem-pool';
import { isStackBlitzPreviewOrigin } from '../src/api/preview-origins';

/**
 * CORS for StackBlitz preview origins.
 *
 * StackBlitz regenerates its preview origin per session, so it cannot live in
 * the exact allow-list the way gh-pages does. That was harmless until Topic
 * Quiz content moved to `GET /questions`: the endpoint fails closed, so a
 * CORS-blocked response now means the quiz has no questions at all. Measured
 * against live Render before the fix, every StackBlitz-family origin got a 200
 * with NO `Access-Control-Allow-Origin`, so the browser discarded a response
 * the server had already produced.
 *
 * The predicate is deliberately a parsed-URL protocol + hostname test over
 * three named vendor domains. A `includes()` check would accept
 * `https://webcontainer-api.io.evil.com`, which is why the near-miss cases
 * below are the point of this file rather than padding.
 */

const GH_PAGES = 'https://marvinrusinek.github.io';

let handle: DatabaseHandle;
let app: Express;

beforeEach(async () => {
  handle = fromPool(createTestPool().pool, 'pg-mem');
  await migrate(handle, { now: () => 1 });
  await handle.query(
    `INSERT INTO quizzes (quiz_id, milestone, summary, image, difficulty, facts_json, display_order)
     VALUES ('rxjs','RxJS','s','i','beginner','[]',0)`
  );
  const inserted = await handle.query<{ id: string }>(
    `INSERT INTO questions (quiz_pk, question_text, question_type, explanation, display_order)
     VALUES (1,'Q?','single','e',0) RETURNING id`
  );
  const questionPk = Number(inserted.rows[0]!['id']);
  await handle.query(
    `INSERT INTO options (question_pk, option_text, display_order, is_correct)
     VALUES ($1,'A',0,1), ($1,'B',1,0)`,
    [questionPk]
  );

  const quizRepository = await createQuizRepositoryFromDatabase(handle);
  app = createApp(
    loadConfig({ NODE_ENV: 'test', ALLOWED_ORIGINS: GH_PAGES } as NodeJS.ProcessEnv),
    { quizRepository, sessionRepository: createSessionRepository(handle), now: () => 1 }
  );
});
afterEach(() => handle.close());

/** The real request the app makes first on Topic Quiz entry. */
const questionsWithOrigin = (origin: string) =>
  request(app).get('/api/quizzes/rxjs/questions').set('Origin', origin);

const acao = (res: request.Response): string =>
  String(res.headers['access-control-allow-origin'] ?? '');

// ── the predicate itself ────────────────────────────────────────────────

describe('isStackBlitzPreviewOrigin — allowed families', () => {
  it.each([
    // The REAL preview origin observed serving this project. `webcontainer.io`
    // is a different domain from `webcontainer-api.io`; the first version of
    // this list had only the latter, so the app's own origin was blocked.
    'https://angular22quizapp-uyfq--4200--017acfb7.local-credentialless.webcontainer.io',
    'https://abc123.local-credentialless.webcontainer.io',
    'https://abc123.local-credentialless.webcontainer-api.io',
    'https://abc123--4200.local-credentialless.webcontainer-api.io',
    'https://abc123.w-credentialless-staticblitz.com',
    'https://angular-quiz.stackblitz.io',
    'https://stackblitz.io'
  ])('allows %s', (origin) => {
    expect(isStackBlitzPreviewOrigin(origin)).toBe(true);
  });
});

describe('isStackBlitzPreviewOrigin — rejections', () => {
  it.each([
    // http, not https
    ['http://abc123.local-credentialless.webcontainer-api.io', 'http is not https'],
    ['http://angular-quiz.stackblitz.io', 'http is not https'],
    // suffix-confusion: the attacker owns the REAL registrable domain
    ['https://webcontainer-api.io.evil.com', 'vendor name is only a label of evil.com'],
    ['https://evil.stackblitz.io.evil.com', 'vendor name is only a label of evil.com'],
    ['https://w-credentialless-staticblitz.com.evil.com', 'vendor name is only a label'],
    // no dot before the suffix — must not match as a subdomain
    ['https://evilwebcontainer-api.io', 'no dot boundary'],
    ['https://evilwebcontainer.io', 'no dot boundary'],
    ['https://webcontainer.io.evil.com', 'vendor name is only a label of evil.com'],
    ['https://evilstackblitz.io', 'no dot boundary'],
    ['https://notstackblitz.io', 'no dot boundary'],
    // unrelated
    ['https://example.com', 'unrelated origin'],
    ['https://marvinrusinek.github.io.evil.com', 'unrelated origin'],
    // not an origin at all
    ['https://abc.stackblitz.io/path', 'origins carry no path'],
    ['https://user:pw@abc.stackblitz.io', 'origins carry no credentials'],
    ['not a url', 'unparseable'],
    ['', 'empty']
  ])('rejects %s (%s)', (origin) => {
    expect(isStackBlitzPreviewOrigin(origin)).toBe(false);
  });

  it('rejects a bare .io host that merely ends in the vendor letters', () => {
    // The dot boundary is the whole defence here.
    expect(isStackBlitzPreviewOrigin('https://xwebcontainer-api.io')).toBe(false);
  });
});

// ── the wired CORS middleware, as a browser would see it ────────────────

describe('GET /questions CORS headers', () => {
  it('echoes the configured exact origin (gh-pages is unchanged)', async () => {
    const res = await questionsWithOrigin(GH_PAGES);

    expect(res.status).toBe(200);
    expect(acao(res)).toBe(GH_PAGES);
  });

  it.each([
    'https://abc123.local-credentialless.webcontainer-api.io',
    'https://abc123.w-credentialless-staticblitz.com',
    'https://angular-quiz.stackblitz.io'
  ])('echoes the StackBlitz preview origin %s exactly', async (origin) => {
    const res = await questionsWithOrigin(origin);

    expect(res.status).toBe(200);
    // Echoed exactly — never `*`, which would be a different security posture.
    expect(acao(res)).toBe(origin);
    expect(acao(res)).not.toBe('*');
  });

  it.each([
    'https://evilwebcontainer-api.io',
    'https://webcontainer-api.io.evil.com',
    'https://evil.stackblitz.io.evil.com',
    'https://example.com',
    'http://abc123.local-credentialless.webcontainer-api.io'
  ])('sends NO CORS header for %s', async (origin) => {
    const res = await questionsWithOrigin(origin);

    // The server still answers; the BROWSER is what blocks it. That is the
    // documented posture — a disallowed origin is not a 500.
    expect(res.status).toBe(200);
    expect(acao(res)).toBe('');
  });

  it('a request with NO Origin header is unaffected (curl, server-side)', async () => {
    const res = await request(app).get('/api/quizzes/rxjs/questions');

    expect(res.status).toBe(200);
  });

  it('does not enable credentials for preview origins', async () => {
    const res = await questionsWithOrigin('https://abc123.stackblitz.io');

    // Read access to public content only; the session token travels in a
    // header, never a cookie.
    expect(String(res.headers['access-control-allow-credentials'] ?? '')).not.toBe('true');
  });
});

describe('preflight for the receipt headers still works from a preview origin', () => {
  it('allows X-Question-Receipt from a StackBlitz origin', async () => {
    const origin = 'https://abc123.local-credentialless.webcontainer-api.io';
    const res = await request(app)
      .options('/api/quizzes/rxjs/check')
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'x-question-receipt, content-type');

    expect(res.status).toBeLessThan(400);
    expect(String(res.headers['access-control-allow-headers'] ?? '').toLowerCase())
      .toContain('x-question-receipt');
    expect(acao(res)).toBe(origin);
  });
});
