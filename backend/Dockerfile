# Interview API — private quiz backend.
#
# This image holds the ANSWER KEY. It is never served as a static file and the
# quiz bank never reaches the browser: routes return metadata, active questions
# without correctness, and full review only after submission.
#
# Multi-stage so the runtime image carries no compiler, no dev dependencies and
# no TypeScript sources.
#
# PORTED FROM SQLITE. `pg` is pure JavaScript, so the native toolchain
# (python3/make/g++) that better-sqlite3 needed is gone, and the two stages no
# longer have to share a base image to keep a compiled binary loadable. Session
# state now lives in a managed Postgres reached over DATABASE_URL rather than on
# the container's disk, which is what makes a submitted interview readable after
# a redeploy.

# ── build ───────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Dependencies first: this layer is cached until the manifests change, so a
# source-only edit reuses the installed tree.
COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# Re-resolve to production dependencies only.
RUN npm ci --omit=dev

# ── runtime ─────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# The quiz bank is PostgreSQL-only at runtime (Stage 15) — there is no
# `data/quiz.json` in this image. Importing a bank into the database is an
# explicit, manually-run operator action (scripts/import-quiz-bank.ts),
# never something this container does for itself.

# DATABASE_URL is supplied by the environment and is REQUIRED in production —
# the config refuses to start without it. It is deliberately NOT defaulted here:
# a server that silently pointed at the wrong database would be worse than one
# that refuses to boot, and the URL carries credentials, which must never be
# baked into an image layer.

# Drop root. The process only needs to read /app and reach the network.
USER node

EXPOSE 3000

# The app exits non-zero on a misconfiguration before it ever listens, so a
# failing health check here means the process is genuinely unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/server.js"]
