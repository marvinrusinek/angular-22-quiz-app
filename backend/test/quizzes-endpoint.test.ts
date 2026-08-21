import request from 'supertest';
import express from 'express';

import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createResponseGuard, setResponsePolicy } from '../src/api/response-guard';
import { fixtureDependencies, realRepository } from './helpers/fixtures';

function app(useReal = false) {
  const config = loadConfig({
    NODE_ENV: 'test',
    ALLOWED_ORIGINS: 'http://localhost:4200'
  } as NodeJS.ProcessEnv);
  return createApp(config, useReal ? { quizRepository: realRepository() } : fixtureDependencies());
}

/** Recursively collect every property NAME in a parsed body. */
function keysDeep(value: unknown, out: string[] = []): string[] {
  if (value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) keysDeep(item, out);
    return out;
  }
  for (const [key, nested] of Object.entries(value)) {
    out.push(key);
    keysDeep(nested, out);
  }
  return out;
}

const BANNED_KEYS = [
  'correct', 'isCorrect', 'is_correct', 'correctOptionIds', 'answerKey',
  'expectedAnswers', 'explanation', 'questions', 'options'
];

describe('GET /api/quizzes — shape', () => {
  it('returns 200 with a quizzes array', async () => {
    const res = await request(app()).get('/api/quizzes');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.quizzes)).toBe(true);
    expect(res.body.quizzes).toHaveLength(2);
  });

  it('each entry carries exactly the metadata fields', async () => {
    const res = await request(app()).get('/api/quizzes');
    for (const quiz of res.body.quizzes) {
      expect(Object.keys(quiz).sort()).toEqual([
        'difficulty', 'facts', 'image', 'milestone', 'questionCount', 'quizId', 'summary'
      ]);
    }
  });

  it('is deterministic in source order across repeated calls', async () => {
    const first = await request(app()).get('/api/quizzes');
    const second = await request(app()).get('/api/quizzes');
    expect(first.body.quizzes.map((q: { quizId: string }) => q.quizId)).toEqual(['rxjs', 'signals']);
    expect(second.body).toEqual(first.body);
  });

  it('reports the real question count without shipping the questions', async () => {
    const res = await request(app()).get('/api/quizzes');
    expect(res.body.quizzes[0].questionCount).toBe(2);
    expect(res.text).not.toContain('questionText');
  });
});

describe('GET /api/quizzes — raw response security', () => {
  it('PARSED body contains no banned property NAME anywhere', async () => {
    const res = await request(app(true)).get('/api/quizzes');
    const keys = keysDeep(res.body);
    for (const banned of BANNED_KEYS) {
      expect(keys).not.toContain(banned);
    }
  });

  it('RAW body text contains no banned field markers (defence in depth)', async () => {
    const res = await request(app(true)).get('/api/quizzes');
    for (const banned of ['"correct"', '"isCorrect"', '"is_correct"', '"explanation"', '"questions"', '"options"', '"answerKey"']) {
      expect(res.text).not.toContain(banned);
    }
  });

  it('carries no private source indexes or filesystem information', async () => {
    const res = await request(app(true)).get('/api/quizzes');
    for (const banned of ['sourceQuestionIndex', 'sourceOptionIndex', 'dataPath', 'quiz.json', 'C:\\', '/srv']) {
      expect(res.text).not.toContain(banned);
    }
  });

  it('a summary containing the WORDS correct/answer/explanation is NOT blocked', async () => {
    // The fixture summary is: "Learn which answer is correct and read the explanation."
    const res = await request(app()).get('/api/quizzes');
    expect(res.status).toBe(200);
    expect(res.body.quizzes[0].summary).toContain('correct');
    expect(res.body.quizzes[0].summary).toContain('explanation');
  });

  it('the real bank yields 20 quizzes and still no question data', async () => {
    const res = await request(app(true)).get('/api/quizzes');
    expect(res.body.quizzes).toHaveLength(20);
    expect(res.text).not.toContain('questionText');
  });
});

describe('GET /api/quizzes/:quizId — metadata only', () => {
  it('returns one quiz as metadata', async () => {
    const res = await request(app()).get('/api/quizzes/rxjs');
    expect(res.status).toBe(200);
    expect(res.body.quizId).toBe('rxjs');
    expect(Object.keys(res.body).sort()).toEqual([
      'difficulty', 'facts', 'image', 'milestone', 'questionCount', 'quizId', 'summary'
    ]);
  });

  it('does NOT return questions or options', async () => {
    const res = await request(app()).get('/api/quizzes/rxjs');
    expect(keysDeep(res.body)).not.toContain('questions');
    expect(res.text).not.toContain('questionText');
    expect(res.text).not.toContain('PRIVATE-EXPLANATION');
  });

  it('404s an unknown quiz in the standard shape', async () => {
    const res = await request(app()).get('/api/quizzes/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Quiz not found' } });
  });
});

describe('the guard is enforced centrally, not per route', () => {
  // These tests intentionally trigger the guard, which logs. Silence it so a
  // deliberate block does not read as a failure in test output; the dedicated
  // logging test below installs its own spy.
  let errorSpy: jest.SpyInstance;
  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => errorSpy.mockRestore());

  /** A deliberately unsafe route, to prove the middleware catches leaks. */
  function appWithLeakyRoute(policy?: 'SUBMITTED_REVIEW') {
    const config = loadConfig({ NODE_ENV: 'test', ALLOWED_ORIGINS: 'http://localhost:4200' } as NodeJS.ProcessEnv);
    void config;
    const leaky = express();
    leaky.use(createResponseGuard());
    leaky.get('/leak', (_req, res) => {
      if (policy) setResponsePolicy(res, policy);
      res.status(200).json({ review: [{ correctOptionIds: [1], explanation: 'x' }] });
    });
    leaky.get('/leak-nested', (_req, res) => {
      res.status(200).json({ data: [[{ answerKey: [1] }]] });
    });
    return leaky;
  }

  it('BLOCKS a leaky route that forgot to think about policy', async () => {
    const res = await request(appWithLeakyRoute()).get('/leak');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });

  it('never sends the unsafe payload', async () => {
    const res = await request(appWithLeakyRoute()).get('/leak');
    expect(res.text).not.toContain('correctOptionIds');
    expect(res.text).not.toContain('explanation');
  });

  it('blocks deeply nested leaks too', async () => {
    const res = await request(appWithLeakyRoute()).get('/leak-nested');
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('answerKey');
  });

  it('ALLOWS the same body once the route opts into SUBMITTED_REVIEW', async () => {
    const res = await request(appWithLeakyRoute('SUBMITTED_REVIEW')).get('/leak');
    expect(res.status).toBe(200);
    expect(res.body.review[0].correctOptionIds).toEqual([1]);
  });

  it('logs the route, policy and key name — never the value or the body', async () => {
    await request(appWithLeakyRoute()).get('/leak');

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toContain('/leak');
    expect(message).toContain('PUBLIC_METADATA');
    expect(message).toContain('correctOptionIds');
    // The VALUE and the body must not be logged.
    expect(message).not.toContain('[1]');
    expect(message).not.toContain('"explanation"');
  });
});

describe('existing guarantees still hold', () => {
  it('health is unchanged', async () => {
    const res = await request(app()).get('/api/health');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['status', 'uptimeSeconds']);
  });

  it('unknown routes still 404 in the standard shape', async () => {
    const res = await request(app()).get('/api/nope');
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Resource not found' } });
  });

  it('CORS still restricted, still no wildcard, still no credentials', async () => {
    const res = await request(app())
      .get('/api/quizzes')
      .set('Origin', 'https://evil.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('no-store still applies to metadata', async () => {
    const res = await request(app()).get('/api/quizzes');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
