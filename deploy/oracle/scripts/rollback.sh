#!/usr/bin/env bash
# Roll the Spring container back to the image tag recorded by the LAST
# deploy.sh run (.deploy-state/previous-image-tag) and restart the stack.
# Non-destructive: does not remove the current image, does not touch Caddy
# state, does not touch Neon.
#
# This is a CONTAINER/IMAGE rollback only — it has nothing to do with, and
# does not replace, the actual production rollback path (pointing Angular's
# production Spring base URL back at Render), which is documented in
# docs/oracle-migration-runbook.md Stage F. This script matters only once
# Oracle itself is live and a bad Oracle-side deploy needs undoing without
# touching Render/Angular at all.
#
# Requires Docker socket access — run with `sudo` (the ubuntu user is
# deliberately not in the docker group; see docs/oracle-migration-runbook.md).
#
# Usage: sudo ./scripts/rollback.sh [env-file]   (default: .env)

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! docker info > /dev/null 2>&1; then
  echo "rollback: cannot reach the Docker daemon. Re-run with sudo:" >&2
  echo "  sudo ./scripts/rollback.sh" >&2
  exit 1
fi

ENV_FILE="${1:-.env}"
STATE_DIR=".deploy-state"
PREVIOUS_TAG_FILE="$STATE_DIR/previous-image-tag"

if [[ ! -f "$PREVIOUS_TAG_FILE" ]]; then
  echo "rollback: no previous image tag recorded ($PREVIOUS_TAG_FILE missing)." >&2
  echo "rollback: nothing to roll back to — has deploy.sh been run at least twice?" >&2
  exit 1
fi

previous_tag="$(cat "$PREVIOUS_TAG_FILE")"
if [[ -z "$previous_tag" ]]; then
  echo "rollback: $PREVIOUS_TAG_FILE is empty — refusing to proceed." >&2
  exit 1
fi

echo "rollback: previous image was: $previous_tag"

if ! docker image inspect "$previous_tag" > /dev/null 2>&1; then
  echo "rollback: $previous_tag is no longer present locally — cannot roll back to it." >&2
  echo "rollback: it may have been pruned; a fresh deploy.sh of the known-good source is the alternative." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
[[ -f "$ENV_FILE" ]] && source "$ENV_FILE"
set +a

current_name="quizbackend-spring:${SPRING_IMAGE_TAG:-latest}"
echo "rollback: retagging $previous_tag -> $current_name"
docker tag "$previous_tag" "$current_name"

echo "rollback: restarting the spring service on the restored image..."
docker compose --env-file "$ENV_FILE" up -d --no-build spring

echo "rollback: done. Run ./scripts/health-check.sh to verify."
