import request from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createQuizRepository } from '../src/quiz/quiz.repository';
import { fixtureRepository, FIXTURE_SOURCE } from './helpers/fixtures';

/**
 * The repository now exists and holds the answer key in memory. This suite
 * proves that adding it did NOT open any HTTP path to it — Stage 2 introduces
 * no public quiz endpoint.
 *
 * Stage 15: this suite is about the HTTP SURFACE (does any route serve the
 * bank?), not about the real bank's content, so the synthetic FIXTURE_SOURCE
 * (same shape, same 'rxjs:q:0' question id) proves the same thing without a
 * dependency on `backend/data/quiz.json`.
 */
function app() {
  return createApp(
    loadConfig({ NODE_ENV: 'test', ALLOWED_ORIGINS: 'http://localhost:4200' } as NodeJS.ProcessEnv),
    { quizRepository: fixtureRepository() }
  );
}

const PATHS = [
  '/api/quiz.json',
  '/api/quiz',
  '/api/data/quiz.json',
  '/data/quiz.json',
  '/quiz.json',
  '/assets/data/quiz.json',
  '/backend/data/quiz.json',
  '/api/questions',
  '/api/questions/rxjs:q:0'
];

describe('no HTTP route reaches the private bank', () => {
  it.each(PATHS)('404s %s', async (path) => {
    const res = await request(app()).get(path);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it.each([
    '/api/../data/quiz.json',
    '/api/%2e%2e/data/quiz.json',
    '/api/..%2fdata%2fquiz.json',
    '/api/health/../../data/quiz.json'
  ])('traversal attempt %s never returns quiz data', async (path) => {
    const res = await request(app()).get(path);
    expect([301, 302, 400, 404]).toContain(res.status);
    const body = JSON.stringify(res.body ?? '');
    expect(body).not.toContain('questionText');
    expect(body).not.toContain('milestone');
  });

  it('no response anywhere contains answer-key field names', async () => {
    for (const path of [...PATHS, '/api/health', '/']) {
      const res = await request(app()).get(path);
      const serialized = JSON.stringify(res.body ?? '');
      for (const banned of ['isCorrect', 'correctOptionIds', 'answerKey', 'expectedAnswers', 'explanation']) {
        expect(serialized).not.toContain(banned);
      }
    }
  });

  it('a distinctive question text from the bank never appears in any response', async () => {
    const repo = createQuizRepository({ source: FIXTURE_SOURCE });
    const sample = repo.getQuestionById('rxjs:q:0')!;
    const distinctive = sample.questionText.slice(0, 24);

    // Includes the LIVE metadata routes — they must not leak question text.
    for (const path of [...PATHS, '/api/health', '/api/quizzes', '/api/quizzes/rxjs']) {
      const res = await request(app()).get(path);
      expect(res.text ?? '').not.toContain(distinctive);
    }
  });

  it('a distinctive explanation from the bank never appears in any response', async () => {
    const repo = createQuizRepository({ source: FIXTURE_SOURCE });
    const distinctive = repo.getQuestionById('rxjs:q:0')!.explanation.slice(0, 24);

    for (const path of [...PATHS, '/api/quizzes', '/api/quizzes/rxjs']) {
      const res = await request(app()).get(path);
      expect(res.text ?? '').not.toContain(distinctive);
    }
  });

  it('the app source contains no express.static and no sendFile', () => {
    // Structural guard: a future static mount would defeat every test above.
    const appSource = readFileSync(resolve(__dirname, '../src/app.ts'), 'utf8');
    expect(appSource).not.toMatch(/express\.static/);
    expect(appSource).not.toMatch(/sendFile|res\.download|serve-static/);
  });
});
