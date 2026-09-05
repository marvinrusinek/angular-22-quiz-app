# Hosting the Interview API

Interview Mode is backend-driven: the browser never receives the answer key, so
the app cannot run an interview without a reachable API. Until this is hosted,
Interview Mode fails closed on GitHub Pages with *"Interview Mode is not
configured for this environment"* — by design, not a bug. Topic Quizzes and
Weak Areas Practice are unaffected; they stay local.

There are **two** frontend values to set afterwards, and setting only one leaves
every request blocked with no visible error. Step 3 covers both.

---

## 1. Deploy the API

The image is host-agnostic (`backend/Dockerfile`) and stateless — sessions live
in Postgres, not on the container's disk, so no volume is required.

### Provision the database first (Neon free tier)

1. [neon.tech](https://neon.tech) → new project → region matching the API.
   Both are currently **AWS US East 2 (Ohio)**; if you move one, move the
   other. Every interview action issues several queries, and a cross-region
   hop adds a round trip to each.
2. Copy the **pooled** connection string — the host contains `-pooler`. Use
   that one, not the direct endpoint: a free service that idles down and wakes
   repeatedly opens connections faster than the direct endpoint's limit
   comfortably allows.
3. Keep the string somewhere private. It carries credentials and must never be
   committed or baked into an image layer.

The schema is created automatically. Migrations run at startup, inside a
transaction each, and are idempotent — a second boot applies nothing.

The QUIZ BANK is not. The server fails closed — it refuses to start — if the
`quizzes` table is empty, so a freshly migrated database still needs one
explicit import before the API can serve anything:

```
npm run import:quiz-bank -- --file <path-to-your-quiz-bank.json> --database-url <the-pooled-connection-string>
```

Run this once per database (a fresh Neon project, a new environment), from a
machine that has the private bank file — never from inside the deployed
container, and never automatically as part of a deploy.

### Render (blueprint included)

1. Push this branch to GitHub.
2. Render dashboard → **New → Blueprint** → pick the repo. It reads
   `render.yaml` and creates the service.
3. Render prompts for `DATABASE_URL` (the blueprint marks it `sync: false` so
   the value stays out of the committed file). Paste the pooled Neon string.
4. Deploy, then confirm:
   ```
   curl https://<your-service>.onrender.com/api/health
   → {"status":"ok","uptimeSeconds":…}
   ```

If `DATABASE_URL` is missing or is not a `postgres://` string, the server
refuses to start and says so in the deploy log. That is deliberate: a server
that boots without a database would accept interviews it cannot store.

### Fly.io / Railway

Same image, same environment variables:

```
NODE_ENV=production
ALLOWED_ORIGINS=https://marvinrusinek.github.io
DATABASE_URL=postgres://…-pooler…/neondb?sslmode=require
```

Let the platform inject `PORT`. On Fly:
`fly launch --dockerfile backend/Dockerfile`, then
`fly secrets set DATABASE_URL=…`. No volume needed.

### What the free tier still costs

Sessions are now durable — a submitted interview stays readable across
restarts and redeploys. Two limits remain:

- **Cold starts.** Render spins a free service down after ~15 minutes idle, and
  a free Postgres may need to wake too. The first request afterwards takes
  roughly 30-60 seconds; starting an interview can feel slow, or time out into
  the retry state. Clicking Start again works once things are warm.
- **An interview in progress is safe.** Answering sends traffic, and a service
  with traffic does not idle out. Assessments run 15 minutes anyway.

**A review is still lost when the browser TAB closes**, and this is the part
most easily mistaken for a hosting problem. The session reference (id + token)
lives in `sessionStorage`, which is per-tab, and the server will not release
review data without that token. Reloading a tab resumes fine; a NEW tab cannot
see the interview, though the original tab can still finish it. Durable storage
fixed the server half of this. The credential half is deliberate — keeping the
token out of `localStorage` is what stops it outliving the tab.

The score is unaffected either way: Interview History is client-side and
already sanitized, so the attempt, percentage and per-topic breakdown survive
regardless.

---

## 2. Environment variables

| Variable | Value | Why |
|---|---|---|
| `NODE_ENV` | `production` | Enables the strict origin checks below. |
| `ALLOWED_ORIGINS` | `https://marvinrusinek.github.io` | EXACT origins, comma-separated. A wildcard is rejected outright, and production requires https — the server refuses to start otherwise rather than starting insecure. |
| `DATABASE_URL` | Neon **pooled** connection string | Required in production; the server refuses to start without it. Never commit it. |
| `PORT` | injected by the host | Do not hard-code. |

Add your dev origin (`http://localhost:4200`) only if you want a local frontend
to talk to the hosted API. It is not needed for the deployed site.

---

## 3. Point the frontend at it — BOTH of these

Once you have the API URL, set it in **two** places. Missing either one leaves
Interview Mode broken, and the CSP failure is silent — the browser blocks the
request before it is sent, so there is nothing in the network tab and no error
in the app.

**a. `src/app/shared/tokens/api-base-url.token.ts`**

```ts
export const PROD_API_BASE_URL = 'https://<your-service>.onrender.com/api';
```

Note the `/api` suffix — every route is mounted under it.

**b. `src/index.html`** — add the origin (scheme + host only, no path) to
`connect-src`:

```
connect-src 'self' https://cdn.jsdelivr.net
            http://localhost:3000 http://127.0.0.1:3000
            https://<your-service>.onrender.com;
```

Then rebuild and redeploy the frontend.

---

## 4. Verify

```
# API reachable and healthy
curl https://<your-service>.onrender.com/api/health

# Metadata only — no options, no correct flags, no explanations
curl https://<your-service>.onrender.com/api/quizzes

# The quiz bank is NOT served as a file, from any path
curl -o /dev/null -w '%{http_code}\n' https://<your-service>.onrender.com/quiz.json
→ 404
```

Then on the live site: build an interview, answer, submit, refresh the Results
page. A refresh re-fetches the frozen result from the server — it is not
restored from browser storage, which is the whole point.

Watch for a CORS failure in the console on first use; it means
`ALLOWED_ORIGINS` does not exactly match the site origin (no trailing slash, no
path).
