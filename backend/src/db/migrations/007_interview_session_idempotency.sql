-- Request-level idempotency for Interview session creation.
--
-- WHY: POST /api/interview-sessions had no way for a client to safely retry
-- after a lost response (a Render gateway 504 during a Spring/Neon cold
-- start, in particular) — every retry minted a brand-new session, and the
-- client had no way to know whether the FIRST attempt had already committed.
-- The client now sends one client-generated key per logical start attempt
-- (the SAME key on every retry of that attempt); the server treats a second
-- request carrying an already-used key as "the same logical attempt", not a
-- new session.
--
-- SECURITY: an idempotency key is CREDENTIAL-EQUIVALENT — presenting it
-- retrieves the session and mints a fresh, independently-valid bearer token
-- for it (see interview_session_extra_tokens' own migration doc comment), so
-- it is stored exactly like a bearer token: only a one-way SHA-256 hash,
-- NEVER the raw key. A leaked/backed-up row can be used to look a session
-- UP by hash but cannot be turned back into the client-presented key itself.
-- Replay of a found key is also BOUNDED (see InterviewSessionService's
-- REPLAY_WINDOW_MS and MAX_EXTRA_TOKENS_PER_SESSION) and rate-limited
-- (IdempotencyReplayRateLimiter) — a captured key cannot mint tokens
-- indefinitely, or at unlimited speed.
--
-- idempotency_key_hash: SHA-256 hex of the client's opaque, cryptographically
-- -random key. NULLABLE and UNIQUE — Postgres already treats multiple NULLs
-- as distinct under a UNIQUE constraint (SQL-standard behavior), so any
-- caller that never sends a key (an older client, or any future creation
-- path that doesn't need this) is completely unaffected and cannot collide
-- with anything.
--
-- idempotency_request_hash: SHA-256 hex of the exact validated creation
-- request (mode/presetId/difficulty/topicIds/questionCount, canonically
-- ordered) that FIRST used this key. A retry presenting the same key must
-- also match this hash — if it doesn't, the key is being reused for a
-- materially different request, which is rejected rather than silently
-- returning an unrelated session. Always non-NULL when idempotency_key_hash
-- is non-NULL (enforced by the CHECK below), and meaningless (and NULL) when
-- it is not. Unlike the key itself, this is NOT a credential and is never
-- hashed: it is a fingerprint of non-sensitive configuration fields
-- (difficulty/topics/count), never presented back by a client to prove
-- possession of anything, so hashing it would add nothing.
--
-- No separate "issued at" column: the session's own created_at is the
-- idempotency key's issuance time too (both are written by the SAME
-- INSERT), which is what InterviewSessionService's REPLAY_WINDOW_MS check
-- reads.
ALTER TABLE interview_sessions
  ADD COLUMN idempotency_key_hash TEXT UNIQUE
             CHECK (idempotency_key_hash IS NULL OR length(trim(idempotency_key_hash)) = 64),
  ADD COLUMN idempotency_request_hash TEXT
             CHECK (idempotency_request_hash IS NULL OR length(trim(idempotency_request_hash)) = 64),
  ADD CONSTRAINT idempotency_hash_present_iff_key_present
    CHECK ((idempotency_key_hash IS NULL) = (idempotency_request_hash IS NULL));

-- Fast lookup on retry — every idempotent creation attempt, and every
-- replay-window/rate-limit/cap check that guards it, starts here.
CREATE INDEX IF NOT EXISTS idx_interview_sessions_idempotency_key_hash
  ON interview_sessions (idempotency_key_hash)
  WHERE idempotency_key_hash IS NOT NULL;
