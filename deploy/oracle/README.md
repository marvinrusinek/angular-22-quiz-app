# Oracle Cloud deployment package — Spring Interview service

**This directory is preparation only — nothing has been deployed yet.**
The Oracle VM itself already exists and is network-reachable (see
`docs/oracle-migration-runbook.md`'s provisioned-VM facts: hostname
`interview-api-spring-oracle`, Ubuntu 24.04 ARM64, live DNS at
`interview-api-spring.marvinrusinek.com`), but **the Spring/Caddy stack
has not been deployed to it, and Angular production still points at
Render**. Read `docs/oracle-migration-runbook.md` first — it has the full
audit, ARM64 verification evidence, security posture, and the exact
staged sequence this package supports.

## Contents

- `compose.yaml` — Spring (built from `../../backend-spring`, unmodified)
  + a Caddy reverse proxy. No PostgreSQL service; connects to the same
  Neon database the existing Render deployment already uses.
- `Caddyfile` — automatic HTTPS for `interview-api-spring.marvinrusinek.com`,
  blocks `/actuator/*` publicly, adds only the security headers Spring
  does not already set itself.
- `.env.example` — copy to `.env` (gitignored) and fill in real values.
  Names and placeholders only; no real credentials belong in this repo.
- `.gitattributes` — forces LF line endings for `scripts/*.sh` regardless
  of the committer's own `core.autocrlf` setting (a CRLF shebang breaks a
  script on Linux).
- `scripts/` — `preflight.sh` (validates required variable names are set,
  never prints values), `deploy.sh` (builds + starts, tags the image with
  an immutable git short-SHA by default), `health-check.sh`,
  `rollback.sh` (container/image-level rollback only — see the runbook's
  Stage F for the actual production rollback path, which is a frontend
  change, not anything in this directory).

## Docker requires `sudo`

The `ubuntu` user on the Oracle VM is **deliberately not** added to the
`docker` group (broader host-level privilege than this deployment needs —
see the runbook's security posture). Every script that talks to Docker
(`deploy.sh`, `health-check.sh`, `rollback.sh` — not `preflight.sh`,
which never touches Docker) checks for daemon access up front and fails
with a clear message telling you to re-run with `sudo` if it can't reach
it. Run all three with `sudo`:

```bash
sudo ./scripts/deploy.sh
sudo ./scripts/health-check.sh
sudo ./scripts/rollback.sh
```

## Before committing this package: executable bits

This repository has `core.filemode=false` (common on a Windows checkout),
which means a local `chmod +x` has **no effect on what Git records** —
verified: `git add` + `git ls-files -s` shows `100644` (non-executable)
for these scripts despite correct filesystem permissions. Whoever
actually stages this package for commit must run, immediately before
committing:

```bash
git add deploy/oracle/scripts/*.sh
git update-index --chmod=+x deploy/oracle/scripts/*.sh
```

This does not persist across an `add`/`reset` cycle — it must be the last
step before the commit itself.

## Quick reference (once the stack is actually deployed to the VM)

```bash
cp .env.example .env
# edit .env with real values (SPRING_API_DOMAIN is already the real
# hostname in .env.example; the rest need real Neon/receipt-secret values)
sudo ./scripts/preflight.sh   # preflight itself never needs sudo — harmless either way
sudo ./scripts/deploy.sh
sudo ./scripts/health-check.sh
```

Rollback: `sudo ./scripts/rollback.sh` (restores the previous image tag).

**None of this has been run yet.** See `docs/oracle-migration-runbook.md`
Stage C for the exact next manual steps, and the required validation
before Angular ever points here.
