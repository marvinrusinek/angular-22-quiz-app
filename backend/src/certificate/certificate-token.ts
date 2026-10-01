import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Verification and retrieval tokens for the certificate-claim feature.
 *
 * Deliberately a SEPARATE module from ../interview/session.token.ts rather
 * than a shared import: the two bounded contexts (Interview Mode sessions,
 * certificate claims) already keep their own token modules by this
 * codebase's own convention, and a future change to one's token shape must
 * not risk silently affecting the other. The primitives are intentionally
 * identical — CSPRNG bytes, base64url, SHA-256 hash-only storage,
 * constant-time compare — because that scheme is already audited and there
 * is no reason to invent a second one.
 */

const TOKEN_BYTES = 32;

/** base64url of 32 bytes -> 43 chars, no padding. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/** A fresh (rawToken, tokenHash) pair. The raw value is NEVER persisted. */
export function generateToken(): { readonly rawToken: string; readonly tokenHash: string } {
  const rawToken = base64url(randomBytes(TOKEN_BYTES));
  return { rawToken, tokenHash: hashToken(rawToken) };
}

/** Cheap structural check before any database work. */
export function isWellFormedToken(rawToken: string): boolean {
  return TOKEN_PATTERN.test(rawToken);
}

/**
 * Constant-time comparison of two SHA-256 hex digests.
 *
 * Both are fixed-length (64 hex chars) when well-formed, so timingSafeEqual
 * never throws on a length mismatch from a legitimate value — the length
 * guard below covers a malformed stored hash, not a timing signal.
 */
export function tokenMatches(rawToken: string, storedHash: string): boolean {
  if (!isWellFormedToken(rawToken)) return false;

  const presented = Buffer.from(hashToken(rawToken), 'utf8');
  const stored = Buffer.from(storedHash, 'utf8');
  if (presented.length !== stored.length) return false;

  return timingSafeEqual(presented, stored);
}
