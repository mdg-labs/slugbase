#!/usr/bin/env bash
# Smoke-test deploy surfaces (spec §22.5, granular-deployment WP-3):
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

DO_API=false
DO_WEB=false
DO_MARKETING=false
DO_ADMIN=false

usage() {
  echo "Usage: $0 [--api] [--web] [--marketing] [--admin]" >&2
  echo "  With no flags, runs api, web, and marketing checks." >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api) DO_API=true ;;
    --web) DO_WEB=true ;;
    --marketing) DO_MARKETING=true ;;
    --admin) DO_ADMIN=true ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
  shift
done

if ! $DO_API && ! $DO_WEB && ! $DO_MARKETING && ! $DO_ADMIN; then
  DO_API=true
  DO_WEB=true
  DO_MARKETING=true
fi

if $DO_API; then
  : "${APP_BASE_URL:?APP_BASE_URL is required for --api}"
fi
if $DO_WEB; then
  : "${FRONTEND_ORIGIN:?FRONTEND_ORIGIN is required for --web}"
fi
if $DO_MARKETING; then
  : "${MARKETING_ORIGIN:?MARKETING_ORIGIN is required for --marketing}"
fi

MAX_ATTEMPTS="${SMOKE_MAX_ATTEMPTS:-30}"
SLEEP_SECONDS="${SMOKE_SLEEP_SECONDS:-10}"

check_surface() {
  local name="$1"
  local base="$2"
  local health_url="${base%/}/health"
  local version_url="${base%/}/version"

  echo "Smoke: ${name} (${base})"

  local attempt=1
  while [[ "${attempt}" -le "${MAX_ATTEMPTS}" ]]; do
    if curl -fsS "${health_url}" >/dev/null 2>&1; then
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
  health_status="$(curl -s -o /tmp/slugbase-smoke-health.json -w '%{http_code}' "${health_url}")"
  version_status="$(curl -s -o /tmp/slugbase-smoke-version.json -w '%{http_code}' "${version_url}")"

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

check_pricing_api() {
  local api_base="$1"
  local marketing_origin="$2"
  local pricing_url="${api_base%/}/pricing/public"

  echo "Smoke: API (${api_base}) — live Stripe-backed public pricing"

  local pricing_json
  pricing_json="$(curl -fsS "${pricing_url}")"

  echo "  GET /pricing/public -> OK"
  printf '%s\n' "${pricing_json}" | head -c 200
  echo ""

  if ! printf '%s' "${pricing_json}" | grep -Eq '"display"[[:space:]]*:[[:space:]]*"[^"]*[0-9€$£]'; then
    echo "Smoke failed: personal pricing display lacks currency or digits" >&2
    return 1
  fi

  echo "Smoke: API (${api_base}) — CORS for marketing origin"

  local acao
  acao="$(
    curl -s -D - -o /dev/null \
      -H "Origin: ${marketing_origin}" \
      "${pricing_url}" \
      | tr -d '\r' \
      | awk 'BEGIN{IGNORECASE=1} /^access-control-allow-origin:/ {sub(/^[^:]+:[[:space:]]*/, ""); print; exit}'
  )"

  if [[ -z "${acao}" ]]; then
    echo "Smoke failed: missing Access-Control-Allow-Origin for Origin ${marketing_origin}" >&2
    return 1
  fi

  local marketing_lc origin_lc
  marketing_lc="$(printf '%s' "${marketing_origin}" | tr '[:upper:]' '[:lower:]')"
  origin_lc="$(printf '%s' "${acao}" | tr '[:upper:]' '[:lower:]')"
  if [[ "${origin_lc}" != "${marketing_lc}" ]]; then
    echo "Smoke failed: Access-Control-Allow-Origin '${acao}' does not match marketing origin" >&2
    return 1
  fi

  echo "  GET /pricing/public (Origin: ${marketing_origin}) -> Access-Control-Allow-Origin: ${acao}"
}

if $DO_API; then
  check_surface "API" "${APP_BASE_URL}"
fi

if $DO_WEB; then
  check_surface "Web" "${FRONTEND_ORIGIN}"
fi

if $DO_MARKETING; then
  check_surface "Marketing" "${MARKETING_ORIGIN}"
fi

if $DO_API && $DO_MARKETING; then
  check_pricing_api "${APP_BASE_URL}" "${MARKETING_ORIGIN}"
fi

if $DO_ADMIN; then
  echo "smoke-staging-health: admin smoke moved to slugbase-cloud" >&2
  exit 1
fi

echo "Staging smoke passed"
