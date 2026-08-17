import express, { type Express } from 'express';
import cors, { type CorsOptions } from 'cors';

import type { AppConfig } from './config';
import type { AppDependencies } from './dependencies';
import { createErrorHandler, notFoundHandler } from './shared/error-handler';
import { securityHeaders } from './shared/security-headers';
import { createResponseGuard } from './api/response-guard';
import { isStackBlitzPreviewOrigin } from './api/preview-origins';
import { createHealthRouter } from './routes/health.route';
import { createQuizzesRouter } from './routes/quizzes.route';
import { createRateLimiter } from './shared/rate-limit';
import { createInterviewSessionsRouter } from './routes/interview-sessions.route';

/**
 * Builds the Express app WITHOUT listening, so tests drive it in-process via
 * supertest and never bind a port.
 *
 * Dependencies are passed in rather than resolved from module state — see
 * dependencies.ts.
 */
export function createApp(config: AppConfig, dependencies: AppDependencies): Express {
  const app = express();

  // Don't advertise the stack.
  app.disable('x-powered-by');

  app.use(securityHeaders);
  app.use(cors(buildCorsOptions(config)));

  // Installed BEFORE any route so every JSON body — including error envelopes
  // — passes the policy check. A route cannot opt out by forgetting a helper.
  app.use(createResponseGuard());

  // Sessions carry at most a short array of option ids; a small cap makes
  // oversized-body abuse a 413 rather than memory pressure.
  app.use(express.json({ limit: '32kb' }));

  app.use('/api', createHealthRouter());
  /**
   * The check endpoint releases correctness and an explanation per call, so it
   * is the one route that needs its own throttle: unlimited, it is a complete
   * answer-key oracle. Question DELIVERY is deliberately not limited here — it
   * exposes only text the client is authorized to render.
   */
  const checkRateLimiter = createRateLimiter({
    capacity: 40,          // generous for a real quiz run…
    refillPerSecond: 1,    // …but ~185 reveals then take minutes, not seconds
    now: dependencies.now
  });

  app.use('/api', createQuizzesRouter({
    repository: dependencies.quizRepository,
    receiptSecret: config.topicQuizReceiptSecret,
    now: dependencies.now,
    checkRateLimiter: checkRateLimiter.middleware
  }));

  // Registered only when wired, so metadata-only test apps stay minimal and no
  // route can accidentally run without its service.
  if (dependencies.interviewSessionService) {
    app.use('/api', createInterviewSessionsRouter(dependencies.interviewSessionService));
  }

  app.use(notFoundHandler);
  app.use(createErrorHandler({ isProduction: config.isProduction }));

  return app;
}

/**
 * CORS against an exact allow-list.
 *
 * `credentials` stays FALSE by design: the session token travels in an
 * Authorization header, not a cookie, so the browser never needs to send
 * credentials cross-origin. That keeps us clear of the wildcard-with-credentials
 * trap entirely.
 *
 * A disallowed origin is not an error — the callback reports "not allowed" and
 * the response simply carries no CORS headers, which the browser enforces.
 * Throwing here would turn a routine cross-origin probe into a 500.
 */
function buildCorsOptions(config: AppConfig): CorsOptions {
  const allowed = new Set(config.allowedOrigins);

  return {
    origin(origin, callback) {
      // No Origin header: same-origin, curl, or a server-side caller. Nothing
      // to grant, nothing to block — CORS simply does not apply.
      if (origin === undefined) {
        callback(null, true);
        return;
      }
      // The exact list still decides for every deployed host. StackBlitz is the
      // one caller whose origin is regenerated per session, so it cannot be
      // enumerated ahead of time — see preview-origins.ts for why this is a
      // parsed hostname test on three named vendor domains and not a wildcard.
      callback(null, allowed.has(origin) || isStackBlitzPreviewOrigin(origin));
    },
    methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    // The two Topic Quiz receipt headers must be listed explicitly.
    //
    // A custom request header makes the request non-simple, so the browser
    // sends a CORS PREFLIGHT first and refuses the real request unless the
    // header is named in Access-Control-Allow-Headers. Omitting them meant
    // POST /questions/start and POST /check never left the browser — no
    // response, no server log, and an error Angular could only report as a
    // generic failure. POST /attempts kept working precisely because it sends
    // no custom header, which is what made the defect look like a client bug.
    //
    // Named individually rather than widened: these are the only two custom
    // headers the API accepts.
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Attempt-Receipt',
      'X-Question-Receipt'
    ],
    credentials: false,
    maxAge: 600
  };
}
