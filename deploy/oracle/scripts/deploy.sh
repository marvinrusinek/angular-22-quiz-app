#!/usr/bin/env bash
# Build and (re)deploy the Spring + Caddy stack on the Oracle VM.
#
# Records the currently-running image's tag BEFORE deploying, so
# rollback.sh has something concrete to restore — this is the one step
# that makes rollback possible without a human remembering the previous
# tag by hand.
#
# Requires Docker socket access. The `ubuntu` user is DELIBERATELY not
# added to the `docker` group (see docs/oracle-migration-runbook.md's
# security posture) — run this with `sudo`:
#   sudo ./scripts/deploy.sh
#
# Usage: sudo ./scripts/deploy.sh [env-file]   (default: .env)

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Fail clearly, not with a raw "permission denied" from the Docker socket,
# if this wasn't run with enough privilege to reach the Docker daemon.
if ! docker info > /dev/null 2>&1; then
  echo "deploy: cannot reach the Docker daemon. Re-run with sudo:" >&2
  echo "  sudo ./scripts/deploy.sh" >&2
  echo "(the ubuntu user is deliberately not in the docker group — see the runbook)" >&2
  exit 1
fi

ENV_FILE="${1:-.env}"

./scripts/preflight.sh "$ENV_FILE"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# Immutable tag by default: an explicit SPRING_IMAGE_TAG in .env always
# wins, but if it's unset, derive one from the CURRENT git commit rather
# than falling back to a floating tag like "latest" — every deploy is
# then traceable to an exact commit, and rollback.sh always has a
# concrete, unambiguous previous tag to restore (never "whatever `latest`
# happened to mean at the time"). Falls back to a timestamp only in the
# (should-not-happen-on-the-VM) case this isn't a git checkout at all.
if [[ -z "${SPRING_IMAGE_TAG:-}" ]]; then
  SPRING_IMAGE_TAG="$(git -C ../.. rev-parse --short=12 HEAD 2>/dev/null || date +%Y%m%d%H%M%S)"
  export SPRING_IMAGE_TAG
  echo "deploy: SPRING_IMAGE_TAG not set — derived immutable tag from git: $SPRING_IMAGE_TAG"
fi

STATE_DIR=".deploy-state"
mkdir -p "$STATE_DIR"
PREVIOUS_TAG_FILE="$STATE_DIR/previous-image-tag"

# Record whatever tag is running right now (if any) as "previous", before
# building/starting the new one — this is what rollback.sh reads.
current_tag="$(docker inspect --format '{{index .Config.Image}}' \
  "$(docker compose --env-file "$ENV_FILE" ps -q spring 2>/dev/null || true)" 2>/dev/null || true)"
if [[ -n "$current_tag" ]]; then
  echo "$current_tag" > "$PREVIOUS_TAG_FILE"
  echo "deploy: recorded currently-running image as previous ($current_tag) in $PREVIOUS_TAG_FILE"
else
  echo "deploy: no currently-running spring container found — nothing recorded as previous (first deploy?)"
fi

echo "deploy: building ${SPRING_IMAGE_TAG:-latest}..."
docker compose --env-file "$ENV_FILE" build spring

echo "deploy: starting/updating the stack..."
docker compose --env-file "$ENV_FILE" up -d

echo "deploy: done. Run ./scripts/health-check.sh to verify."
