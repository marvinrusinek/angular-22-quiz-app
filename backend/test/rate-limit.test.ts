import express from 'express';
import request from 'supertest';

import { createRateLimiter } from '../src/shared/rate-limit';

/**
 * The check-endpoint throttle.
 *
 * `/check` releases correctness and an explanation per call, so without a limit
 * it is a complete answer-key oracle — roughly 186 requests would drain the
 * bank. This does not make extraction impossible; it makes it slow, visible and
 * attributable.
 *
 * The clock is INJECTED throughout: a limiter tested with real time is either
 * slow or flaky, and this suite must be neither.
 */

/** A tiny app whose only job is to be rate-limited. */
function appWith(options: {
  capacity: number;
  refillPerSecond: number;
  now: () => number;
  keyFor?: (req: express.Request) => string;
}) {
  const limiter = createRateLimiter(options);
  const app = express();
  app.use('/limited', limiter.middleware, (_req, res) => { res.status(200).json({ ok: true }); });
  app.use('/open', (_req, res) => { res.status(200).json({ ok: true }); });
  return { app, limiter };
}

describe('token bucket', () => {
  let clock = 1_700_000_000_000;
  const now = () => clock;

  beforeEach(() => { clock = 1_700_000_000_000; });

  it('allows requests up to capacity', async () => {
    const { app } = appWith({ capacity: 3, refillPerSecond: 1, now });

    for (let i = 0; i < 3; i++) {
      expect((await request(app).get('/limited')).status).toBe(200);
    }
  });

  it('returns 429 once the bucket is empty', async () => {
    const { app } = appWith({ capacity: 2, refillPerSecond: 1, now });

    await request(app).get('/limited');
    await request(app).get('/limited');
    const blocked = await request(app).get('/limited');

    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
  });

  it('sets Retry-After, never zero', async () => {
    const { app } = appWith({ capacity: 1, refillPerSecond: 0.5, now });

    await request(app).get('/limited');
    const blocked = await request(app).get('/limited');

    expect(blocked.status).toBe(429);
    const retryAfter = Number(blocked.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
  });

  it('refills deterministically as the injected clock advances', async () => {
    const { app } = appWith({ capacity: 2, refillPerSecond: 1, now });

    await request(app).get('/limited');
    await request(app).get('/limited');
    expect((await request(app).get('/limited')).status).toBe(429);

    clock += 1000;                                   // one token restored
    expect((await request(app).get('/limited')).status).toBe(200);
    expect((await request(app).get('/limited')).status).toBe(429);

    clock += 60_000;                                 // long idle → refills to capacity, not beyond
    expect((await request(app).get('/limited')).status).toBe(200);
    expect((await request(app).get('/limited')).status).toBe(200);
    expect((await request(app).get('/limited')).status).toBe(429);
  });

  it('never exceeds capacity however long the client idles', async () => {
    const { app } = appWith({ capacity: 2, refillPerSecond: 1, now });

    clock += 86_400_000;                             // a day
    expect((await request(app).get('/limited')).status).toBe(200);
    expect((await request(app).get('/limited')).status).toBe(200);
    expect((await request(app).get('/limited')).status).toBe(429);
  });

  it('ISOLATES different keys', async () => {
    let key = 'client-a';
    const { app } = appWith({ capacity: 1, refillPerSecond: 1, now, keyFor: () => key });

    expect((await request(app).get('/limited')).status).toBe(200);
    expect((await request(app).get('/limited')).status).toBe(429);

    key = 'client-b';                                // a different caller is unaffected
    expect((await request(app).get('/limited')).status).toBe(200);

    key = 'client-a';                                // …and the first is still limited
    expect((await request(app).get('/limited')).status).toBe(429);
  });

  it('reset() clears every bucket', async () => {
    const { app, limiter } = appWith({ capacity: 1, refillPerSecond: 1, now });

    await request(app).get('/limited');
    expect((await request(app).get('/limited')).status).toBe(429);

    limiter.reset();
    expect((await request(app).get('/limited')).status).toBe(200);
  });

  it('does not throttle routes it is not mounted on', async () => {
    const { app } = appWith({ capacity: 1, refillPerSecond: 1, now });

    await request(app).get('/limited');
    expect((await request(app).get('/limited')).status).toBe(429);

    // Question delivery is deliberately unlimited — it exposes only authorized
    // text — so an exhausted check bucket must not affect it.
    for (let i = 0; i < 5; i++) {
      expect((await request(app).get('/open')).status).toBe(200);
    }
  });

  it('the 429 body leaks nothing about the request', async () => {
    const { app } = appWith({ capacity: 0, refillPerSecond: 1, now });

    const blocked = await request(app).get('/limited');
    const serialized = JSON.stringify(blocked.body);

    expect(serialized).not.toContain('quiz');
    expect(serialized).not.toContain('question');
    expect(serialized).not.toContain('correct');
    expect(Object.keys(blocked.body)).toEqual(['error']);
  });
});
