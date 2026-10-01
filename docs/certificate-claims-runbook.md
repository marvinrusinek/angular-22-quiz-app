# Certificate Claims Runbook

Operational reference for the **email-verified certificate claim feature** —
the backend-issued replacement for the old, purely local "unlock a
certificate on page load" behavior. Covers current status, how to run the
real-browser regression suite, and what remains before this can be enabled
in production.

**Status: code-complete, disabled by default, not yet production-ready.**
`CERTIFICATE_CLAIMS_ENABLED` defaults to `false`; enabling it in production
is unconditionally refused today (see §3) because no real email provider
adapter exists yet — only an in-memory fake used for local development and
tests.

---

## 1. Architecture summary

- **Node-owned**, not Spring. Node already owns every Postgres migration and
  the config/CORS/rate-limiting conventions this feature reuses; the feature
  has nothing to do with Spring's Interview session lifecycle.
- Six new tables (migration `009_certificate_claims.sql`):
  `certificate_claims`, `certificate_verification_tokens`,
  `issued_certificates`, `certificate_retrieval_tokens`,
  `certificate_notification_outbox`, plus `certificate_notification_outbox
  .encrypted_payload` for retry-safe email payloads.
- **Legacy preservation**: the old local-only certificate
  (`InterviewCertificateService` / `SK_INTERVIEW_CERTIFICATE`) is untouched
  and still displayed, clearly labelled "Legacy certificate — issued
  locally, not email-verified." Nothing auto-migrates a legacy record into a
  verified one; a user must separately claim (or recover) a verified
  certificate.
- **Eligibility stays browser-reported** — unchanged. This feature only
  changes what happens once eligible: instead of a silent local unlock, the
  UI offers an explicit claim form.
- Intended email provider: **Resend**. Its idempotency-key contract
  (checked directly against its docs, not assumed) requires a byte-identical
  payload on any retried key — same key + different payload is a `409`
  error, not a silent dedup. `certificate-notification-dispatcher.ts`'s own
  doc comment has the full design this drives (encrypted, short-lived
  outbox payload for `claimant_verify` retries; `owner_claim_notice` never
  needs one because its payload is already reconstructible).

---

## 2. Running the real-browser regression suite

```
npm run e2e:certificate
```

One command, nothing else needed beyond a running Docker daemon (Docker
Desktop or equivalent). It:

1. Provisions an **isolated, disposable Postgres container**
   (`cert-e2e-postgres`, fixed port `55434`) — never the developer's own
   database, local or Neon. TLS is enabled with a self-signed certificate
   generated *inside* the container (`openDatabase()` hard-codes
   `ssl: { rejectUnauthorized: false }` for Neon compatibility, so even a
   throwaway local Postgres needs TLS to satisfy it).
2. Migrates and seeds it with this repo's own **synthetic quiz bank**
   (`backend/test/helpers/synthetic-quiz-bank.json`) — fixture data, never
   the real private bank.
3. Starts a **test-only backend launcher**
   (`e2e-cert-claim/support/launch-cert-e2e-backend.js`) on `:3000` — the
   real `createApp()`/`CertificateClaimService` wiring, but with
   `InMemoryEmailSender` (see §2.1) instead of a real provider. Aborts if
   `:3000` is already occupied (could be a developer's own `npm run dev`
   backend — this suite must never send claim-form traffic to a real
   database).
4. Reuses an already-running `ng serve` on `:4200` if you have one, or
   starts its own.
5. Runs `e2e-cert-claim/certificate-claim.spec.ts` against both, then tears
   down the Postgres container (Angular/Node are left exactly as Playwright
   found or started them).

What it proves, in a real browser: claim form → submit → open the captured
link → **confirmed not to auto-issue on page load or reload** → explicit
confirm click → certificate display → refresh (re-fetched via retrieval
token) → reused-link rejection → expired-link rejection → recovery in a
genuinely fresh browser context (same certificate id/date preserved, no
second owner notification) → a legacy local certificate stays labelled as
such → Quiz Selection loads with no registration gate.

### 2.1 Why the fake sender is safe to use here, and why its debug channel can never reach production

`InMemoryEmailSender` sends nothing anywhere — it only records what it would
have sent. The suite needs a way to read that recording (to extract the raw
verification link a real inbox would show), so
`launch-cert-e2e-backend.js` runs a **second, separate HTTP server** on its
own port (`:3098`) exposing that recording under `/__test_debug__/*`,
including an endpoint that mints an already-expired token for testing that
path without waiting 24 hours.

This channel cannot exist in a production process:

- it is not part of `server.ts`, `createApp()`, or any file under
  `backend/src/` — it lives entirely under `e2e-cert-claim/support/`, which
  nothing in `backend/` imports;
- it is not referenced by `backend/Dockerfile`, `render.yaml`, or either
  GitHub Actions workflow;
- the launcher refuses to start at all if `NODE_ENV=production`;
- the debug server binds to `127.0.0.1` only, never `0.0.0.0`, on a port the
  main app never uses.

### 2.2 Isolation guarantees

- Fixed container name (`cert-e2e-postgres`) and fixed, documented ports —
  never the main e2e harness's ports (`:3000`/`:8080` for Node/Spring,
  shared only for the Angular dev server, which both harnesses legitimately
  reuse the same way).
- `ensure-cert-e2e-database.js` never touches any database except its own
  named container.
- Torn down automatically after every run (`global-teardown.js`); re-run
  the command and it re-provisions from scratch.

---

## 3. Remaining production setup

**Required before `CERTIFICATE_CLAIMS_ENABLED=true` can be set anywhere
real:**

1. **A real `EmailSender` adapter.** `backend/src/certificate/email-sender.ts`
   defines the one interface a provider must implement
   (`send(message: OutboundEmail): Promise<EmailSendResult>`); only
   `InMemoryEmailSender` exists today. Building the Resend adapter is the
   next piece of work (tracked in the main README's Roadmap).
2. **Remove or replace the unconditional production guard.**
   `backend/src/config.ts#parseCertificateClaims` currently throws
   `ConfigError` whenever `CERTIFICATE_CLAIMS_ENABLED=true` AND
   `NODE_ENV=production`, specifically because no real adapter exists yet
   and `server.ts` would otherwise silently wire the in-memory one. Once a
   real adapter is built and `server.ts` is updated to select it (e.g. via
   a new `EMAIL_SENDER_IMPL` variable), update this guard to require that
   explicit selection instead of refusing outright — never remove it
   without replacing it with an equivalent fail-closed check.
3. **Five required environment variables**, validated fail-closed the
   moment the feature is enabled (`backend/src/config.ts`):
   - `EMAIL_PROVIDER_API_KEY`
   - `EMAIL_FROM_ADDRESS`
   - `OWNER_NOTIFICATION_EMAIL` — Marvin's own inbox; the only recipient of
     `owner_claim_notice`, never claimant-supplied.
   - `CERTIFICATE_CLAIM_BASE_URL` — the public Angular origin the emailed
     verification link points at.
   - `CERTIFICATE_OUTBOX_ENCRYPTION_KEY` — exactly 64 hex characters (32
     bytes). Generate with:
     ```
     openssl rand -hex 32
     ```
     Never log this value or commit it. Rotating it invalidates any
     currently-pending `claimant_verify` row's stored retry payload — the
     dispatcher detects that (decryption fails closed) and falls back to a
     fresh payload under a distinct key rather than crashing or silently
     reusing a changed payload under the old key, but rotating during a
     real outage is still best avoided if possible.
4. **Frontend**: nothing further required — the claim form, confirmation
   page, certificate display, and recovery flow are already built and
   covered by this runbook's own suite plus the Jest unit/component tests.
   `CertificateClaimApiService#configured` already hides the claim UI
   gracefully when `API_BASE_URL` isn't set for a build.
5. **render.yaml**: add the five variables above with `sync: false` (never
   committed values), matching this file's existing convention for secrets.

**Already true, verified, and must stay true:**
- Disabled by default; missing email configuration never breaks Topic Quiz
  or Interview Mode when the feature is off (`loadConfig({})` tests this
  directly).
- An unrelated route still 404s normally when the feature is disabled — the
  disabled-feature 503 handler is scoped to the five certificate-claim
  paths only, not a blanket `/api/*` catch-all.
