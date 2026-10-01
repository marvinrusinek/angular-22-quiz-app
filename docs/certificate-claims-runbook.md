# Certificate Claims Runbook

Operational reference for the **email-verified certificate claim feature** —
the backend-issued replacement for the old, purely local "unlock a
certificate on page load" behavior. Covers current status, both real email
senders, how to run the real-browser regression suite, and the Postmark
setup checklist needed before production enablement.

**Status: code-complete, with two real senders (SMTP and Postmark),
disabled by default.** `CERTIFICATE_CLAIMS_ENABLED` defaults to `false`.
Enabling it in production now *requires* an explicit, real, valid provider
configuration (§3) rather than being unconditionally refused. **Postmark is
the provider that can actually work on the current Render free plan** — see
§4; SMTP is kept available for optional/local use or a future paid plan.

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
- **Two real email senders, selected by `CERTIFICATE_EMAIL_PROVIDER`**:
  `backend/src/certificate/smtp-email-sender.ts` (Nodemailer, authenticated
  SMTP) and `backend/src/certificate/postmark-email-sender.ts` (Postmark's
  HTTP Email API). Both exist side by side deliberately — see §4 for why
  one hosting fact makes that necessary rather than redundant. Both share
  one rendering implementation (`email-render.ts`), so the two providers
  can never silently drift into different wording.

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

This suite always uses `InMemoryEmailSender`, never a real provider — it
proves the claim/confirm/recovery FLOW, not delivery through either
provider. See §4.2 for how Winhost SMTP itself was verified separately, and
§5 for the Postmark controlled-send test still to come.

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

## 3. Configuring a real sender

`CERTIFICATE_EMAIL_PROVIDER` picks exactly one of `smtp` or `postmark` and
gates which OTHER variables are even read — selecting `postmark` never
requires any `CERTIFICATE_SMTP_*` variable, and selecting `smtp` never
requires `CERTIFICATE_POSTMARK_*`. **Required in production** (the server
refuses to start without it there, rather than silently falling back to the
in-memory sender); outside production, leaving it unset is the supported
local-dev path (fake sender, loud warning).

Four variables are shared by both providers:

| Variable | Notes |
|---|---|
| `EMAIL_FROM_ADDRESS` | The `From:` header on every sent email — `marvin@marvinrusinek.com`. |
| `OWNER_NOTIFICATION_EMAIL` | Marvin's own inbox — the only recipient of `owner_claim_notice`, never claimant-supplied. |
| `CERTIFICATE_CLAIM_BASE_URL` | The public Angular origin the emailed verification link points at. |
| `CERTIFICATE_OUTBOX_ENCRYPTION_KEY` | 64 hex chars (32 bytes). `openssl rand -hex 32`. Never logged or committed. Rotating it invalidates any currently-pending retry payload (handled gracefully — see each sender's own doc comment and the dispatcher's — but best avoided mid-outage). |

### 3.1 Postmark (recommended on the current Render plan — see §4)

| Variable | Notes |
|---|---|
| `CERTIFICATE_EMAIL_PROVIDER` | `postmark` |
| `CERTIFICATE_POSTMARK_SERVER_TOKEN` | A **SERVER token** from the Postmark dashboard — never an account token (Postmark's own docs distinguish the two; an account token has broader privileges than sending mail needs). **Enter this ONLY in your own local `backend/.env`** (already gitignored) or the Render dashboard's `sync: false` prompt. Never in chat, a commit, a log, or `.env.example`. |
| `CERTIFICATE_POSTMARK_MESSAGE_STREAM` | Defaults to `outbound` (Postmark's own default transactional stream) if left blank. |

Open/click tracking is **explicitly disabled** in every request
(`TrackOpens: false`, `TrackLinks: 'None'`) — hard-coded in
`postmark-email-sender.ts`, not a configurable flag.

### 3.2 SMTP

| Variable | Notes |
|---|---|
| `CERTIFICATE_EMAIL_PROVIDER` | `smtp` |
| `CERTIFICATE_SMTP_HOST` | e.g. `m07.internetmailserver.net` — **confirm this via your own Winhost control panel's Site Info page**, not just this document. Independently corroborated here via `marvinrusinek.com`'s own DNS MX record, which points directly at this host (§4.2) — strong evidence, not a substitute for checking Site Info yourself. |
| `CERTIFICATE_SMTP_PORT` | Preferred: `587`. |
| `CERTIFICATE_SMTP_TLS_MODE` | `starttls` (preferred — mandatory STARTTLS upgrade, port 587) or `tls` (implicit TLS, typically port 465). No insecure option exists in this field's type. |
| `CERTIFICATE_SMTP_USERNAME` | e.g. `marvin@marvinrusinek.com`. |
| `CERTIFICATE_SMTP_PASSWORD` | **Enter this ONLY in your own local `backend/.env`**. Never in chat, a commit, a log, or `.env.example`. |

All five are required together once `CERTIFICATE_EMAIL_PROVIDER=smtp` — a
partial set is always treated as a mistake, in dev or production.
Certificate validation (`rejectUnauthorized: true`, TLS 1.2 floor) is
hard-coded in `buildSmtpTransportOptions` — not a configurable flag.

### 3.3 Neither provider offers an idempotency guarantee

The original design (built around Resend's HTTP API) relied on a
provider-side idempotency-key contract: a retried key with the same payload
would return the original result instead of sending again. **Checked
directly against each actually-implemented provider's own docs, not
assumed — neither shares that guarantee:**

- **SMTP**: no idempotency concept at all. Once a message is accepted
  (`250 OK`), there is no way to later ask the server "did you already get
  this."
- **Postmark**: its API overview documents authentication, rate limits
  (`429`), and numbered `ErrorCode`s — and says nothing about idempotency
  keys, deduplication, or safe request replay for its `/email` endpoint.

What this means concretely, for both:

- The byte-identical retry payload mechanism (`certificate-outbox-
  crypto.ts`) is **preserved**, but for a narrower reason than originally
  designed: it keeps the verification link **stable** across retries (a
  claimant sees the same link, not several different ones) and avoids
  needlessly consuming `MAX_OUTSTANDING_TOKENS_PER_CLAIM`. It no longer
  prevents a duplicate *send*.
- **If this process crashes after the provider accepts a message but
  before `markNotificationSent` persists that fact, the next retry WILL
  send a second, genuinely duplicate physical email.** There is no
  provider-side mechanism left to prevent it, with either provider, and
  this document does not claim otherwise.
- What is still guaranteed, unconditionally, regardless of provider: exactly
  one outbox row, exactly one certificate ever issued per email, and
  exactly one owner-notification row (a recovery never generates a second
  one). Only "the recipient's inbox has exactly one copy" is the claim that
  changed.
- The crash window is kept as small as practically possible
  (`markNotificationSent` is called immediately after `send()` resolves,
  with no intervening `await`), but it cannot be closed to zero.
- `idempotencyKey` is still passed to both senders — as a custom
  `X-Certificate-Idempotency-Key` header — for forensic/debugging
  traceability only, never functional deduplication.
- **Provider acceptance is never proof of inbox delivery.** A `2xx`/
  `ErrorCode: 0` result means the provider took responsibility for the
  message, not that it reached the recipient.

Full detail: `email-sender.ts`'s shared top doc comment, plus each
provider's own.

### 3.4 Error classification

Both senders classify every send failure into the same shared vocabulary
(`EmailSendErrorKind`, `email-sender.ts`): `auth`, `timeout`, `transient`,
`permanent`, or `unknown`.

- **SMTP**: derived from Nodemailer's own error `code` and, where present,
  the raw SMTP response code (4xx transient, 5xx permanent).
- **Postmark**: derived from the HTTP status and, where present, Postmark's
  own numeric `ErrorCode` — e.g. `10` (bad/missing token) → `auth`; `429` →
  `transient`; `406` (inactive/suppressed recipient), `412` (account
  pending), `413` (account may not send) → `permanent`, since retrying the
  identical payload will not fix an account-level restriction.

The dispatcher does not currently branch on `kind` — every failure still
follows the same bounded retry schedule — but the classification is visible
in logs and covered by tests: `backend/test/smtp-email-sender.test.ts` (22
tests) and `backend/test/postmark-email-sender.test.ts` (19 tests) — TLS/
request-shape requirements, successful delivery, every error kind,
header/HTML injection stripping, and secret redaction (no thrown error or
logged value ever contains the configured password or server token).

---

## 4. Production hosting

### 4.1 Where the production Node API actually runs

Confirmed directly from `render.yaml`, not assumed: the Node service
(`interview-api`) runs on **Render**, `runtime: docker`, **`plan: free`**,
region `oregon`. This is the service `CERTIFICATE_CLAIMS_ENABLED` would be
set on.

### 4.2 Winhost SMTP itself: verified working (the server is fine; the plan isn't)

Checked directly, without sending any email or touching production:

- **Hostname**: `m07.internetmailserver.net` is independently confirmed as
  `marvinrusinek.com`'s real mail server via a live DNS MX lookup —
  `marvinrusinek.com MX preference = 10, mail exchanger =
  m07.internetmailserver.net`. (Still confirm it against Winhost's own Site
  Info page before relying on it exclusively — Winhost's KB page itself
  returned 403 to an automated fetch, so this could not be cross-checked
  against their documentation directly.)
- **TCP connect to port 587**: succeeds.
- **STARTTLS handshake**: succeeds. Server certificate
  (`CN=*.internetmailserver.net`, DigiCert/RapidSSL, valid to 2026-10-19)
  verifies cleanly through its full chain — `rejectUnauthorized: true` will
  work correctly against this exact host.
- **Post-STARTTLS `EHLO`**: server advertises `AUTH PLAIN LOGIN CRAM-MD5` —
  compatible with Nodemailer's default authentication.

All of this was run from a local machine, not from Render — see §4.3 for
why.

### 4.3 Render's free tier blocks outbound SMTP — this is why Postmark exists

**Confirmed directly from Render's own official changelog** (not a forum
post or assumption):
[render.com/changelog/free-web-services-will-no-longer-allow-outbound-traffic-to-smtp-ports](https://render.com/changelog/free-web-services-will-no-longer-allow-outbound-traffic-to-smtp-ports)

> Free web services will block outbound network traffic to SMTP ports 25,
> 465, and 587 — effective across all regions by Friday, September 26th
> \[2025\]. To continue sending traffic to an SMTP port, upgrade your free
> web service to any paid instance type.

This is a **platform-level network policy**, not a code, credentials, or
TLS-configuration problem — it applies regardless of how correctly
`CERTIFICATE_SMTP_*` is set, and it does NOT apply to ordinary outbound
HTTPS (which is all Postmark's adapter uses). This is why §4.4's
connectivity check was run locally rather than attempted from Render —
doing so would only reproduce this documented block, and attempting it
from inside a running production service would itself be a change this
task was explicitly asked not to make.

**This is why both senders exist, not just one**: Postmark is the one that
can actually work on the CURRENT free plan without any hosting change at
all. SMTP remains available for local use, or for if the plan is ever
upgraded.

### 4.4 Postmark setup checklist (before this can go live)

A verified DKIM/Return-Path domain is necessary but not sufficient — three
more Postmark-specific gates apply to a transactional sending account:

1. **Account approval.** A new Postmark account's ability to send can be
   gated on manual approval (`ErrorCode 412`, "Account is Pending") —
   confirm your account shows as approved for sending in the Postmark
   dashboard before expecting real sends to succeed.
2. **Sending limits.** New/unapproved accounts are typically capped on
   volume; this feature's own traffic (one verification email per claim or
   resend, one owner notice per new issuance) is low-volume by nature, but
   confirm your account's current limit in the dashboard regardless.
3. **Suppression list.** Postmark automatically suppresses a recipient
   address after a hard bounce or spam complaint (`ErrorCode 406`,
   "Inactive recipient") — a send to a suppressed address fails
   permanently (classified `permanent` here, correctly, since retrying the
   identical payload will not un-suppress it) until manually reactivated in
   the dashboard. Worth knowing before a controlled test send to an address
   that has ever bounced.
4. **`MessageStream` must exist on the server.** The default `outbound`
   stream always exists; a custom stream name must be created in the
   Postmark dashboard first, or every send fails with `ErrorCode 1235`
   ("MessageStream... does not exist").

### 4.5 The controlled inbox test needed next

Explicitly NOT done yet, since real emails were not to be sent this round:

1. Set `CERTIFICATE_EMAIL_PROVIDER=postmark`,
   `CERTIFICATE_POSTMARK_SERVER_TOKEN`, and the shared variables (§3) in a
   non-production environment — e.g. your own local `backend/.env`, with
   `NODE_ENV=development` so the production guard doesn't apply.
2. Run the real server (`npm run dev` in `backend/`) and submit one claim
   form with an email address you personally control.
3. Confirm the email actually arrives (not just that `send()` resolved
   without throwing), check it renders correctly (text and HTML), and click
   through to confirm the certificate.
4. Check the Postmark dashboard's own activity log for that message —
   confirms provider-side delivery status beyond what this system's own
   `delivered: true` can tell you.
5. Only after that succeeds, repeat against the production Render
   environment, still with an email address you control, before any real
   claimant traffic is allowed.
