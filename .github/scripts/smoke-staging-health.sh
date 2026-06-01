#!/usr/bin/env bash
# Smoke-test staging deploys: GET /health and /version on API, web, and marketing (spec §22.5).
# When CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET are set (Infisical staging), sends
# Cloudflare Access service-token headers on every request (staging Workers sit behind Access).
set -euo pipefail

: "${APP_BASE_URL:?APP_BASE_URL is required}"
: "${FRONTEND_ORIGIN:?FRONTEND_ORIGIN is required}"
: "${MARKETING_ORIGIN:?MARKETING_ORIGIN is required}"

MAX_ATTEMPTS="${SMOKE_MAX_ATTEMPTS:-30}"
SLEEP_SECONDS="${SMOKE_SLEEP_SECONDS:-10}"

CURL_ACCESS_ARGS=()
if [[ -n "${CF_ACCESS_CLIENT_ID:-}" && -n "${CF_ACCESS_CLIENT_SECRET:-}" ]]; then
  CURL_ACCESS_ARGS=(
    -H "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID}"
    -H "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET}"
  )
  echo "Smoke: using Cloudflare Access service token headers"
fi

smoke_curl() {
  curl "${CURL_ACCESS_ARGS[@]}" "$@"
}

check_surface() {
  local name="$1"
  local base="$2"
  local health_url="${base%/}/health"
  local version_url="${base%/}/version"

  echo "Smoke: ${name} (${base})"

  local attempt=1
  while [[ "${attempt}" -le "${MAX_ATTEMPTS}" ]]; do
    if smoke_curl -fsS "${health_url}" >/dev/null 2>&1; then
      break
    fi
    if [[ "${attempt}" -eq "${MAX_ATTEMPTS}" ]]; then
      echo "Timed out waiting for ${health_url}" >&2
      return 1
    fi
    echo "  waiting for ${health_url} (attempt ${attempt}/${MAX_ATTEMPTS})..."
    sleep "${SLEEP_SECONDS}"
    attempt=$((attempt + 1))
  done

  local health_status version_status
  health_status="$(smoke_curl -s -o /tmp/slugbase-smoke-health.json -w '%{http_code}' "${health_url}")"
  version_status="$(smoke_curl -s -o /tmp/slugbase-smoke-version.json -w '%{http_code}' "${version_url}")"

  echo "  GET /health -> HTTP ${health_status}"
  cat /tmp/slugbase-smoke-health.json
  echo ""
  echo "  GET /version -> HTTP ${version_status}"
  cat /tmp/slugbase-smoke-version.json
  echo ""

  if [[ "${health_status}" != "200" || "${version_status}" != "200" ]]; then
    echo "Smoke failed for ${name}" >&2
    return 1
  fi
}

check_surface "API" "${APP_BASE_URL}"
check_surface "Web" "${FRONTEND_ORIGIN}"
check_surface "Marketing" "${MARKETING_ORIGIN}"

echo "Staging smoke passed"
