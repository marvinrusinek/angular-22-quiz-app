# Spring Production Runbook

Operational reference for the **permanent split-backend architecture**:
Node/Express keeps Topic Quizzes, Spring Boot takes over Interview Mode, and
Angular routes each feature to the correct one. This document covers current
architecture, deployment ownership, required configuration, health checks, a
verification checklist, the Interview-Mode-only rollback procedure, and an
incident guide.

**This is not a full cutover.** Spring is not replacing Node globally — Node
remains a permanent production service for Topic Quizzes, not a temporary
rollback target scheduled for retirement.

Every statement below was checked directly against the repository
(`render.yaml`, `src/index.html`, `src/app/shared/tokens/api-base-url.token.ts`,
every Angular service that calls the API, `backend/src/config.ts`,
`backend-spring/src/main/resources/application.properties`, the two
`.github/workflows/*.yml` files, and `package.json`) plus live, non-destructive
health checks. This document changes no runtime behavior — it is
documentation only.

---

## 1. Current architecture

### Three states — do not conflate them

- **Live production today**: GitHub Pages currently routes **all** API
  traffic to **Node**. The deployed artifact (`gh-pages` HEAD `44f67ef0`,
  commit message `deploy: 2f2ac8f4 - ...`) was built from a `main` commit
  whose `api-base-url.token.ts` still set
  `PROD_API_BASE_URL = 'https://interview-api-c842.onrender.com/api'`
  (verified directly: `git show 2f2ac8f4:src/app/shared/tokens/api-base-url.token.ts`).
  `gh-pages` is a separately generated deployment branch (built output pushed
  by `npm run deploy`), so an ordinary ahead/behind commit count against
  `main` is not a meaningful measure of staleness — what matters is which
  `main` commit it was built from, which is the fact above.
- **Current committed `main`**: contains a **global** Spring base-url change
  (`PROD_API_BASE_URL = 'https://interview-api-spring.onrender.com/api'`,
  from commit `feat(api): cut production frontend over to Spring`) that
  routes **every** API consumer — Topic Quiz and Interview Mode alike — to
  Spring. **This is not the desired final architecture and must not be
  deployed to `gh-pages` as-is.** The routing audit below confirms every
  current API-calling service injects the same single `API_BASE_URL` token
  (`src/app/shared/tokens/api-base-url.token.ts`) — there is no per-feature
  split in the *committed* code, only this one global value. (See the
  Intended-target bullet below: the split now exists in the local working
  tree, uncommitted as of this writing.)
- **Intended target — IMPLEMENTED IN CODE, NOT YET DEPLOYED**: **permanent
  split routing** — Topic Quiz traffic to Node, Interview Mode session
  lifecycle to Spring, both reading the same Neon database. The mechanism
  is two separate `InjectionToken`s in
  `src/app/shared/tokens/api-base-url.token.ts`: `API_BASE_URL` (Node —
  `PROD_API_BASE_URL` / `DEV_API_BASE_URL`, port 3000 locally) and
  `INTERVIEW_API_BASE_URL` (Spring — `INTERVIEW_PROD_API_BASE_URL` /
  `INTERVIEW_DEV_API_BASE_URL`, port 8080 locally), both registered in
  `main.ts` via `provideApiBaseUrl()` / `provideInterviewApiBaseUrl()`.
  `TopicQuizMetadataService`/`TopicQuizQuestionsService`/the Topic-Quiz
  verdict services and `PracticeVerdictService` keep injecting `API_BASE_URL`
  exactly as before; `InterviewApiService` injects **only**
  `INTERVIEW_API_BASE_URL` for its session-lifecycle calls (create, resume,
  answer, mark-for-review, submit, result) and never injects `API_BASE_URL`
  at all — its `getQuizMetadata()` instead delegates to the Node-owned
  `TopicQuizMetadataService.load()` (see the ambiguous-case resolution
  below), so the one service that talks to Spring never holds a second base
  URL of its own. `apiErrorInterceptor` recognizes requests to either
  configured base. The CSP `connect-src` in `src/index.html` lists both
  production origins and both local dev ports
  (`localhost`/`127.0.0.1:3000` for Node, `:8080` for Spring).
  Verified so far: the full Jest suite (2653 tests, including new coverage
  for token resolution on both bases, metadata delegation issuing no Spring
  request, and the interceptor recognizing both bases), a clean
  `ng build --configuration=production`, `npm run verify:artifact` (PASS),
  and direct inspection of the compiled production bundle confirming the two
  base-URL constants and two distinct injection tokens never cross-wire.
  **Not yet verified**: a live browser session with both backends actually
  running side by side, and this change is **not yet committed, pushed, or
  deployed** — `gh-pages` still serves the current committed `main` (see
  below).

### Routing inventory (evidence-based, traced from the actual Angular services)

| Functional area | Consumer service(s) | Endpoint(s) | Intended backend |
|---|---|---|---|
| Quiz Selection metadata | `TopicQuizMetadataService` | `GET /quizzes` | **Node** |
| Introduction metadata + Topic Quiz start | `TopicQuizMetadataService`; `QuizDataService` → `TopicQuizQuestionsService` | `GET /quizzes`, `GET /quizzes/:id/questions` | **Node** |
| Topic Quiz question retrieval | `TopicQuizQuestionsService` | `GET /quizzes/:id/questions` | **Node** |
| Topic Quiz receipt issuance/checking | `TopicQuizAttemptService`, `ApiVerdictAdapter` | `POST /quizzes/:id/attempts`, `/questions/start`, `/check` | **Node** |
| Topic Quiz results/history/progress/achievements | `AchievementService`, `ProgressService`, `BestScoreService` | none — localStorage only | **local-only, no API** |
| Weak Areas Practice | `PracticeSessionService` (local-only); `PracticeVerdictService` | `POST /quizzes/:id/check` (same endpoint Topic Quiz uses) | **Node** for the check call; local-only for session/progress state |
| Interview builder metadata/presets | `InterviewApiService.getQuizMetadata()`; presets are a hardcoded local constant (`interview-preset.model.ts`, never fetched) | `GET /quizzes` — **the identical path** `TopicQuizMetadataService` calls, from a separate service instance | **AMBIGUOUS — see recommendation below** |
| Interview session create/resume | `InterviewApiService` | `POST /interview-sessions`, `GET /interview-sessions/:id` | **Spring** |
| Interview answer persistence + Mark for Review | `InterviewApiService` | `PUT /interview-sessions/:id/answers/:qId`, `PUT .../review/:qId` | **Spring** |
| Interview submit/result/review/history | `InterviewApiService` (submit/result); `InterviewHistoryService` (local-only) | `POST .../submit`, `GET .../result` | **Spring** for submit/result; **local-only** for the history list |
| Guards/resolvers | `QuizGuard`/`QuizResolverService` → the Node-side metadata service; `BackendInterviewSessionGuard`/`BackendInterviewResultGuard` → `InterviewApiService`; `PracticeSessionGuard`/`PracticeResultGuard` → local-only | none of their own — all delegate | matches whatever they delegate to |
| Hardcode check | — | `grep -rn "onrender.com" src/app` finds **exactly one** hit, `api-base-url.token.ts` | confirms today's single global token, no bypass |

**The one genuinely ambiguous case, marked explicitly rather than guessed
at**: `GET /quizzes` (topic/question-count metadata) is called
independently by two separate Angular services —
`TopicQuizMetadataService` (Topic Quiz) and `InterviewApiService.getQuizMetadata()`
(Interview builder) — both currently hitting the one global `API_BASE_URL`.
Recommended smallest ownership rule, consistent with Topic Quiz staying on
Node, Interview session lifecycle moving to Spring, and avoiding a
duplicate metadata implementation: **Node remains the canonical owner of
this metadata**, since it owns the underlying question bank the metadata
describes, and the Interview builder should keep reading that same
Node-served endpoint rather than a separate Spring copy. This means
`InterviewApiService` would need to resolve **two different base URLs**
internally once split (Node for `getQuizMetadata()`, Spring for everything
session-related) — a real implementation detail for a later task, not
something this document invents a solution for now. **Interview builder
metadata stays Node-owned unless a later task's implementation evidence
concretely requires a different design** — this is a recommendation based
on today's code, not a permanent rule immune to revision.

### Facts that don't change with the split
- **Shared Neon PostgreSQL database** — both services connect to the
  **same** Neon Postgres instance, same `oregon` region (`render.yaml`'s own
  comments on both services state this explicitly). Spring never migrates
  the schema (`spring.jpa.hibernate.ddl-auto=validate`) — Node's own
  migrations (`backend/src/db/migrations/*.sql`) are the only schema author.
- **Shared Topic Quiz receipt secret** — both services sign/verify Topic
  Quiz attempt/question receipts with the same HMAC secret
  (`TOPIC_QUIZ_RECEIPT_SECRET`), so a receipt issued by one runtime verifies
  on the other. This exists for cross-runtime contract compatibility (the
  parity CI suite) — Interview Mode's own auth is a separate bearer-token
  mechanism (a session-token hash stored in Postgres), not this secret, so
  it isn't itself required for an Interview-only rollback.
- **Public health/readiness endpoints**:
  - Node: `GET https://interview-api-c842.onrender.com/api/health`
  - Spring: `GET https://interview-api-spring.onrender.com/api/health`
    (liveness) and
    `GET https://interview-api-spring.onrender.com/actuator/health/readiness`
    (readiness)
- **Both production origins must remain in the CSP `connect-src`
  (`src/index.html`) permanently while this split architecture is in use** —
  not just for an "observation window." Node serves Topic Quizzes forever
  under this design; removing its origin would break a permanent feature,
  not just a rollback path.

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
  key and so uses Render's default (`autoDeploy` on) — as befits a
  **permanent** production service, not a rollback target being phased out.
- **What a normal push to `main` does and does not deploy**:
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
- **GitHub Actions CI vs. Render vs. GitHub Pages — three separate
  mechanisms with no automatic hand-off between them**:
  - **`Backend Spring CI`** (`backend-spring-ci.yml`, triggers on
    `backend-spring/**`) validates **Spring only** — `./mvnw -B verify` and
    a Docker image build (never pushed to a registry).
  - **`Cross-Runtime Parity (Node vs Spring)`** (`cross-runtime-parity.yml`,
    triggers on `backend/**`, `backend-spring/**`, `scripts/parity/**`,
    `package.json`, `package-lock.json`, and the synthetic fixture) protects
    the **shared contracts** both services must keep honoring — metadata
    shape, Topic Quiz receipts, and Interview Mode session behavior — which
    is also what keeps an Interview-Mode-to-Node rollback (§6) credible: if
    this suite stays green, Node's own Interview endpoints haven't silently
    drifted out of compatibility while Spring has been the one serving that
    traffic.
  - **Neither workflow deploys Angular, Render, or GitHub Pages.** Render
    redeploys only under the conditions above, independent of CI outcome;
    GitHub Pages is updated only by a human running `npm run deploy`.

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
| `TOPIC_QUIZ_RECEIPT_SECRET` | Same variable **name** and must be the same **value** as Node's, for cross-runtime receipt/contract compatibility (§1, §2). ≥32 characters; the app refuses to start otherwise. |
| `ALLOWED_ORIGINS` | Same variable name as Node, same format (below). |

- **Shared receipt secret**: `TOPIC_QUIZ_RECEIPT_SECRET` must hold the
  **identical** value on both services. A mismatch does not merely break
  one service — every in-flight Topic Quiz receipt issued by one runtime
  becomes unverifiable by the other, and the parity CI suite would start
  failing.
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
authentication, safe to run at any time. **Node health reflects Topic Quiz
availability; Spring health/readiness reflects Interview Mode availability.
Diagnose a failure in one independently from the other** — they are
different features on different services, not two versions of the same one.

```bash
# Node liveness — Topic Quiz availability signal
curl -s -o /dev/null -w "%{http_code}\n" https://interview-api-c842.onrender.com/api/health
# expect: 200, body {"status":"ok","uptimeSeconds":<n>}

# Spring liveness — Interview Mode process availability signal
curl -s -o /dev/null -w "%{http_code}\n" https://interview-api-spring.onrender.com/api/health

# Spring readiness — confirms Spring's own configured readiness signal
# (application-lifecycle state), NOT database connectivity by itself —
# see the explanation below.
curl -s -o /dev/null -w "%{http_code}\n" https://interview-api-spring.onrender.com/actuator/health/readiness
# expect: 200, body {"status":"UP"}

# Representative Topic Quiz metadata check (Node) — a REAL database-backed
# endpoint, and the actual evidence Node can reach and query PostgreSQL.
curl -s https://interview-api-c842.onrender.com/api/quizzes | head -c 300

# Representative Interview-Mode-adjacent database check (Spring) — same
# reasoning: a real database-backed endpoint, not readiness, is the
# evidence Spring can reach and query PostgreSQL.
curl -s https://interview-api-spring.onrender.com/api/quizzes | head -c 300
```

Expected successful status: **200** for every check above. A non-200, a
connection timeout, or an empty body is the first sign of an issue — see §8.

- **`/api/health` (both services) is the lighter check**: it only proves the
  process is running and answering HTTP — Spring's own doc comment on
  `HealthController` calls it *"liveness probe, parity with the Node
  reference's `GET /api/health`"*. It says nothing about the database.
- **`/actuator/health/readiness` (Spring only) — audited and empirically
  verified, not assumed.** By default, Spring Boot does not add other
  health indicators to the liveness/readiness groups
  ([Spring Boot reference docs, Actuator Endpoints — Liveness and Readiness Probes](https://docs.spring.io/spring-boot/reference/actuator/endpoints.html)),
  and that default is confirmed unmodified here: `backend-spring/src/main/resources/application.properties`
  sets no `management.endpoint.health.group.readiness.include`. The
  current readiness group contains **only `readinessState`** — Spring's
  own application-lifecycle signal (has the context finished starting up),
  nothing else. It does **not** test PostgreSQL availability. This was
  proven directly, not inferred from documentation: against a disposable
  Postgres instance, with Spring started successfully and then Postgres
  stopped (no restart of Spring), `/actuator/health/readiness` stayed at
  **200 `{"status":"UP"}` for the entire outage**, while the same request
  against `/actuator/health` (ungrouped, which does include the `db`
  contributor) correctly returned **503 `{"status":"DOWN"}`**, and an
  actual database-backed request — `GET /api/quizzes` — failed with a
  **500** after Spring's own ~30-second connection-attempt wait. Restoring
  Postgres (still without restarting Spring) brought both
  `/actuator/health` and `GET /api/quizzes` back to 200 automatically.
  `render.yaml`'s health-check-path comment previously claimed readiness
  "pings the DataSource" — that claim was **false** and has been corrected
  there to match this verified behavior.
  **`db` is deliberately not being added to the readiness group.** The
  reason is a concrete timing mismatch, not a convention: HikariCP's
  observed/default connection-attempt wait is **~30 seconds** (confirmed
  above), while Render's own health-check request times out at **5
  seconds** ([render.com/docs/health-checks](https://render.com/docs/health-checks)).
  Wiring `db` into readiness as-is would make an ordinary, transient Neon
  free-tier wake (measured elsewhere in this document at 10–13s, up to
  55–125s fully cold) look identical to a hard failure to Render — risking
  Render pulling an otherwise-healthy instance out of rotation or
  restarting it during exactly the wake window it should be tolerating.
  For actual evidence that Spring can reach and query PostgreSQL, use a
  real database-backed endpoint instead — **`GET /api/quizzes`**, not
  readiness.
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
  This applies to Node for Topic Quiz cold starts and to Spring for
  Interview Mode cold starts independently.

### Interview creation's bounded automatic-retry recovery (verified 2026-09-15/16)

Client-side commits `e10e1499` (idempotency/replay) and `90414f68` (one
automatic retry) proved insufficient against a genuinely cold Render/Neon
stack, and a further fix (this task) extended the design and added a
Builder-side warm-up. The facts below are what was directly observed —
**observations, not an SLA**, and Render's own free-tier behavior can vary
run to run.

- **Render free-tier Spring instances can sleep**, and **Node and Spring
  wake independently of each other** — one being warm says nothing about
  the other. **Neon's own database compute can ALSO require a separate
  wake** even once its container is warm (see the 10.2s–13.1s Neon-only
  figure above) — three independent things that can each be cold at once,
  not one.
- **`/api/health` wakes the CONTAINER; it proves nothing about PostgreSQL
  connectivity** — this was already true of Spring's readiness endpoint
  (§4 above) and is equally true of a plain `/api/health` ping used as a
  warm-up. A 200 from `/api/health` is evidence the process is answering
  HTTP, never evidence the database is reachable.
- **The Interview Builder now fires one best-effort `/api/health` ping to
  Spring on open**, in parallel with Node's own topic-metadata load,
  purely to give Spring's container a head start before the user's
  eventual Start Assessment click. It is NOT a readiness guarantee: it
  never blocks rendering, never gates form validity or the Start button,
  never surfaces a failure, is sent at most once per Builder page life,
  and is cancelled (via the request's own subscription teardown) if the
  Builder is left before it resolves. Whether it measurably shortens the
  FIRST real cold-start request has not been isolated from ordinary
  variance in Render's own boot time — treat it as a plausible small
  head start, not a proven fix in its own right.
- **A real production observation, 2026-09-15**: after an overnight idle,
  one click on Start Assessment produced a POST that reached Spring's own
  60-second client-side timeout, an automatic same-key retry that ALSO
  reached that 60-second timeout (120s combined — worse than this
  document's own previously-measured ~125s extreme, which was for a bare
  health check, not a full session-creation write), after which the UI
  correctly fell back to its safe final state (spinner cleared, manual
  Retry offered, zero stuck/contradictory state, zero requests to Node).
  The VERY NEXT request — Spring now warm from those two attempts —
  succeeded in **~4 seconds**. That specific gap (a real cold start
  exceeding a two-attempt budget, immediately followed by a fast warm
  response) is what motivated extending the design to **three total
  attempts** (the initial request plus two automatic retries, still one
  logical attempt, one idempotency key, one immutable request) — closing
  exactly the observed gap without turning the retry into an open-ended
  loop.
- **A final manual Retry state always remains** after all bounded
  automatic attempts fail. No networked application — this one included —
  can guarantee success during a genuine, extended provider outage; the
  bounded automatic sequence exists to absorb the OBSERVED ordinary
  cold-start range, not to eliminate every possible failure mode.
- **Do not add periodic keep-alive traffic** (a cron hitting `/api/health`
  every N minutes to prevent the free tier from ever sleeping) as a "fix"
  for any of the above. It works against Render's own free-tier billing
  model, does not address Neon's independent wake cost, and papers over
  the cold-start path this document's own verification checklist (§5)
  and the one-click recovery design both depend on actually being
  exercised and correct. **The only fully reliable way to eliminate
  container spin-down is an always-on (paid) Render plan** — the
  free-tier design in this codebase is built to recover from the
  OBSERVED cold-start range without a second user click, not to make
  cold starts stop happening.

---

## 5. Production verification checklist

Once split routing exists, run these against the **specific backend each
feature is supposed to use** — Topic Quiz items against Node, Interview
items against Spring — not "whichever origin happens to be live." None of
these steps mutate Neon data in a way that would need reverting — Topic
Quiz reads and answer-checks are stateless; an Interview Mode session
created for this purpose is ordinary, real usage of the feature, not a
special test path.

- [ ] **Quiz Selection metadata** (Node) — the quiz list loads with correct
  titles, difficulty, and question counts (`GET /api/quizzes`).
- [ ] **Topic Quiz start/check flow** (Node) — starting a quiz issues an
  attempt receipt, starting a question issues a question receipt, and
  submitting a correct and an incorrect answer both return the expected
  outcome shape.
- [ ] **No answer-key or correctness leakage before authorized checking**
  (Node) — inspect the raw response of `GET /api/quizzes/:quizId/questions`
  and confirm no `correct`, `correctOptionTexts`, `correctOptionIds`,
  `isCorrect`, or `explanation` field is present anywhere in it.
- [ ] **Interview Mode** (Spring): create → resume → answer → mark a
  question for review → submit → read the result, end to end.
- [ ] **Refresh/resume** — reload the browser mid-quiz (Node) and
  mid-interview (Spring) and confirm state is recovered from the
  respective server rather than lost.
- [ ] **CORS from the GitHub Pages origin** — confirm requests from
  `https://marvinrusinek.github.io` succeed against **both** origins
  (currently the only one listed for Spring in `render.yaml`; Node also
  lists the StackBlitz preview origin).
- [ ] **Browser network verification, desktop and mobile** — once split
  routing is deployed, open the browser devtools network tab and confirm
  Topic Quiz requests go only to the Node origin and Interview session/
  result requests go only to the Spring origin, on both a desktop browser
  and a mobile browser.
- [ ] **Mobile validation remains deferred** until reliable mobile data or
  Wi-Fi is available — do not attempt it opportunistically on unreliable
  mobile data, per the standing instruction from the paused mobile
  investigation earlier in this project.
- [ ] **CI workflows** — confirm both `Backend Spring CI` and
  `Cross-Runtime Parity (Node vs Spring)` are green on the commit being
  verified (GitHub → Actions tab), and that each triggered only for the
  paths it's actually scoped to.
- [ ] **The current global Spring configuration on `main` must be
  corrected to split routing before any `gh-pages` deployment** — deploying
  `main` as-is today would send Topic Quiz traffic to Spring too, which is
  not the intended architecture.

---

## 6. Rollback procedure — Interview Mode only

**Rollback in this architecture means routing Interview Mode back to Node.
It does not affect Topic Quiz, which stays on Node throughout — there is
nothing to roll back for a feature that never left it.** It also does not
mean touching Render service configuration, Neon, or backend code — Node
has been running the whole time.

1. **Once split routing is committed and deployed**, rolling back Interview
   Mode means changing `INTERVIEW_PROD_API_BASE_URL` in
   `src/app/shared/tokens/api-base-url.token.ts` (or the `url` argument
   passed to `provideInterviewApiBaseUrl()` in `main.ts`) back to Node's
   origin — `INTERVIEW_API_BASE_URL` is a separate token from `API_BASE_URL`
   by construction, so this is the **only** constant that needs to change;
   Node's own `PROD_API_BASE_URL` and every Topic-Quiz-adjacent service are
   untouched by definition. As of this writing that mechanism exists in the
   local working tree but is **not yet committed, pushed, or deployed** —
   the routing audit above still describes the *committed* `main`, which has
   no split at all yet.
2. **Keep both origins in the CSP `connect-src`** in `src/index.html`
   permanently while this architecture is in use (§1) — both
   `https://interview-api-spring.onrender.com` and
   `https://interview-api-c842.onrender.com` are already listed there
   today. Removing either would fail closed silently: the browser blocks
   the request before it is even sent, with nothing informative in the
   network tab — and Node's origin specifically must never be removed,
   since Topic Quiz depends on it permanently.
3. **Rebuild, scan, and deploy** (once the split-routing change above
   exists):
   ```bash
   ng build --configuration=production
   npm run verify:artifact
   ngh --dir=dist/demo/browser --no-silent
   ```
   (equivalently, `npm run deploy`, which runs all three in sequence).
4. **Post-rollback smoke checks** — repeat §4's health checks against
   `interview-api-c842.onrender.com`, then repeat §5's Interview Mode
   checklist items end to end against Node. Topic Quiz checks should show
   no change at all, since Topic Quiz traffic never moved.
5. **Rollback must not modify or migrate Neon data.** Node and Spring have
   been proven to read and write the same schema compatibly (the parity CI
   suite) — there is no data-layer step in an Interview Mode rollback, only
   a frontend redeploy. Do not run any migration, `import:quiz-bank`, or
   manual SQL as part of a rollback.
6. **Never include credentials or signed receipts** in a rollback record,
   ticket, or postmortem — a signed receipt is answer-key-adjacent material
   (it authorizes a reveal) and a connection string is a credential; neither
   belongs in a shareable document.

---

## 7. Future split-rollout deployment guidance

This section replaces any prior Node-retirement planning — **Node is not
being retired**. It exists permanently as the Topic Quiz backend. What
follows is guidance for the still-pending work of actually implementing and
deploying the split (none of which has happened yet):

- **Before any `gh-pages` deployment**, the current global Spring
  configuration on `main` must be corrected to route only Interview Mode to
  Spring, with Topic Quiz (and the ambiguous shared metadata call, per §1's
  recommendation) staying on Node. Deploying `main` as it stands today would
  send Topic Quiz traffic to Spring, which is not the intended design.
- **After that change deploys**, verify with the browser network tab (§5)
  on both desktop and a normal-network mobile device that Topic Quiz
  requests go only to Node and Interview session/result requests go only
  to Spring.
- **Verify CSP** (`src/index.html`'s `connect-src`) still lists both
  production origins after the change — the split architecture needs both
  permanently, unlike a temporary cutover that would eventually drop one.
- **CI does not gate or perform this deployment.** `Backend Spring CI` and
  `Cross-Runtime Parity` (§2) validate the backends and their shared
  contracts respectively; neither one builds, tests, or deploys the
  Angular frontend, and neither touches Render or GitHub Pages. The
  `gh-pages` deploy step remains the manual `npm run deploy` command,
  run only after the above verification.

---

## 8. Incident guide

Collect evidence before acting. Never restart a service or click retry
repeatedly as a first response — both can mask what actually happened and
waste the cold-start window that would otherwise resolve it. **Diagnose a
Node incident and a Spring incident independently — they serve different
features (Topic Quiz vs. Interview Mode) and a problem in one says nothing
about the other**, except where the evidence explicitly points at the
shared Neon database.

| Symptom | Likely cause | Evidence to collect |
|---|---|---|
| Browser console shows a CORS error; network tab shows the request never got a response, or an OPTIONS preflight failed | The calling origin isn't in `ALLOWED_ORIGINS` for the target service, or the CSP `connect-src` doesn't list the target origin | The exact `Origin` the browser sent; the full CSP header/meta tag; **which service was targeted (Node for Topic Quiz, Spring for Interview Mode)**; whether the request is a simple GET or a preflighted one (custom header/non-GET) |
| First request after a quiet period hangs for 30–90+ seconds, then succeeds | Render container cold start (§4's observed range) | Time from request start to first byte; whether a RETRY without waiting fails identically (it will, if still cold) or succeeds after waiting; **which service was cold — this does not imply the other is also cold** |
| Request succeeds but takes 10–15s specifically on a database-touching endpoint, `/api/health` itself is fast | Neon compute wake (container already warm, database was not) | Compare `/api/health` latency (fast, no database access) against a real data-fetching endpoint's latency such as `GET /api/quizzes` (slow) at the same moment, **on the same service** — `/actuator/health/readiness` is not reliable evidence for Spring here (see §4) |
| Sustained 5xx/504s that do NOT resolve after a generous wait (several minutes), **on both services at once** | Points toward the shared Neon database rather than either individual service | Render service logs/dashboard status for both `interview-api` and `interview-api-spring`; the exact HTTP status and body of the failing response on each |
| Sustained 5xx/504s on only ONE service | A genuine outage or misconfiguration in that service specifically — not Neon, not the other backend | That service's Render logs/dashboard status; confirm the other service's equivalent feature still works normally |
| Spinner runs for exactly 45 seconds then shows "server is still waking up" with a Retry button | This is the frontend's own bounded timeout firing as designed, not a bug | Whether a subsequent click succeeds (backend was cold, now warm) or times out again identically (points to a real outage, not a cold start); which feature (Topic Quiz or Interview Mode) was being started |

**Expected frontend behavior, for calibrating whether what you're seeing is
normal**: one click starts exactly one logical request; the spinner stays
visible for the duration of that request (not a fixed short animation); if
no response arrives within 45 seconds, the spinner is replaced by a "server
is still waking up" message and a Retry button, and clicking Retry either
reuses the still-in-flight original request or starts exactly one fresh one,
never more.
