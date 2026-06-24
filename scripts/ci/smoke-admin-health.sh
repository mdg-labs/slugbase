#!/usr/bin/env bash
# Smoke-test admin portal deploy (admin PRD §12.5, granular-deployment WP-3):
#   GET ${ADMIN_URL}/health and /version (HTTP 200)
# Invoked directly from deploy.yml or via smoke-staging-health.sh --admin.
# When CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET are set, sends Cloudflare Access headers.
set -euo pipefail

: "${ADMIN_URL:?ADMIN_URL is required}"

MAX_ATTEMPTS="${SMOKE_MAX_ATTEMPTS:-30}"
SLEEP_SECONDS="${SMOKE_SLEEP_SECONDS:-10}"

CURL_ACCESS_ARGS=()
if [[ -n "${CF_ACCESS_CLIENT_ID:-}" && -n "${CF_ACCESS_CLIENT_SECRET:-}" ]]; then
  CURL_ACCESS_ARGS=(
    -H "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID}"
    -H "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET}"
  )
  echo "Smoke admin: using Cloudflare Access service token headers"
fi

smoke_curl() {
  curl "${CURL_ACCESS_ARGS[@]}" "$@"
}

health_url="${ADMIN_URL%/}/health"
version_url="${ADMIN_URL%/}/version"

echo "Smoke admin: ${ADMIN_URL}"

attempt=1
while [[ "${attempt}" -le "${MAX_ATTEMPTS}" ]]; do
  if smoke_curl -fsS "${health_url}" >/dev/null 2>&1; then
    break
  fi
  if [[ "${attempt}" -eq "${MAX_ATTEMPTS}" ]]; then
    echo "Timed out waiting for ${health_url}" >&2
    exit 1
  fi
  echo "  waiting for ${health_url} (attempt ${attempt}/${MAX_ATTEMPTS})..."
  sleep "${SLEEP_SECONDS}"
  attempt=$((attempt + 1))
done

health_status="$(smoke_curl -s -o /tmp/slugbase-smoke-admin-health.json -w '%{http_code}' "${health_url}")"
version_status="$(smoke_curl -s -o /tmp/slugbase-smoke-admin-version.json -w '%{http_code}' "${version_url}")"

echo "  GET /health -> HTTP ${health_status}"
cat /tmp/slugbase-smoke-admin-health.json
echo ""
echo "  GET /version -> HTTP ${version_status}"
cat /tmp/slugbase-smoke-admin-version.json
echo ""

if [[ "${health_status}" != "200" || "${version_status}" != "200" ]]; then
  echo "Smoke failed for admin portal" >&2
  exit 1
fi

echo "Admin smoke passed"
