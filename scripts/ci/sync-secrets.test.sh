#!/usr/bin/env bash
# Verifies SENTRY_DSN_API → SENTRY_DSN mapping at the sync boundary.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=github-secret-map.sh
source "${SCRIPT_DIR}/github-secret-map.sh"

append_fly_secret() {
  local -n _pairs="$1"
  local key="$2"
  local value="${!key-}"

  if [[ -n "$value" ]]; then
    _pairs+=("${key}=${value}")
  fi
}

export SENTRY_DSN_API="https://example.ingest.sentry.io/123"
unset SENTRY_DSN

map_sentry_storage_to_runtime api

if [[ "${SENTRY_DSN:-}" != "https://example.ingest.sentry.io/123" ]]; then
  echo "sync-secrets.test: expected SENTRY_DSN from SENTRY_DSN_API, got ${SENTRY_DSN:-<unset>}" >&2
  exit 1
fi

pairs=()
append_fly_secret pairs SENTRY_DSN

if [[ ${#pairs[@]} -ne 1 || "${pairs[0]}" != "SENTRY_DSN=https://example.ingest.sentry.io/123" ]]; then
  echo "sync-secrets.test: expected staged Fly pair SENTRY_DSN=…, got ${pairs[*]:-<none>}" >&2
  exit 1
fi

echo "sync-secrets.test: PASS"
