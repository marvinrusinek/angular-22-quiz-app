import request from 'supertest';
import type { Express } from 'express';

import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { fromPool, type DatabaseHandle } from '../src/db/database';
import { migrate } from '../src/db/migrate';
import { createSessionRepository } from '../src/interview/session.repository';
import { InterviewSessionService } from '../src/interview/session.service';
import { seededRandomSource } from '../src/interview/assessment.random';
import { createQuizRepositoryFromDatabase } from '../src/quiz/quiz.repository';
import { createTestPool } from './helpers/pg-mem-pool';

/**
 * CORS PREFLIGHT for the Topic Quiz receipt headers.
 *
 * A custom request header makes a request non-simple, so a browser sends an
 * OPTIONS preflight first and refuses to send the real request unless the
 * header is named in Access-Control-Allow-Headers.
 *
 * `X-Attempt-Receipt` and `X-Question-Receipt` were missing from that list, so
 * POST /questions/start and POST /check never left the browser. Nothing showed
 * up in the server logs, and the whole backend suite stayed green — because
 * supertest speaks to Express directly and never performs a preflight. Only a
 * real browser could catch it, which is why the failure surfaced as four
 * inexplicable Playwright regressions.
 *
 * These tests exercise the real cors() middleware rather than asserting on the
 * constant, so they fail the same way a browser would.
 */

const ORIGIN = 'http://localhost:4200';

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
  const sessionRepository = createSessionRepository(handle);
  app = createApp(
    loadConfig({ NODE_ENV: 'test', ALLOWED_ORIGINS: ORIGIN } as NodeJS.ProcessEnv),
    {
      quizRepository,
      sessionRepository,
      interviewSessionService: new InterviewSessionService({
        quizRepository, sessionRepository, now: () => 1, random: seededRandomSource(3)
      }),
      now: () => 1
    }
  );
});
afterEach(() => handle.close());

/** Exactly what a browser sends before a POST carrying a custom header. */
function preflight(path: string, requestHeaders: string) {
  return request(app)
    .options(path)
    .set('Origin', ORIGIN)
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', requestHeaders);
}

const allowedHeaders = (res: request.Response): string =>
  String(res.headers['access-control-allow-headers'] ?? '').toLowerCase();

describe('POST /questions/start preflight', () => {
  it('allows X-Attempt-Receipt', async () => {
    const res = await preflight('/api/quizzes/rxjs/questions/start', 'x-attempt-receipt, content-type');

    expect(res.status).toBeLessThan(400);
    expect(allowedHeaders(res)).toContain('x-attempt-receipt');
  });
});

describe('POST /check preflight', () => {
  it('allows X-Question-Receipt', async () => {
    const res = await preflight('/api/quizzes/rxjs/check', 'x-question-receipt, content-type');

    expect(res.status).toBeLessThan(400);
    expect(allowedHeaders(res)).toContain('x-question-receipt');
  });
});

describe('the existing allow-list is preserved', () => {
  it('still allows Content-Type and Authorization', async () => {
    const res = await preflight('/api/quizzes/rxjs/check', 'content-type, authorization');

    expect(allowedHeaders(res)).toContain('content-type');
    expect(allowedHeaders(res)).toContain('authorization');
  });

  it('advertises BOTH receipt headers on any preflight', async () => {
    const headers = allowedHeaders(await preflight('/api/quizzes/rxjs/attempts', 'content-type'));

    expect(headers).toContain('x-attempt-receipt');
    expect(headers).toContain('x-question-receipt');
  });
});

describe('CORS was not loosened', () => {
  it('does not use a wildcard header allow-list', async () => {
    const res = await preflight('/api/quizzes/rxjs/check', 'x-question-receipt');

    // Widening to '*' would also permit any future header, including one that
    // has not been security-reviewed.
    expect(allowedHeaders(res)).not.toContain('*');
  });

  it('does not use a wildcard ORIGIN', async () => {
    const res = await preflight('/api/quizzes/rxjs/check', 'content-type');
    expect(String(res.headers['access-control-allow-origin'] ?? '')).not.toBe('*');
  });

  it('still refuses an origin outside the allow-list', async () => {
    const res = await request(app)
      .options('/api/quizzes/rxjs/check')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'x-question-receipt');

    // The rejected origin is never echoed back as allowed.
    expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.example');
  });

  it('keeps credentials disabled', async () => {
    const res = await preflight('/api/quizzes/rxjs/check', 'x-question-receipt');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });
});
