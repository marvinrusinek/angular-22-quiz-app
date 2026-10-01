-- Certificate claim/verification/issuance — the Angular Interview Master
-- certificate moves from a pure-browser localStorage record to a real,
-- email-verified, backend-issued one. Node-owned, like every migration
-- (Spring never authors schema; ddl-auto=validate only maps entities it
-- knows about, so these new tables are invisible to it and require no
-- Spring-side change).
--
-- ELIGIBILITY STAYS BROWSER-REPORTED. This migration does not attempt to
-- verify "5 completed interviews" server-side — that would require a
-- persistent claimant identity bound to interview_sessions from the START
-- of each session, which does not exist today and is out of scope. What
-- THIS schema adds is honest and narrower: the email is real (verified by
-- click-through), one certificate per verified email is a DATABASE
-- guarantee, and a completion is recorded exactly once for notification
-- purposes. eligibility_snapshot_json is audit-only and never re-derived
-- or trusted by any query here.
--
-- Conventions match the existing interview_sessions schema: TEXT ids with
-- a non-empty CHECK, BIGINT epoch-ms timestamps, hash columns
-- CHECK (length = 64) for SHA-256 hex, SMALLINT 0/1 only where a real
-- tri-state isn't needed (not used here — every flag here is a nullable
-- timestamp, which also records WHEN, not just whether).

CREATE TABLE IF NOT EXISTS certificate_claims (
  id                    TEXT    PRIMARY KEY CHECK (length(trim(id)) > 0),

  -- lower(trim(email)) computed ONCE at insert time (application-side, not
  -- a GENERATED column) so every uniqueness/lookup query compares apples to
  -- apples without re-normalizing on every read.
  email_normalized      TEXT    NOT NULL CHECK (length(trim(email_normalized)) > 0),

  claimed_name          TEXT    NOT NULL CHECK (length(trim(claimed_name)) > 0),

  status                TEXT    NOT NULL CHECK (status IN ('pending', 'verified')),

  -- Client-asserted achievement/interview-count snapshot at claim time.
  -- AUDIT ONLY: never read back to authorize anything. Stored as TEXT JSON,
  -- matching this codebase's existing convention (frozen_result etc.) of
  -- parsing-and-revalidating JSON app-side rather than trusting a native
  -- JSONB column's contents.
  eligibility_snapshot_json TEXT NOT NULL,

  created_at            BIGINT  NOT NULL CHECK (created_at > 0),
  verified_at            BIGINT,

  -- Idempotent submission, identical mechanism to migration 007: a client
  -- retrying POST /certificate-claims after a lost response (or an honest
  -- double-click) must resolve to the SAME claim, never a second row.
  idempotency_key_hash     TEXT UNIQUE
                           CHECK (idempotency_key_hash IS NULL OR length(trim(idempotency_key_hash)) = 64),
  idempotency_request_hash TEXT
                           CHECK (idempotency_request_hash IS NULL OR length(trim(idempotency_request_hash)) = 64),
  CONSTRAINT certificate_claims_idempotency_hash_present_iff_key_present
    CHECK ((idempotency_key_hash IS NULL) = (idempotency_request_hash IS NULL))
);

-- At most ONE outstanding (pending) claim per email at a time — this is
-- what stops two honest-but-racing submissions (refresh, double-click, a
-- retry with no Idempotency-Key at all) from ever creating two pending
-- rows for the same address. A VERIFIED email opening a new claim is
-- handled in application code as recovery (see certificate-claim.service),
-- never a second pending row either, but that case is guarded by
-- issued_certificates' own UNIQUE(email_normalized) below.
CREATE UNIQUE INDEX IF NOT EXISTS idx_certificate_claims_email_pending
  ON certificate_claims (email_normalized) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_certificate_claims_email
  ON certificate_claims (email_normalized);

CREATE TABLE IF NOT EXISTS certificate_verification_tokens (
  token_hash  TEXT    PRIMARY KEY CHECK (length(token_hash) = 64),
  claim_id    TEXT    NOT NULL REFERENCES certificate_claims (id) ON DELETE CASCADE,
  created_at  BIGINT  NOT NULL,
  expires_at  BIGINT  NOT NULL,

  -- Single-use. NULL until consumed; set by an atomic
  -- UPDATE ... WHERE used_at IS NULL, so two simultaneous requests
  -- presenting the same raw token can never both succeed.
  used_at     BIGINT
);

CREATE INDEX IF NOT EXISTS idx_certificate_verification_tokens_claim_id
  ON certificate_verification_tokens (claim_id);

-- Bounds how many outstanding (unexpired, unused) tokens a single claim can
-- accumulate via resend — checked in application code before minting a new
-- one (mirrors MAX_EXTRA_TOKENS_PER_SESSION's role for interview sessions).
-- No separate column needed: the repository counts rows WHERE claim_id = ?
-- AND used_at IS NULL AND expires_at > now.

CREATE TABLE IF NOT EXISTS issued_certificates (
  id               TEXT    PRIMARY KEY CHECK (length(trim(id)) > 0),  -- e.g. AQ-2026-000128-K, minted server-side
  email_normalized TEXT    NOT NULL UNIQUE,  -- DB-enforced: one certificate per email, EVER
  claim_id         TEXT    NOT NULL UNIQUE REFERENCES certificate_claims (id),
  recipient_name   TEXT    NOT NULL,
  issued_at        BIGINT  NOT NULL
);

CREATE TABLE IF NOT EXISTS certificate_retrieval_tokens (
  token_hash     TEXT    PRIMARY KEY CHECK (length(token_hash) = 64),
  certificate_id TEXT    NOT NULL REFERENCES issued_certificates (id) ON DELETE CASCADE,
  created_at     BIGINT  NOT NULL,
  expires_at     BIGINT  NOT NULL,

  -- Revocable: a lost/compromised retrieval credential can be invalidated
  -- without touching the certificate itself. Recovery (re-verifying the
  -- same email) mints a FRESH token rather than ever un-revoking an old one.
  revoked_at     BIGINT
);

CREATE INDEX IF NOT EXISTS idx_certificate_retrieval_tokens_certificate_id
  ON certificate_retrieval_tokens (certificate_id);

-- Transactional outbox for BOTH the claimant-facing verification/resend
-- emails and Marvin's owner-completion notice. ONE row per (kind,
-- reference_id) — this composite primary key is the actual
-- duplicate-notification guard: a retry, a concurrent worker, or a second
-- logical trigger for the same underlying event collapses onto the SAME
-- row rather than inserting a second one.
--
-- The raw per-send EMAIL PAYLOAD (not the verification token itself — that
-- never changes its storage: certificate_verification_tokens still stores
-- ONLY a SHA-256 hash, same as before) is encrypted and held here JUST long
-- enough to survive this row's own retry window. See encrypted_payload's own
-- column comment below for the full reasoning — this is what makes a SYSTEM
-- RETRY resend a byte-IDENTICAL payload (required by the intended provider,
-- Resend — see certificate-notification-dispatcher.ts), while a
-- user-initiated RESEND still gets a genuinely NEW one.
CREATE TABLE IF NOT EXISTS certificate_notification_outbox (
  kind          TEXT    NOT NULL CHECK (kind IN ('claimant_verify', 'owner_claim_notice')),
  reference_id  TEXT    NOT NULL,  -- claim_id for claimant_verify, certificate_id for owner_claim_notice
  status        TEXT    NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  attempts      INTEGER NOT NULL DEFAULT 0,

  -- Distinguishes a SYSTEM RETRY of one logical send (crash-after-provider-
  -- acceptance, a transient failure) from a user-initiated RESEND, which
  -- must NOT be suppressed by provider-side idempotency the way a retry
  -- should be. All attempts within one generation share ONE idempotency key
  -- (kind:reference_id:generation); requesting a resend increments this,
  -- starting a fresh generation with its own key — see
  -- certificate-claim.service.ts#resendClaim and
  -- certificate-notification-dispatcher.ts's idempotency-key derivation.
  generation    INTEGER NOT NULL DEFAULT 0,

  -- AES-256-GCM ciphertext of {to, recipientName, verificationUrl} for a
  -- PENDING claimant_verify row only — NULL for owner_claim_notice (that
  -- payload is already identically reconstructible from durable rows every
  -- time, so it needs no stored copy) and NULL once no longer needed.
  -- Cleared (set back to NULL) the instant a row leaves this "might still
  -- be retried" state: on markNotificationSent, on a PERMANENT
  -- markNotificationFailed (attempt cap reached), and on requeueForResend
  -- (new generation ⇒ a fresh payload is due anyway). A row therefore never
  -- carries this for longer than its own bounded retry window. Encrypted
  -- with CERTIFICATE_OUTBOX_ENCRYPTION_KEY, which lives only in process
  -- config, never in this database — see certificate-outbox-crypto.ts for
  -- the cipher and certificate-notification-dispatcher.ts for what happens
  -- if that key is ever rotated while a payload is pending.
  encrypted_payload TEXT,

  last_error    TEXT,
  created_at    BIGINT  NOT NULL,
  next_attempt_at BIGINT NOT NULL,  -- when a 'pending'/re-queued row becomes eligible for another attempt
  sent_at       BIGINT,
  PRIMARY KEY (kind, reference_id)
);

-- The dispatcher's own poll query: "pending rows whose backoff has
-- elapsed", claimed via FOR UPDATE SKIP LOCKED so concurrent workers never
-- both pick up the same row.
CREATE INDEX IF NOT EXISTS idx_certificate_notification_outbox_pending
  ON certificate_notification_outbox (next_attempt_at) WHERE status = 'pending';
