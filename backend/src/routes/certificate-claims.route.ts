import { Router, type RequestHandler } from 'express';

import type { CertificateClaimService } from '../certificate/certificate-claim.service';
import { CertificateClaimError } from '../certificate/certificate-claim.types';
import { normalizeEmail } from '../certificate/certificate-claim.repository';
import { setResponsePolicy } from '../api/response-guard';
import { ApiError } from '../shared/errors';
import { createRateLimiter, type RateLimiter } from '../shared/rate-limit';

/**
 * Certificate-claim routes — a THIN adapter, same discipline as
 * interview-sessions.route.ts: parse input, call the service, translate
 * known errors. No validation, token, or persistence logic lives here.
 *
 * FEATURE-FLAGGED: when the service is undefined (feature disabled — see
 * dependencies.ts), every route responds 503 immediately, before touching
 * anything else. This is what lets the feature ship disabled by default
 * with zero risk to Topic Quiz / Interview Mode, and with no email
 * configuration required at all while off.
 */
export function createCertificateClaimsRouter(service: CertificateClaimService | undefined): Router {
  const router = Router();

  if (!service) {
    // Registered on each EXACT path this router otherwise defines — never a
    // bare router.use(), which would match every request reaching this
    // router regardless of path and swallow unrelated /api/* 404s (and
    // worse, path-traversal-probe routes that existing tests specifically
    // assert still 404 through notFoundHandler, not a certificate-claims
    // response) behind a misleading 503.
    const disabled: RequestHandler = (_req, res) => {
      res.status(503).json({ error: { code: 'BAD_REQUEST', message: 'Certificate claims are not available' } });
    };
    router.post('/certificate-claims', disabled);
    router.post('/certificate-claims/resend', disabled);
    router.post('/certificate-claims/verify/preview', disabled);
    router.post('/certificate-claims/verify/confirm', disabled);
    router.get('/certificates/me', disabled);
    return router;
  }

  // Two independent limiters per write endpoint: by IP (the only signal
  // available before we know whether the email is even well-formed) AND by
  // normalized email (so one email cannot be hammered from many
  // addresses/proxies, and one IP cannot hammer many emails at unlimited
  // speed either — both must pass).
  const byIp = (capacity: number, refillPerSecond: number): RateLimiter =>
    createRateLimiter({ capacity, refillPerSecond });
  const byEmailBody = (capacity: number, refillPerSecond: number): RateLimiter =>
    createRateLimiter({
      capacity,
      refillPerSecond,
      keyFor: (req) => {
        const email = (req.body as { email?: unknown } | undefined)?.email;
        return typeof email === 'string' ? normalizeEmail(email) : 'unknown';
      }
    });

  const submitByIp = byIp(10, 1 / 30); // 10 burst, 1 per 30s sustained
  const submitByEmail = byEmailBody(5, 1 / 60);
  const resendByIp = byIp(10, 1 / 30);
  const resendByEmail = byEmailBody(3, 1 / 60);
  // Verification endpoints are keyed by IP only — a token is a 43-char
  // CSPRNG value, so the limiter here is a speed bump against scanning
  // noise, not the primary defense (the token's own entropy is).
  const verifyByIp = byIp(30, 1);

  router.post(
    '/certificate-claims',
    submitByIp.middleware,
    submitByEmail.middleware,
    async (req, res, next) => {
      setResponsePolicy(res, 'CERTIFICATE_CLAIM');
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const idempotencyKey = req.header('idempotency-key');
        const result = await service.submitClaim({
          name: body['name'],
          email: body['email'],
          eligibilitySnapshot: normalizeEligibilitySnapshot(body['eligibilitySnapshot']),
          idempotencyKey: idempotencyKey && idempotencyKey.length > 0 ? idempotencyKey : undefined
        });
        res.status(202).json(result);
      } catch (err: unknown) {
        next(translate(err));
      }
    }
  );

  router.post(
    '/certificate-claims/resend',
    resendByIp.middleware,
    resendByEmail.middleware,
    async (req, res, next) => {
      setResponsePolicy(res, 'CERTIFICATE_CLAIM');
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const result = await service.resendClaim(body['email']);
        res.status(202).json(result);
      } catch (err: unknown) {
        next(translate(err));
      }
    }
  );

  router.post(
    '/certificate-claims/verify/preview',
    verifyByIp.middleware,
    async (req, res, next) => {
      setResponsePolicy(res, 'CERTIFICATE_CLAIM');
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const preview = await service.previewToken(body['token']);
        res.status(200).json(preview);
      } catch (err: unknown) {
        next(translate(err));
      }
    }
  );

  // The ONLY mutating verification step. Never a GET — opening the emailed
  // link must only ever load a confirmation page (the Angular route calling
  // the preview endpoint above); THIS is the explicit user-triggered POST
  // that actually consumes the token and issues the certificate.
  router.post(
    '/certificate-claims/verify/confirm',
    verifyByIp.middleware,
    async (req, res, next) => {
      setResponsePolicy(res, 'CERTIFICATE_CLAIM');
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const confirmed = await service.confirmToken(body['token']);
        res.status(200).json(confirmed);
      } catch (err: unknown) {
        next(translate(err));
      }
    }
  );

  router.get('/certificates/me', async (req, res, next) => {
    setResponsePolicy(res, 'CERTIFICATE_CLAIM');
    try {
      const token = extractBearerRetrievalToken(req.header('authorization'));
      const certificate = await service.getCertificateByRetrievalToken(token);
      res.status(200).json(certificate);
    } catch (err: unknown) {
      next(translate(err));
    }
  });

  return router;
}

function extractBearerRetrievalToken(header: string | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer[ ]+(\S+)$/i.exec(header.trim());
  return match ? match[1] : undefined;
}

/**
 * The client-asserted eligibility snapshot is AUDIT-ONLY (see
 * certificate-claim.types.ts) — normalized defensively here so a malformed
 * or missing payload can never throw partway through persistence, not
 * because its shape is trusted for anything.
 */
function normalizeEligibilitySnapshot(raw: unknown): {
  achievementIds: readonly string[];
  qualifyingInterviewCount: number;
  qualificationStartedAt: number | null;
} {
  const value = (raw ?? {}) as Record<string, unknown>;
  const achievementIds = Array.isArray(value['achievementIds'])
    ? value['achievementIds'].filter((v): v is string => typeof v === 'string').slice(0, 100)
    : [];
  const qualifyingInterviewCount =
    typeof value['qualifyingInterviewCount'] === 'number' && Number.isFinite(value['qualifyingInterviewCount'])
      ? Math.trunc(value['qualifyingInterviewCount'])
      : 0;
  const qualificationStartedAt =
    typeof value['qualificationStartedAt'] === 'number' && Number.isFinite(value['qualificationStartedAt'])
      ? value['qualificationStartedAt']
      : null;
  return { achievementIds, qualifyingInterviewCount, qualificationStartedAt };
}

function translate(err: unknown): unknown {
  if (!(err instanceof CertificateClaimError)) return err;

  switch (err.code) {
    case 'VALIDATION':
      return ApiError.badRequest(err.message);
    case 'FEATURE_DISABLED':
      return new ApiError('BAD_REQUEST', err.message);
    case 'TOKEN_INVALID':
    case 'RETRIEVAL_INVALID':
      return ApiError.notFound(err.message);
    case 'TOKEN_EXPIRED':
      return new ApiError('GONE', err.message);
    case 'TOKEN_ALREADY_USED':
      return ApiError.conflict(err.message);
    case 'TOKEN_LIMIT_REACHED':
      return new ApiError('BAD_REQUEST', 'Too many pending verification links — wait for one to expire and try again');
    default:
      return new ApiError('INTERNAL', 'Internal server error');
  }
}
