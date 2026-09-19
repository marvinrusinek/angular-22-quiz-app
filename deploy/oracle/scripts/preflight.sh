#!/usr/bin/env bash
# Preflight validation for the Oracle deployment — checks that every
# required variable NAME is set in the environment/.env file, without ever
# printing a VALUE. Run this before deploy.sh; deploy.sh also sources it,
# so this is the single place the required-variable list lives.
#
# Exit 0: every required variable is set (values not validated for
# correctness — only presence). Exit 1: something is missing, named in the
# error output.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

ENV_FILE="${1:-.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "preflight: $ENV_FILE not found. Copy .env.example to $ENV_FILE and fill in real values first." >&2
  exit 1
fi

# Load into THIS script's own environment only — never echoed, never
# written anywhere else. set -a exports every var sourced from the file so
# the presence checks below (and any subsequent `docker compose` command
# that sources this same file) see them without repeating the list twice.
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# These four are genuinely fail-closed inside Spring itself — an unset
# value means the container refuses to start (see
# backend-spring/src/main/resources/application.properties).
REQUIRED_VARS=(
  SPRING_API_DOMAIN
  SPRING_DATASOURCE_URL
  SPRING_DATASOURCE_USERNAME
  SPRING_DATASOURCE_PASSWORD
  TOPIC_QUIZ_RECEIPT_SECRET
)

missing=()
for var in "${REQUIRED_VARS[@]}"; do
  # Indirect expansion — checks PRESENCE only. Never echoes the value.
  if [[ -z "${!var:-}" ]]; then
    missing+=("$var")
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "preflight: missing required variable(s) in $ENV_FILE:" >&2
  for var in "${missing[@]}"; do
    echo "  - $var" >&2
  done
  exit 1
fi

echo "preflight: all ${#REQUIRED_VARS[@]} required variables are set in $ENV_FILE."

# ALLOWED_ORIGINS is OPTIONAL (Spring's own safe, restrictive default is an
# empty allow-list — see AllowedOrigins.java) and deliberately NOT in
# REQUIRED_VARS above: docs/oracle-migration-runbook.md's Stage C/D run
# with it empty or scoped to a throwaway test origin on purpose, before
# any real production frontend origin exists. This is presence-only
# informational output, never a failure, and never prints the value.
if [[ -z "${ALLOWED_ORIGINS:-}" ]]; then
  echo "preflight: NOTE — ALLOWED_ORIGINS is unset/empty. Fine for Stage C/D; must be set before Stage E's production cutover."
else
  echo "preflight: ALLOWED_ORIGINS is set (value not shown)."
fi
