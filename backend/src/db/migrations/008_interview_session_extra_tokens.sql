-- Additional valid bearer tokens for an Interview session, alongside
-- interview_sessions.token_hash (the ORIGINAL/canonical token, unchanged).
--
-- WHY: an idempotent retry of session creation (migration 007) has to give
-- the caller SOME working credential, but the raw token from the original
-- creation is never persisted (only its hash is, by design) — so a second
-- caller resolving the same idempotency key cannot be handed the ORIGINAL
-- raw token back. A fresh token must be minted for them instead.
--
-- Two callers can each be genuinely live and waiting on their own response
-- at once: two truly concurrent requests carrying the same Idempotency-Key
-- (e.g. a network-level duplicate of one logical request), or a client that
-- retried after an AMBIGUOUS failure (a 504, or its own request being
-- abandoned by a page reload) whose original request had, in fact, already
-- reached the server and is still being processed. In both cases the server
-- cannot know which of several 201 responses actually reaches a live caller
-- — so EVERY token it ever hands out for a given idempotency-key resolution
-- must keep working, indefinitely, rather than only the most recent one.
--
-- This is why minting an additional token INSERTS a new row here rather than
-- overwriting interview_sessions.token_hash (a single-slot "rotate", which
-- would silently invalidate whichever earlier response's token a live caller
-- was still holding). See InterviewSessionRepository#mintAdditionalToken.
--
-- Authentication therefore checks token_hash on interview_sessions FIRST
-- (the common case — zero extra queries), falling back to this table only
-- when that does not match (see InterviewSessionService#authenticate) —
-- itself a PRIMARY KEY lookup, so that fallback is indexed too.
--
-- BOUNDED GROWTH: InterviewSessionService caps how many rows can accumulate
-- per session (MAX_EXTRA_TOKENS_PER_SESSION) and rate-limits how fast they
-- can be minted (IdempotencyReplayRateLimiter) — this table has no INSERT
-- path that bypasses either. CLEANUP: ON DELETE CASCADE above means a
-- session's extra tokens can never outlive the session row itself; no
-- separate reaper job is needed for this table specifically.
CREATE TABLE IF NOT EXISTS interview_session_extra_tokens (
  session_id  TEXT     NOT NULL
                       REFERENCES interview_sessions (id)
                       ON DELETE CASCADE,
  token_hash  TEXT     NOT NULL
                       CHECK (length(token_hash) = 64),
  created_at  BIGINT   NOT NULL,

  -- Globally unique, matching interview_sessions.token_hash's own
  -- one-token-one-owner expectation: a SHA-256 collision across two
  -- different sessions' independently-CSPRNG-drawn tokens is not a
  -- practical possibility, so this is a correctness backstop, not a
  -- capacity limit.
  PRIMARY KEY (token_hash)
);

-- Every authentication check against a non-matching primary token scans this
-- table by session_id — keep that fast.
CREATE INDEX IF NOT EXISTS idx_interview_session_extra_tokens_session_id
  ON interview_session_extra_tokens (session_id);
