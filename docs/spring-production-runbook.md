# Spring Production Runbook

Operational reference for the Node → Spring backend migration: current
architecture, deployment ownership, required configuration, health checks,
a verification checklist, the rollback procedure, the conditions for
retiring Node, and an incident guide.

Every statement below was checked directly against the repository
(`render.yaml`, `src/index.html`, `src/app/shared/tokens/api-base-url.token.ts`,
`backend/src/config.ts`, `backend-spring/src/main/resources/application.properties`,
the two `.github/workflows/*.yml` files, and `package.json`) plus one live,
non-destructive health check of each production endpoint at the time of
writing. This document changes no runtime behavior — it is documentation only.

---

## 1. Current architecture

- **Frontend**: Angular, statically hosted on **GitHub Pages**, built and
  published manually via `npm run deploy` (`ng build --configuration=production
  && npm run verify:artifact && ngh --dir=dist/demo/browser --no-silent`,
  `package.json`). There is no CI workflow that deploys it — see §2.
- **Spring Boot production API** — Render web service `interview-api-spring`
  (`render.yaml`), built from `backend-spring/Dockerfile`, running on Java 21.
- **Node/Express rollback API** — Render web service `interview-api`
  (`render.yaml`), built from `backend/Dockerfile`. This is the ORIGINAL
  production backend and remains the rollback target.
- **Shared Neon PostgreSQL database** — both services connect to the **same**
  Neon Postgres instance, same `oregon` region (`render.yaml`'s own comments
  on both services state this explicitly). Spring never migrates the schema
  (`spring.jpa.hibernate.ddl-auto=validate` in
  `backend-spring/src/main/resources/application.properties`) — Node's own
  migrations (`backend/src/db/migrations/*.sql`) are the only schema author.
- **Shared Topic Quiz receipt secret** — both services sign/verify Topic Quiz
  attempt and question receipts with the same HMAC secret
  (`TOPIC_QUIZ_RECEIPT_SECRET`). `render.yaml`'s comment on the Spring service
  is explicit: *"MUST be the SAME VALUE as Node's ... NOT a distinct
  per-service secret"* — a receipt issued by one runtime must verify on the
  other for cutover and rollback to both work.
- **Which service Angular currently targets** — this has TWO different
  answers depending on what you inspect, and the distinction matters:
  - The **committed source on `main`**
    (`src/app/shared/tokens/api-base-url.token.ts`) sets
    `PROD_API_BASE_URL = 'https://interview-api-spring.onrender.com/api'` —
    i.e. **Spring**.
  - The **currently deployed GitHub Pages artifact** was built from commit
    `2f2ac8f4` — `gh-pages`'s own HEAD commit (`44f67ef0`) carries the commit
    message `deploy: 2f2ac8f4 - ...`, naming exactly which `main` commit it
    was published from. `gh-pages` is a separately generated deployment
    branch (built output pushed there by `npm run deploy`, not a normal
    development branch), so an ordinary ahead/behind commit count against
    `main` is not a meaningful measure of how "out of date" it is — what
    matters is the one fact above: which `main` commit it was built from.
    Verified directly: `git show 2f2ac8f4:src/app/shared/tokens/api-base-url.token.ts`
    shows `PROD_API_BASE_URL` was still
    `'https://interview-api-c842.onrender.com/api'` at that commit — i.e.
    **Node**. The cutover commit (`feat(api): cut production frontend over
    to Spring`) exists on `main` today but is **not** an ancestor of that
    deploy, and has **not yet been published to GitHub Pages**: the
    currently deployed artifact's compiled/source configuration still
    targets Node.
  - In short: **the live site still calls Node today**; deploying current
    `main` as-is would complete the switch to Spring. Do not assume one
    without checking `gh-pages`'s HEAD commit message against `main` first.
- **Public health/readiness endpoints**:
  - Node: `GET https://interview-api-c842.onrender.com/api/health`
  - Spring: `GET https://interview-api-spring.onrender.com/api/health`
    (liveness) and
    `GET https://interview-api-spring.onrender.com/actuator/health/readiness`
    (readiness)

---

## 2. Deployment ownership

- **GitHub Pages** publishes from the **`gh-pages`** branch (confirmed via
  `git ls-remote --heads origin`). Nothing pushes to it automatically — a
  human runs `npm run deploy` locally, which builds, runs the artifact
  security scanner, and pushes the built output to `gh-pages` via
  `angular-cli-ghpages` (`ngh`).
- **Render services** each watch a branch configured **in the Render
  dashboard**, not in `render.yaml` — the blueprint file has no `branch:` key
  for either service. Confirm the configured branch in the dashboard before
  assuming it is `main`.
- **Render Blueprint Auto Sync** is a per-blueprint dashboard toggle (Render
  Dashboard → Blueprint → Settings), independent of `autoDeploy`. It controls
  whether Render re-reads `render.yaml` from the watched branch and applies
  changes to service *definitions* (plan, region, env var *names*, health
  check path, etc.). This is a setting a human controls in the dashboard —
  this repository does not and cannot assert its current state; check it
  there before relying on a `render.yaml` change alone to take effect.
- **`autoDeploy: false`** is set explicitly on `interview-api-spring` in
  `render.yaml`. Render's own comment there: *"this service is created and
  later promoted only by an explicit operator action in the Render
  dashboard, never by a push to main."* `interview-api` (Node) has no such
  key and so uses Render's default (`autoDeploy` on).
- **What a normal push to `main` does and does not deploy**, given the above:
  - It **does** run whichever GitHub Actions workflows have a matching path
    trigger (see below).
  - It **may** redeploy the Node Render service (`interview-api`), if that
    service's configured branch is `main` and Auto Sync/autoDeploy allow it —
    confirm in the dashboard.
  - It does **not** redeploy the Spring Render service
    (`autoDeploy: false` — requires an explicit dashboard action regardless
    of branch or Auto Sync).
  - It does **not** publish anything to GitHub Pages — that is exclusively
    the manual `npm run deploy` step.
- **GitHub Actions CI vs. Render vs. GitHub Pages — these are three separate
  mechanisms with no automatic hand-off between them**:
  - **CI** (`.github/workflows/`): two workflows exist today —
    `Backend Spring CI` (`backend-spring-ci.yml`, triggers on
    `backend-spring/**` changes) runs `./mvnw -B verify` and a Docker image
    build (never pushed to a registry); `Cross-Runtime Parity (Node vs
    Spring)` (`cross-runtime-parity.yml`, triggers on `backend/**`,
    `backend-spring/**`, `scripts/parity/**`, `package.json`,
    `package-lock.json`, and the synthetic fixture) runs the full black-box
    Node/Spring contract-parity suite. **Neither workflow deploys anything.**
  - **Render** redeploys only the services and only under the conditions
    above — it is not triggered by CI passing or failing.
  - **GitHub Pages** is updated only by a human running `npm run deploy`.

---

## 3. Required environment variables

Names only — no values are recorded anywhere in this document.

**Node (`interview-api`)** — read in `backend/src/config.ts`:

| Variable | Notes |
|---|---|
| `NODE_ENV` | `development` \| `test` \| `production` |
| `PORT` | Supplied by Render at runtime — never hard-code it. |
| `ALLOWED_ORIGINS` | See format below. Required in production (no default). |
| `DATABASE_URL` | A single Postgres connection string with embedded credentials (`postgres://user:pass@host/db`). Required in production. |
| `TOPIC_QUIZ_RECEIPT_SECRET` | ≥32 characters. Required in production; must not equal the built-in development default. |

**Spring (`interview-api-spring`)** — read in
`backend-spring/src/main/resources/application.properties`:

| Variable | Notes |
|---|---|
| `PORT` | Supplied by Render (`server.port=${PORT:8080}`) — never hard-code it. |
| `SPRING_DATASOURCE_URL` | JDBC URL **only** — scheme, host, port, database, query params. No embedded credentials: `jdbc:postgresql://<pooled-host>/<database>?sslmode=require`. `sslmode=require` is the JDBC equivalent of Node's `ssl: { rejectUnauthorized: false }` posture (encrypted, no certificate-chain validation) — not `disable` (unencrypted) and not `verify-full` (adds validation Node doesn't do either). |
| `SPRING_DATASOURCE_USERNAME` | Separate from the URL — Spring's datasource properties reject/mishandle a JDBC URL with embedded credentials. |
| `SPRING_DATASOURCE_PASSWORD` | Same as above. |
| `TOPIC_QUIZ_RECEIPT_SECRET` | Same variable **name** and must be the same **value** as Node's. ≥32 characters; the app refuses to start otherwise. |
| `ALLOWED_ORIGINS` | Same variable name as Node, same format (below). |

- **Shared receipt secret**: during any period where Node and Spring are
  expected to interoperate (compatibility testing, an active rollback), both
  services' `TOPIC_QUIZ_RECEIPT_SECRET` must hold the **identical** value. A
  mismatch does not merely break one service — every in-flight Topic Quiz
  receipt issued by one runtime becomes unverifiable by the other.
- **`ALLOWED_ORIGINS` format** (enforced by both runtimes, confirmed in
  `backend/src/config.ts`'s `parseAllowedOrigins`): a comma-separated list of
  **exact origins** — scheme + host + optional port, **no path, no query, no
  fragment** (an HTTP `Origin` header never carries a path, so
  `https://marvinrusinek.github.io/angular-22-quiz-app/` is invalid; use
  `https://marvinrusinek.github.io`). A literal `*` is rejected outright.
  HTTPS is required for every entry once the service considers itself in
  production.
- **`PORT` is supplied by Render** for both services — do not set it manually
  in either service's environment.
- **Never commit a `.env` file, and never paste a secret value — including a
  connection string, the receipt secret, or a signed receipt token — into a
  log, a commit message, an issue, or this document.** `backend/.env` exists
  locally for development only and must stay untracked and unshared.

---

## 4. Health and smoke checks

All checks below are plain `GET` requests — non-destructive, no
authentication, safe to run at any time.

```bash
# Node liveness
curl -s -o /dev/null -w "%{http_code}\n" https://interview-api-c842.onrender.com/api/health
# expect: 200, body {"status":"ok","uptimeSeconds":<n>}

# Spring liveness
curl -s -o /dev/null -w "%{http_code}\n" https://interview-api-spring.onrender.com/api/health

# Spring readiness — confirms Spring's own configured readiness signal
# (application-lifecycle state), NOT database connectivity by itself —
# see the explanation below.
curl -s -o /dev/null -w "%{http_code}\n" https://interview-api-spring.onrender.com/actuator/health/readiness
# expect: 200, body {"status":"UP"}

# Representative metadata check (either service) — a REAL database-backed
# endpoint, and the actual evidence that Spring can reach and query
# PostgreSQL (readiness alone does not prove this — see below).
curl -s https://interview-api-spring.onrender.com/api/quizzes | head -c 300

# Node rollback health check (same as the Node liveness check above —
# this IS the rollback target's own health endpoint)
curl -s https://interview-api-c842.onrender.com/api/health
```

Expected successful status: **200** for every check above. A non-200, a
connection timeout, or an empty body is the first sign of an issue — see §8.

- **`/api/health` (both services) is the lighter check**: it only proves the
  process is running and answering HTTP — Spring's own doc comment on
  `HealthController` calls it *"liveness probe, parity with the Node
  reference's `GET /api/health`"*. It says nothing about the database.
- **`/actuator/health/readiness` (Spring only) confirms Spring's own
  configured readiness signal** — i.e. that the application context has
  reached a state Spring Boot considers "ready to accept traffic." It does
  **not**, by itself, prove database connectivity: this repository's
  `application.properties` has no explicit
  `management.endpoint.health.group.readiness.include=...db` (or equivalent)
  wiring the datasource health contributor into that specific group, and
  this document did not independently reverse-engineer Spring Boot's health
  group internals to confirm otherwise.
  `render.yaml`'s own comment on this service currently states a stronger
  claim — *"only the readiness group actually pings the DataSource, so
  Render only marks this service healthy when Neon is genuinely reachable"*
  — but that is `render.yaml`'s own **assumption**, not something verified
  here, and it should be **audited separately** rather than repeated as
  fact.
  For actual evidence that Spring can reach and query PostgreSQL, use a real
  database-backed endpoint instead — **`GET /api/quizzes`** (§4's own
  metadata check, above) only returns a real quiz list when the datasource
  is genuinely reachable, since the quiz repository reads from Postgres on
  every call.
- **Observed free-tier cold-start range (this session's own direct
  measurements, not a vendor SLA)**: a fully cold Render container took
  **55.7s and, on a separate occasion, 124.7s** to answer even a bare health
  check; Neon's own compute wake alone (container already warm) measured
  **10.2s–13.1s** across several runs. `render.yaml`'s own comment estimates
  "roughly 30-60 seconds." Earlier in this same working session, a live
  Spring readiness check took **45.5s, and on a separate attempt ~90s before
  succeeding on retry** — consistent with that range; both services were
  already warm by the time this document's own final health checks ran
  (Node uptime 947s, Spring uptime 622s at that point), which is why those
  specific checks completed in well under a second each — a warm response is
  fast precisely because the cold-start cost above is a one-time, per-idle-
  period cost, not a permanent latency tax.
  **A first request after an idle period can exceed the frontend's own
  45-second client-side timeout** (`QUESTION_LOAD_TIMEOUT_MS` in
  `IntroductionComponent`) — this is expected, not a bug, and is exactly what
  that timeout's "server is still waking up" Retry state exists to handle.

---

## 5. Production verification checklist

Run manually against whichever origin is under test (see §1 for which one is
currently live). None of these steps mutate Neon data in a way that would
need reverting — Topic Quiz reads and answer-checks are stateless; an
Interview Mode session created for this purpose is ordinary, real usage of
the feature, not a special test path.

- [ ] **Quiz Selection metadata** — the quiz list loads with correct titles,
  difficulty, and question counts (`GET /api/quizzes`).
- [ ] **Topic Quiz start/check flow** — starting a quiz issues an attempt
  receipt, starting a question issues a question receipt, and submitting a
  correct and an incorrect answer both return the expected outcome shape.
- [ ] **No answer-key or correctness leakage before authorized checking** —
  inspect the raw response of `GET /api/quizzes/:quizId/questions` and
  confirm no `correct`, `correctOptionTexts`, `correctOptionIds`,
  `isCorrect`, or `explanation` field is present anywhere in it.
- [ ] **Interview Mode**: create → resume → answer → mark a question for
  review → submit → read the result, end to end.
- [ ] **Refresh/resume** — reload the browser mid-quiz and mid-interview and
  confirm state is recovered from the server rather than lost.
- [ ] **CORS from the GitHub Pages origin** — confirm requests from
  `https://marvinrusinek.github.io` succeed (this is the only origin
  currently listed for Spring in `render.yaml`; Node also lists the
  StackBlitz preview origin).
- [ ] **Mobile validation remains deferred** until reliable mobile data or
  Wi-Fi is available — do not attempt it opportunistically on unreliable
  mobile data, per the standing instruction from the paused mobile
  investigation earlier in this project.
- [ ] **CI workflows** — confirm both `Backend Spring CI` and
  `Cross-Runtime Parity (Node vs Spring)` are green on the commit being
  verified (GitHub → Actions tab), and that each triggered only for the
  paths it's actually scoped to.

---

## 6. Rollback procedure

Rolling back means pointing the Angular frontend back at Node. It does
**not** mean touching Render service configuration, Neon, or any backend
code — Node has been running the whole time as the passive rollback target.

1. **Files/settings that switch Angular back to Node**:
   - `src/app/shared/tokens/api-base-url.token.ts` —
     change `PROD_API_BASE_URL` back to
     `'https://interview-api-c842.onrender.com/api'`.
   - No other frontend file encodes which backend is "production" — this is
     the single point of truth (see the file's own doc comment: *"The active
     origin here and PROD_API_BASE_URL ... are ONE setting"*).
2. **Keep both origins in the CSP `connect-src`** in `src/index.html` for the
   whole observation window regardless of which way the cutover currently
   points — both `https://interview-api-spring.onrender.com` and
   `https://interview-api-c842.onrender.com` are already listed there today.
   Removing either early would fail closed silently: the browser blocks the
   request before it is even sent, with nothing informative in the network
   tab.
3. **Rebuild, scan, and deploy**:
   ```bash
   ng build --configuration=production
   npm run verify:artifact
   ngh --dir=dist/demo/browser --no-silent
   ```
   (equivalently, `npm run deploy`, which runs all three in sequence).
4. **Post-rollback smoke checks** — repeat §4's health checks against
   `interview-api-c842.onrender.com`, then repeat the relevant items from
   §5's checklist end to end against the now-live Node backend.
5. **Rollback must not modify or migrate Neon data.** Node and Spring are
   built to read and write the same schema compatibly — there is no
   data-layer step in a rollback, only a frontend redeploy. Do not run any
   migration, `import:quiz-bank`, or manual SQL as part of a rollback.
6. **Never include credentials or signed receipts** in a rollback record,
   ticket, or postmortem — a signed receipt is answer-key-adjacent material
   (it authorizes a reveal) and a connection string is a credential; neither
   belongs in a shareable document.

---

## 7. Node-retirement gates

Nothing in this document retires or deletes anything. This section only
defines the conditions and the order for when that becomes appropriate —
each numbered step below is itself a separate, later, reviewed task.

**Conditions that must all be true before retiring Node:**

- A stable Spring observation period has elapsed with production (or
  production-representative) traffic.
- Successful desktop **and** normal-network mobile testing has been
  completed — not just desktop, and not mobile testing performed under
  known-unreliable mobile data.
- No unexplained 5xx/504 pattern beyond the understood free-tier cold-start
  behavior documented in §4 — a cold start timing out is expected; a warm
  request failing is not.
- Topic Quiz and Interview Mode flows are verified end-to-end against Spring
  (§5's checklist, run to completion, not just started).
- The `Cross-Runtime Parity` CI workflow is consistently green across
  multiple recent commits, not a single lucky run.
- The rollback procedure in §6 has actually been tested at least once, not
  merely documented.

**Ordered retirement sequence, once every condition above holds:**

1. Remove Node as the active rollback configuration (stop treating it as the
   thing §6 would roll back to).
2. Remove its CSP origin from `src/index.html` — **only after** rollback is
   no longer needed, never before.
3. Build, test, and deploy Angular with that CSP change.
4. Observe Spring again, on its own, with no Node fallback in place.
5. Delete the Node Render service (`interview-api`) **last**, only after the
   above has held.
6. Remove obsolete Node deployment configuration/code — as its own,
   separately reviewed task, not bundled into any of the steps above.

---

## 8. Incident guide

Collect evidence before acting. Never restart a service or click retry
repeatedly as a first response — both can mask what actually happened and
waste the cold-start window that would otherwise resolve it.

| Symptom | Likely cause | Evidence to collect |
|---|---|---|
| Browser console shows a CORS error; network tab shows the request never got a response, or an OPTIONS preflight failed | The calling origin isn't in `ALLOWED_ORIGINS` for the target service, or the CSP `connect-src` doesn't list the target origin | The exact `Origin` the browser sent; the full CSP header/meta tag; which service was targeted; whether the request is a simple GET or a preflighted one (custom header/non-GET) |
| First request after a quiet period hangs for 30–90+ seconds, then succeeds | Render container cold start (§4's observed range) | Time from request start to first byte; whether a RETRY without waiting fails identically (it will, if still cold) or succeeds after waiting |
| Request succeeds but takes 10–15s specifically on a database-touching endpoint, `/api/health` itself is fast | Neon compute wake (container already warm, database was not) | Compare `/api/health` latency (fast, no database access) against a real data-fetching endpoint's latency such as `GET /api/quizzes` (slow) at the same moment — `/actuator/health/readiness` is not reliable evidence here (see §4) |
| Sustained 5xx/504s that do NOT resolve after a generous wait (several minutes) | A genuine backend outage or misconfiguration, not a cold start | Render service logs/dashboard status; whether BOTH services are affected (points to Neon) or only one (points to that service); the exact HTTP status and body of the failing response |
| Spinner runs for exactly 45 seconds then shows "server is still waking up" with a Retry button | This is the frontend's own bounded timeout firing as designed, not a bug | Whether a subsequent click succeeds (backend was cold, now warm) or times out again identically (points to a real outage, not a cold start) |

**Expected frontend behavior, for calibrating whether what you're seeing is
normal**: one click starts exactly one logical request; the spinner stays
visible for the duration of that request (not a fixed short animation); if
no response arrives within 45 seconds, the spinner is replaced by a "server
is still waking up" message and a Retry button, and clicking Retry either
reuses the still-in-flight original request or starts exactly one fresh one,
never more.
