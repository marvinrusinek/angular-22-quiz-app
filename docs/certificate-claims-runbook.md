# Certificate Claims Runbook

Operational reference for the **email-verified certificate claim feature** —
the backend-issued replacement for the old, purely local "unlock a
certificate on page load" behavior. Covers current status, both real email
senders, how to run the real-browser regression suite, and the Postmark
setup checklist needed before production enablement.

**Status: code-complete, with two real senders (SMTP and Postmark),
disabled by default, and a successful CONTROLLED LOCAL test with real
Postmark delivery.** `CERTIFICATE_CLAIMS_ENABLED` defaults to `false`.
Enabling it in production now *requires* an explicit, real, valid provider
configuration (§3) rather than being unconditionally refused. **Postmark is
the provider that can actually work on the current Render free plan** — see
§4; SMTP is kept available for optional/local use or a future paid plan.
**Production claims remain disabled** — the local test (§4.5) proves the
flow end to end against real Postmark delivery, not that production is
live. See §6 for the exact rollout order and §7 for rollback.

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

### 4.5 The controlled local inbox test — CONFIRMED SUCCESSFUL

Run against an isolated local Postgres container (`cert-manual-test-
postgres`), `NODE_ENV=development`, real Postmark delivery, an email
address the operator controls. Result: **verification email received,
explicit confirmation completed, certificate displayed, owner notification
received.**

**One real-world delivery detail observed, worth documenting rather than
treating as a failure**: Winhost (the recipient mail server) initially
**greylisted** the delivery attempt — a common anti-spam technique where an
unfamiliar sender is temporarily rejected (a `4xx`-class soft bounce) on
the first attempt, on the assumption that a legitimate mail transfer agent
will retry after a delay, while most spam senders will not. Postmark's own
outbound retry logic retried automatically and the message was
subsequently accepted and delivered. This is normal, expected behavior for
a new sender/domain pair and typically resolves itself (or improves)
automatically over the first several sends. It also means: **a real
end-recipient may see their first verification email arrive with a delay
of up to several minutes, or (rarely) not at all on the first attempt** —
the "resend" feature in the claim form exists precisely for this case, and
the disclosure copy and recovery path already account for it.

This confirms the local flow against REAL Postmark delivery end to end. It
does not confirm production, which is a separate environment (Render) with
its own outbound network path — see §6 for why that still needs its own
verification before real claimant traffic, and §8 for the exact production
smoke-test plan.

---

## 5. Production routing and URL verification

Checked directly against the actual repository configuration, not assumed.

### 5.1 Node vs. Spring — certificate traffic never touches Spring

`CertificateClaimApiService` injects `API_BASE_URL` (Node's token) exclusively
— the same token every other Topic-Quiz-adjacent service already uses. It
never injects `INTERVIEW_API_BASE_URL` (Spring's token). Certificate-claim
requests reach Node by construction, with zero change to how Interview Mode
routes to Spring.

### 5.2 GitHub Pages base path — a real bug found and fixed

`angular.json` sets `"baseHref": "/angular-22-quiz-app/"` — the production
app is served at `https://marvinrusinek.github.io/angular-22-quiz-app/`, NOT
at the bare domain root (confirmed against README.md's own live-demo link
and `spring-production-runbook.md`, which explains the SEPARATE, correctly
bare-origin case: an HTTP `Origin` header never carries a path, so
`ALLOWED_ORIGINS` is correctly `https://marvinrusinek.github.io` with no
path — that is a different value for a different purpose than the emailed
link).

`render.yaml`'s own commented-out `CERTIFICATE_CLAIM_BASE_URL` placeholder
was wrong — it used the bare origin, which would have produced a broken
emailed link (`https://marvinrusinek.github.io/interview/certificate/
verify#token=...`, missing the app's own subpath entirely). **Fixed**: now
`https://marvinrusinek.github.io/angular-22-quiz-app` (no trailing slash —
the code strips one before appending its own route).

### 5.3 Deep-link fallback — confirmed already correct

GitHub Pages is a static host with no server-side rewrite, and this app
uses Angular's default path-based routing (no `HashLocationStrategy`
anywhere in the codebase — confirmed by direct search). A cold open of a
deep link like `.../interview/certificate/verify#token=...` would normally
404 on a static host. `scripts/stage-ghpages.js` already handles this: it
stages `404.html` as a **byte-identical copy of `index.html`** (confirmed
directly in the script), which is the standard GitHub Pages SPA fallback —
the server returns `404.html`, which boots the Angular app, whose Router
then reads the browser's actual current URL and routes internally. No
redirect occurs, so this was already correct before this feature existed;
nothing needed changing.

### 5.4 Fragment handling — confirmed correct

The verification token travels only in the URL **fragment**
(`#token=...`), never a query string. A fragment is never sent to the
server in an HTTP request (per the URL spec) — GitHub's server only ever
sees the path, returns `404.html`, and because this is same-URL content
substitution rather than a redirect, the browser's `window.location.hash`
is untouched throughout. The confirmation page's own `ngOnInit` reads it
directly from `location.hash`.

### 5.5 CORS and CSP — confirmed no change needed

- **CORS**: `ALLOWED_ORIGINS` already lists the correct bare GitHub Pages
  origin (§5.2); certificate-claim requests go through the same Node
  origin as every other Topic-Quiz request, so no new entry is needed.
- **CSP**: `index.html`'s `connect-src` already lists
  `https://interview-api-c842.onrender.com` (Node's production origin) —
  the same one `API_BASE_URL` resolves to in production. Certificate-claim
  calls use that exact token, so no CSP change is needed.

### 5.6 Service worker — confirmed no interference

`ngsw-config.json` defines only `assetGroups` (static files: app shell,
fonts, images) — there are no `dataGroups` at all, so the service worker
never intercepts or caches any `/api/*` request. Every certificate-claim
API call (submit, preview, confirm, retrieve) reaches the network directly;
there is no risk of a stale cached response ever being replayed for a
`previewToken` or `confirmToken` call.

### 5.7 No localhost URLs or secrets reach production artifacts

- **Backend Docker image**: `backend/Dockerfile` copies explicit paths only
  (`package.json`, `tsconfig.json`, `scripts`, `src`, then compiled `dist`
  and `node_modules` into the runtime stage) — never `test/`, never any
  `.env*` file. `backend/.dockerignore` independently excludes `test`,
  `jest.config.*`, and `.env*` too (defense in depth). `render.yaml` scopes
  the build context to `dockerContext: ./backend`, so anything outside
  `backend/` — including all of `e2e-cert-claim/` (the Playwright suite's
  test-only debug channel, §2.1) — is **structurally invisible** to this
  Docker build, not merely excluded by convention.
- **Frontend bundle**: a full `ng build --configuration=production` was run
  and the output grepped directly for `postmark`, `smtp`, the local test
  database password, and both Postmark/SMTP env var names — none found. The
  only `localhost:*` string present (`localhost:3000`) is the pre-existing,
  intentionally-public `DEV_API_BASE_URL` dev-mode fallback constant (see
  `api-base-url.token.ts`'s own doc comment: "Both URLs are PUBLIC
  configuration, not secrets") — unrelated to certificates, present before
  this feature existed, and never used at runtime unless the page is
  actually loaded from `localhost`.

---

## 6. Database migration and rollout order

### 6.1 Migration 009 is additive and low-risk

Reviewed directly: six brand-new tables (`certificate_claims`,
`certificate_verification_tokens`, `issued_certificates`,
`certificate_retrieval_tokens`, `certificate_notification_outbox`), with
foreign keys only among themselves — **no `ALTER TABLE` on any existing
table, no backfill, no data migration of any kind.** `CREATE TABLE` only
locks the new table being created; `CREATE INDEX IF NOT EXISTS` (no
`CONCURRENTLY` needed) on a brand-new, empty table is effectively instant.
This migration cannot lock or block access to `quizzes`, `questions`,
`interview_sessions`, or any other existing production table.

### 6.2 Compatibility with the currently-deployed Node and Spring versions

- **Node**: `migrate()` (`backend/src/db/migrate.ts`) runs automatically on
  every boot, applying any migration not yet recorded in
  `schema_migrations` — unconditionally, regardless of
  `CERTIFICATE_CLAIMS_ENABLED`. This means migration 009 will apply the
  NEXT time `interview-api` is deployed for ANY reason, whether or not the
  feature is ever turned on — a deliberate, safe property: the schema
  appearing and the feature activating are two independently-controllable
  moments, not one.
- **Spring**: `ddl-auto=validate` only validates entities Spring explicitly
  maps. None of the six new tables are Spring entities — they are
  completely invisible to it. Spring is unaffected by this migration in
  every respect, confirmed by the same reasoning already established for
  every other Node-only migration in this codebase.

### 6.3 Exact deployment order

Five phases: publish the reviewed source, deploy the backend with claims
OFF, deploy the frontend through the documented procedure, configure and
activate, then smoke-test before real traffic. Each phase is independently
reversible — see §7 for exactly what each rollback step does and does not
undo.

**Phase 0 — publish and merge the reviewed source:**
1. Push `feature/certificate-claims` to the remote (`git push`), confirming
   the exact commit SHA being promoted matches what was reviewed and tested
   in this runbook's validation record.
2. Open and merge the pull request into `main`. Nothing deploys itself on
   merge — Render's `interview-api` is deployed from `main` on a push, but
   GitHub Pages is a **separate, manual** step (6.3 Phase 2 below), not
   triggered by this merge at all.

**Phase 1 — Render backend deploy + migration, feature still OFF
(low-risk, reversible):**
3. Deploy `main` to `interview-api` on Render (a push to `main` auto-deploys
   it per `render.yaml`; `interview-api-spring`'s `autoDeploy: false` is
   unaffected and untouched by this feature either way).
   `CERTIFICATE_CLAIMS_ENABLED` is NOT set. Migration 009 applies
   automatically on boot — see 6.1/6.2. **No certificate-claim route
   changes behavior yet**: every one of the five paths still 503s exactly
   as before this deploy, and every existing Topic Quiz / Interview Mode
   route is untouched.
4. Confirm the health check passes and `GET /api/quizzes` (or any existing
   route) still works normally — proves the deploy succeeded and the new,
   unused tables didn't disturb anything.

**Phase 2 — GitHub Pages frontend deploy, via the documented procedure
(see §6.4 for what this step alone makes visible):**
5. Follow `docs/github-pages-deploy.md`'s procedure exactly — build from
   the exact `main` commit (`ng build --configuration=production` +
   `npm run verify:artifact`, requiring exit code 0), stage with
   `npm run stage:ghpages -- --clone <short-path-clone>` (never `npm run
   deploy`/`ngh` on Windows — see that doc's own note on why), commit and
   fast-forward push to `gh-pages`, then confirm `<site>/ngsw/state` shows
   `Driver state: NORMAL`.
6. This step alone — independent of the backend flag — changes what a
   newly-eligible user sees on the certificate surfaces (callout, badge,
   status card, and the certificate page itself): no more automatic local
   unlock, only an explicit "claim your certificate" prompt. **Read §6.4
   before treating this as a no-op step.**

**Phase 3 — final configuration and activation, still no real claimant
traffic:**
7. In the Render dashboard (never in `render.yaml`), set the five
   non-secret-shaped values from §3/render.yaml's commented block
   (`EMAIL_FROM_ADDRESS`, `OWNER_NOTIFICATION_EMAIL`,
   `CERTIFICATE_CLAIM_BASE_URL` — **with the `/angular-22-quiz-app` path,
   §5.2** — `CERTIFICATE_EMAIL_PROVIDER=postmark`,
   `CERTIFICATE_POSTMARK_MESSAGE_STREAM=outbound`) plus the two secrets
   (`CERTIFICATE_OUTBOX_ENCRYPTION_KEY`, freshly generated;
   `CERTIFICATE_POSTMARK_SERVER_TOKEN`, from Postmark's dashboard) as
   `sync: false` values, entered directly in the dashboard.
   `CERTIFICATE_RETRIEVAL_ENABLED` can be left unset here — it follows
   `CERTIFICATE_CLAIMS_ENABLED` by default (see §7.3); set it explicitly
   only when using the rollback lever later.
8. Set `CERTIFICATE_CLAIMS_ENABLED=true` last, after every other variable
   above is already in place — restart/redeploy to pick them up.
9. Confirm the startup log shows `[certificate-claims] sending via
   Postmark: message stream "outbound"` — NOT the in-memory-sender warning.
   **From this moment, the claim form is reachable by any visitor to the
   public site, not only the operator — see §6.5 and §8 before assuming
   otherwise.**

**Phase 4 — controlled smoke test, then real traffic:**
10. Run the exact smoke test in §8. Read §6.5 first: the form is public the
    instant step 9 completes, the smoke test does not make it private.
11. Only after §8 succeeds should the claim form be treated as ready for
    real users — "ready" here means verified working, not "newly
    restricted"; it was already open to everyone since step 9.

### 6.4 What becomes visible the moment the new frontend is deployed —
independent of the backend flag

This is a real, user-visible behavior change that Phase 2 alone causes,
whether or not `CERTIFICATE_CLAIMS_ENABLED` is ever set. It must not be
read as "zero user-visible change" the way Phase 1 (backend-only) is.

**Before this feature**: `InterviewCertificateComponent` and the compact
certificate surfaces (`CertificateEarnedBadgeComponent`,
`InterviewCertificateCalloutComponent`, `InterviewCertificateStatusComponent`,
and the certificate callout inside `DifficultyRecommendationComponent`) were
driven by `InterviewCertificateService.unlock()`, called automatically once
a user became eligible — a locally-generated certificate record appeared
the moment the page was next viewed, with no explicit action.

**After this feature**: `unlock()` still exists (so an existing legacy
record stays readable — see §1 "Legacy preservation"), but **nothing in
the codebase calls it anymore** (confirmed directly — zero call sites).
`InterviewCertificateComponent`'s own doc comment states this explicitly:
eligibility now shows an explicit "Claim your certificate" CTA
(`/interview/certificate/claim`) instead of an automatic unlock.

**The consequence for the rollout window specifically**: between Phase 2
(frontend live) and Phase 3 completing (claims enabled), a user who becomes
newly eligible during that window gets **no certificate at all — not even
a legacy-style local one** — only a CTA that, if clicked and submitted,
receives `FEATURE_DISABLED` ("Certificate claiming is not available right
now.", mapped cleanly in `certificate-claim-api.errors.ts` from the
backend's 503 — not a crash, but not a certificate either). This is a real,
if narrow, gap for anyone who crosses the eligibility threshold in exactly
that window; it resolves itself once Phase 3 completes, and nothing about
it is destructive (the user becomes eligible to claim again the moment
claims are enabled — eligibility itself is recomputed live, never
consumed).

**Fix applied in this review** (not previously present): three components
call the shared pure helper `certificateNextAction()`
(`src/app/shared/utils/interview-certificate-progress.ts`) —
`InterviewCertificateCalloutComponent` (Interview Builder),
`DifficultyRecommendationComponent` (Quiz Selection), and
`InterviewCertificateStatusComponent` (Interview Results). The helper
previously returned an **empty string** for an eligible-but-unclaimed user.
The first two surfaces went silently blank where a prompt should be;
`InterviewCertificateStatusComponent` was unaffected because it already had
its own dedicated `awaitingClaim` branch with a real CTA link that bypasses
this helper entirely for that case. `certificateNextAction()` now returns
"Claim your certificate now." for the eligible-but-unclaimed case, closing
the blank-text gap in the two affected surfaces. This does not add a
clickable link to those compact surfaces (they are motivational widgets;
the actual claim link lives on the pages that already had one, and on
`InterviewCertificateStatusComponent`'s own unaffected CTA), and it does
not shorten or remove the Phase-2/Phase-3 gap described above — it only
stops the two affected surfaces from going silent during it.

**Recommendation**: keep Phase 2 and Phase 3 close together in practice —
nothing technically requires it, but the longer the gap, the more newly-
eligible users land in the no-certificate window above. `CERTIFICATE_
RETRIEVAL_ENABLED` (§7.3) is NOT a mitigation for this specific window — it
only helps someone who already HOLDS a certificate, not a user who becomes
newly eligible during the gap. There is no existing lever that shortens
this window; closing it fully would mean reintroducing some form of
automatic local issuance, which is exactly what this feature was built to
replace, so this review did not do that.

### 6.5 Does enabling claims restrict the form to the operator?

**No.** `CERTIFICATE_CLAIMS_ENABLED=true` makes `POST /certificate-claims`
reachable to **any visitor to the public site** — there is no
authentication, no invite code, and no server-side eligibility check on
this path. Confirmed directly in both places that would enforce it:

- **Routing**: `interview/certificate/claim`
  (`src/app/router/quiz-routing.routes.ts`) has no route guard at all —
  unlike, for example, the guarded Weak Areas Practice route.
- **Backend**: `CertificateClaimService.submitClaim` validates only that
  `name` and `email` are well-formed strings; `eligibilitySnapshot` is
  stored strictly for **audit purposes** and is "never inspected,
  re-derived, or used to authorize anything" — the service module's own
  doc comment, and confirmed by reading `submitClaim`'s actual body (§6
  of the original review did not re-litigate this; it is unchanged from
  how this feature was designed from the start).

**This is not a new weakness introduced by this review or this feature —
it is a continuation of the pre-existing trust model.** Before this
feature, "eligibility" was always browser-reported and the resulting
certificate was always purely local (`InterviewCertificateService`'s own
doc comment: "NOT anti-tamper... the certificate is a personal portfolio
artifact, not a credential a third party can verify"). What genuinely
changes with this feature: a fabricated claim is no longer invisible to
only the person who faked it — it is now **backend-recorded**, triggers a
**real owner-notification email** (to `OWNER_NOTIFICATION_EMAIL`) claiming
someone completed the curriculum, and is retrievable by anyone holding its
retrieval token — all while still requiring no proof of actual
achievement, only control of an email inbox. Rate limiting (10 submissions
per IP per 30s burst, 5 per email per 60s — see
`certificate-claims.route.ts`) bounds **volume** abuse; it does not
prevent a single illegitimate claim.

**Practical implication for §8's smoke test**: it is accurate to say the
operator submits using an email address they control. It would NOT be
accurate to say the test is "restricted" to that email in the sense of
excluding other submitters — the form is open to the public for the same
entire window the operator is testing in, and that is correct, expected
behavior for a feature intended to go live to real users, not a leak to
fix before testing.

---

## 7. Rollback plan

### 7.1 Frontend

The claim form, confirmation page, and certificate display are already
live in the deployed Angular bundle regardless of the backend flag — they
simply call an API that may or may not be enabled.
`CertificateClaimApiService#configured` already hides/short-circuits
gracefully when `API_BASE_URL` isn't set for a build; rolling back the
FEATURE never requires a separate frontend deploy or revert. If a frontend
BUG specifically (not the backend flag) needs rolling back, that is an
ordinary GitHub Pages rollback: redeploy from the previous `gh-pages` head
per `docs/github-pages-deploy.md` (never force-push `gh-pages`; the
previous head is always the rollback point).

### 7.2 Node revision

Migration 009 is purely additive (§6.1) — rolling back to a Node revision
from BEFORE this feature existed is always safe and needs NO corresponding
schema rollback. The older code's `migrate()` call simply never attempts
migration 009 (its own `migrations/` directory doesn't contain that file),
and the six new tables are left in place, unreferenced and harmless. **Do
not drop these tables as part of a code rollback** — there is no reason to,
and doing so would destroy any already-issued certificates' data for no
benefit.

### 7.3 The feature flag — precise effect, and the SEPARATE retrieval lever

Setting `CERTIFICATE_CLAIMS_ENABLED=false` (or unsetting it) and
redeploying/restarting causes `wireCertificateClaims()`'s `actions` half to
be absent entirely — **verified directly in code, not assumed, exactly
because an earlier pass of this review found that it ALSO cut off
retrieval, and this pass fixed that**:

| Effect | Stopped by `CERTIFICATE_CLAIMS_ENABLED=false`? | Why |
|---|---|---|
| New claim submission (`POST /certificate-claims`) | **Yes** | The disabled-feature 503 handler covers this exact path. |
| Resend (`POST /certificate-claims/resend`) | **Yes** | Same mechanism. |
| Confirmation (`POST /certificate-claims/verify/confirm`) | **Yes** | Same mechanism — a claimant mid-flow with an unconfirmed link cannot complete it while disabled. |
| **Outbox dispatch/retry (the 30-second poller)** | **Yes** | The dispatcher is only constructed as part of `actions`, which requires `enabled`. **Any already-pending or retry-scheduled notification is frozen in place — not merely delayed — until `CERTIFICATE_CLAIMS_ENABLED` is set back to `true`.** It resumes exactly where it left off (the outbox row's own state is untouched by either flag). |
| **Retrieving an already-issued certificate (`GET /certificates/me`)** | **Depends on `CERTIFICATE_RETRIEVAL_ENABLED` — see below.** | `retrievalEnabled` in `config.ts` is `claimsEnabled \|\| CERTIFICATE_RETRIEVAL_ENABLED === 'true'`. Left unset, it silently follows `CERTIFICATE_CLAIMS_ENABLED`, so an operator who does nothing extra sees the OLD behavior (retrieval also stops). Setting `CERTIFICATE_RETRIEVAL_ENABLED=true` explicitly is what keeps it working — see the fix description below. |
| Already-issued certificate DATA in Postgres | **No — never** | Neither flag ever deletes or modifies an issued certificate, claim, or outbox row — they only gate HTTP reachability. |

**Fix applied in this review**: `CertificateRetrievalService`
(`backend/src/certificate/certificate-claim.service.ts`) is a new class
needing only the repository and a clock — no dispatcher, no email sender,
no provider configuration. `wireCertificateClaims` (`server.ts`) now
constructs it whenever `config.certificateClaims.retrievalEnabled` is true,
**independently** of whether `actions` (submission/dispatch) is built.
`certificate-claims.route.ts`'s router takes the two services as separate
parameters, so `GET /certificates/me` 503s or serves based on its own
service's presence, not the claims service's. Token validation for
retrieval is **unchanged** — the same `resolveRetrievalToken` call,
checking both expiry and `revoked_at`, runs whether reached through the
full service or the retrieval-only one (see
`backend/test/certificate-claim.test.ts`'s "certificate retrieval —
separable from new-claim submission/dispatch" suite, which proves an
expired, revoked, or unknown token is rejected identically either way).

**To use this as the actual rollback lever** during an email-provider
outage or an emergency disable of new issuance: set
`CERTIFICATE_CLAIMS_ENABLED=false` **and** `CERTIFICATE_RETRIEVAL_ENABLED=
true` together. This stops new submissions, resend, verification, and the
outbox dispatcher, while `GET /certificates/me` keeps serving anyone who
already holds a retrieval token (a new device, a cleared browser, a
different claimant) with the exact same validation as before. Leaving
`CERTIFICATE_RETRIEVAL_ENABLED` unset during a rollback reproduces the OLD,
coupled behavior (retrieval also stops) — that is still a legitimate choice
for a rollback severe enough that even retrieval should pause, just no
longer the ONLY option.

### 7.4 Pending outbox work during a rollback

Per §7.3: pending `claimant_verify` or `owner_claim_notice` rows are
neither lost nor corrupted by disabling — they simply stop being processed
until re-enabled. If a rollback is expected to last more than a few hours,
be aware that a `claimant_verify` row's own verification token still
expires on its normal 24-hour schedule regardless of whether the outbox
poller is running — see §7.5.

### 7.5 Expired links during delivery delays — confirmed safe

A verification token's TTL (24 hours, `server.ts`) is deliberately sized
well above the dispatcher's own worst-case retry span (~11 hours across
all `MAX_NOTIFICATION_ATTEMPTS`) specifically so a message that is retried
right up to the bounded attempt cap still carries a token that has not yet
expired when it finally sends. An expired token is rejected at confirm
time with a clear "This link has expired" message (never silently
succeeds, never issues a certificate) — covered directly by
`backend/test/certificate-claim.test.ts`'s expired-token tests and the
Playwright suite's own expired-link test. The claim form's own "Already
have a certificate? Recover it" path, and the plain resend button, are
both always available as the working recovery path, independent of
whether a specific link happened to expire.

---

## 8. Controlled production smoke test

The operator submits using an email address they control, to verify the
flow end to end before relying on it for real users. This is **not** an
access restriction — per §6.5, the form is reachable by any visitor to the
public site for the entire window `CERTIFICATE_CLAIMS_ENABLED=true` is set,
smoke test or not. "Controlled" here means "the operator knows the
credentials of one specific test submission," not "no one else can submit
one."

1. In the Render dashboard, enter the production configuration exactly as
   in §6.3 Phase 3, with `CERTIFICATE_CLAIMS_ENABLED` left at its LAST
   step.
2. Set `CERTIFICATE_CLAIMS_ENABLED=true` and redeploy/restart.
3. Confirm the startup log line from §6.3 step 9.
4. From the live site (`https://marvinrusinek.github.io/angular-22-quiz-app/`),
   navigate to the claim form and submit with an email address you
   personally control.
5. Confirm the email arrives (allow a few minutes — greylisting on a first
   send is expected and normal, §4.5), click through, confirm explicitly,
   and verify the certificate displays correctly.
6. Confirm the separate owner-notification email also arrives.
7. Check Postmark's own Activity dashboard for both messages' actual
   delivery status.
8. Refresh the certificate page and confirm it still displays (proves
   retrieval-by-token works against the live deployment, not just
   locally).
9. Only after every step above succeeds should the claim form be
   considered ready for real claimant traffic. Until then, treat
   `CERTIFICATE_CLAIMS_ENABLED=true` in production as itself a
   smoke-test-only state, reversible at any point via §7.
