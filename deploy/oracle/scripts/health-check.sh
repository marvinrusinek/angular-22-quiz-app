#!/usr/bin/env bash
# Post-deploy verification. Checks Spring's own health endpoint over the
# INTERNAL Docker network (bypassing Caddy — proves the app itself is up
# independent of TLS/proxy state) and, if a domain is configured, the
# public HTTPS path through Caddy as well.
#
# Never prints request/response bodies beyond status codes — this script
# is meant to be safe to run and share output from without redacting
# anything.
#
# Requires Docker socket access — run with `sudo` (the ubuntu user is
# deliberately not in the docker group; see docs/oracle-migration-runbook.md).
#
# Usage: sudo ./scripts/health-check.sh [env-file]   (default: .env)

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! docker info > /dev/null 2>&1; then
  echo "health-check: cannot reach the Docker daemon. Re-run with sudo:" >&2
  echo "  sudo ./scripts/health-check.sh" >&2
  exit 1
fi

ENV_FILE="${1:-.env}"
# shellcheck disable=SC1090
[[ -f "$ENV_FILE" ]] && { set -a; source "$ENV_FILE"; set +a; }

echo "health-check: container status —"
docker compose --env-file "$ENV_FILE" ps

echo
echo "health-check: Spring /api/health via the internal network —"
docker compose --env-file "$ENV_FILE" exec -T spring \
  bash -c 'exec 3<>/dev/tcp/127.0.0.1/8080; printf "GET /api/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n" >&3; timeout 5 cat <&3' \
  | head -1

if [[ -n "${SPRING_API_DOMAIN:-}" ]]; then
  echo
  echo "health-check: public HTTPS path (https://${SPRING_API_DOMAIN}/api/health) —"
  curl -s -o /dev/null -w "  HTTP %{http_code}\n" "https://${SPRING_API_DOMAIN}/api/health" || \
    echo "  (unreachable — check Caddy's own logs; DNS and OCI ingress are already live, so this should succeed once the stack is up)"

  echo
  echo "health-check: confirming Actuator is NOT publicly reachable —"
  curl -s -o /dev/null -w "  /actuator/health -> HTTP %{http_code} (expect 404)\n" \
    "https://${SPRING_API_DOMAIN}/actuator/health" || true
fi
