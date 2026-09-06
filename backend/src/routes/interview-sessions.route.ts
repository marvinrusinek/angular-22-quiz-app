import { Router } from 'express';

import type { InterviewSessionService } from '../interview/session.service';
import { SessionServiceError } from '../interview/session.service';
import { extractBearerToken } from '../interview/session.token';
import { setResponsePolicy } from '../api/response-guard';
import { ApiError } from '../shared/errors';

/**
 * Interview session routes — a THIN adapter.
 *
 * Parses HTTP input, pulls the bearer token, calls the service, selects the
 * response policy, translates known errors. No generation, scoring, token
 * verification or persistence logic lives here.
 *
 * There are deliberately NO answer or submit routes yet.
 */
export function createInterviewSessionsRouter(service: InterviewSessionService): Router {
  const router = Router();

  router.post('/interview-sessions', async (req, res, next) => {
    // SESSION_CREATED is ACTIVE_ASSESSMENT plus a token exemption scoped to
    // THIS route. The global ban stays intact, so resume cannot leak it.
    setResponsePolicy(res, 'SESSION_CREATED');
    try {
      const session = await service.createSession(req.body ?? {});
      // Safe log: no token, no ids, no content.
      console.log(
        `[interview] created ${session.config.mode} session with ${session.questions.length} questions`
      );
      res.status(201).json(session);
    } catch (err: unknown) {
      next(translate(err));
    }
  });

  router.get('/interview-sessions/:sessionId', async (req, res, next) => {
    setResponsePolicy(res, 'ACTIVE_ASSESSMENT');
    try {
      const token = extractBearerToken(req.header('authorization'));
      const session = await service.resumeSession(req.params.sessionId ?? '', token);
      res.status(200).json(session);
    } catch (err: unknown) {
      next(translate(err));
    }
  });

  router.put('/interview-sessions/:sessionId/answers/:questionId', async (req, res, next) => {
    setResponsePolicy(res, 'ACTIVE_ASSESSMENT');
    try {
      const token = extractBearerToken(req.header('authorization'));
      const saved = await service.saveAnswer(
        req.params.sessionId ?? '',
        req.params.questionId ?? '',
        token,
        req.body ?? {}
      );
      // Safe log: counts only — never the selection, the question or the ids.
      console.log(`[interview] answer saved (${saved.answeredCount}/${saved.questionCount})`);
      res.status(200).json({
        saved: true,
        questionId: saved.questionId,
        selectedOptionIds: saved.selectedOptionIds,
        answeredCount: saved.answeredCount,
        questionCount: saved.questionCount
      });
    } catch (err: unknown) {
      next(translate(err));
    }
  });

  router.put('/interview-sessions/:sessionId/review/:questionId', async (req, res, next) => {
    setResponsePolicy(res, 'ACTIVE_ASSESSMENT');
    try {
      const token = extractBearerToken(req.header('authorization'));
      const result = await service.setFlagged(
        req.params.sessionId ?? '',
        req.params.questionId ?? '',
        token,
        req.body ?? {}
      );
      // Safe log: a boolean flag only — never the question or its content.
      console.log(`[interview] review flag ${result.flagged ? 'set' : 'cleared'}`);
      res.status(200).json({ questionId: result.questionId, flagged: result.flagged });
    } catch (err: unknown) {
      next(translate(err));
    }
  });

  // SUBMITTED_REVIEW is the only policy that permits correctOptionIds and
  // explanation. It is set on these two routes ONLY; active routes keep
  // rejecting both.
  router.post('/interview-sessions/:sessionId/submit', async (req, res, next) => {
    setResponsePolicy(res, 'SUBMITTED_REVIEW');
    try {
      const token = extractBearerToken(req.header('authorization'));
      const result = await service.submitSession(req.params.sessionId ?? '', token, req.body);
      // Safe log: counts and the expiry flag only.
      console.log(
        `[interview] submitted ${result.total} questions (byExpiry=${result.submittedByExpiry})`
      );
      res.status(200).json(result);
    } catch (err: unknown) {
      next(translate(err));
    }
  });

  router.get('/interview-sessions/:sessionId/result', async (req, res, next) => {
    setResponsePolicy(res, 'SUBMITTED_REVIEW');
    try {
      const token = extractBearerToken(req.header('authorization'));
      res.status(200).json(await service.getResult(req.params.sessionId ?? '', token));
    } catch (err: unknown) {
      next(translate(err));
    }
  });

  return router;
}

/** Map service errors onto the shared API error vocabulary. */
function translate(err: unknown): unknown {
  if (!(err instanceof SessionServiceError)) return err;

  switch (err.code) {
    case 'BAD_REQUEST':
      return ApiError.badRequest(err.message);
    case 'UNAUTHORIZED':
      // Identical for missing, malformed, unknown-session and wrong token.
      return ApiError.unauthorized('Invalid session credentials');
    case 'SESSION_EXPIRED':
      return ApiError.sessionExpired(err.message);
    case 'CONFLICT':
      return ApiError.conflict(err.message);
    default:
      return new ApiError('INTERNAL', 'Internal server error');
  }
}
