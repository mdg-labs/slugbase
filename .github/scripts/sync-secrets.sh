#!/usr/bin/env bash
# Push GitHub Actions environment secrets to Fly.io API and Cloudflare Workers.
# Reads from process env (workflow maps secrets.* → env). No Phase CLI (spec §22.9).
#
# FLY_SECRETS_MODE (from workflow):
#   stage-only       — flyctl secrets set --stage; no deploy (workflow_call / deploy chain)
#   stage-and-deploy — flyctl secrets set --stage then flyctl secrets deploy (workflow_dispatch)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=github-secret-map.sh
source "${SCRIPT_DIR}/github-secret-map.sh"

usage() {
  cat <<'EOF'
Usage: sync-secrets.sh <staging|production> [services]

services: all (default) | api | web | marketing | comma-separated list

FLY_SECRETS_MODE env:
  stage-only       — stage Fly secrets only (default for deploy pipeline)
  stage-and-deploy — stage then deploy Fly secrets to running Machines
EOF
}

if [[ $# -lt 1 ]]; then
  usage >&2
  exit 1
fi

GHA_ENV="$1"
SERVICES="${2:-all}"
FLY_SECRETS_MODE="${FLY_SECRETS_MODE:-stage-only}"

if [[ "$FLY_SECRETS_MODE" != "stage-only" && "$FLY_SECRETS_MODE" != "stage-and-deploy" ]]; then
  echo "sync-secrets: invalid FLY_SECRETS_MODE: ${FLY_SECRETS_MODE} (expected stage-only or stage-and-deploy)" >&2
  exit 1
fi

case "$GHA_ENV" in
  staging | production) ;;
  *)
    echo "sync-secrets: unsupported GHA environment: ${GHA_ENV}" >&2
    exit 1
    ;;
esac

service_selected() {
  local name="$1"
  [[ "$SERVICES" == "all" ]] && return 0
  [[ ",$SERVICES," == *",$name,"* ]]
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "sync-secrets: missing required command: $1" >&2
    exit 1
  fi
}

append_fly_secret() {
  local -n _pairs="$1"
  local key="$2"
  local value="${!key-}"

  if [[ -n "$value" ]]; then
    _pairs+=("${key}=${value}")
  fi
}

sync_fly_secrets() {
  local app="$1"
  shift
  local -a keys=("$@")
  local -a pairs=()

  for key in "${keys[@]}"; do
    append_fly_secret pairs "$key"
  done

  if [[ ${#pairs[@]} -eq 0 ]]; then
    echo "sync-secrets: no Fly secrets to set for ${app}"
    return 0
  fi

  echo "sync-secrets: staging ${#pairs[@]} secrets on Fly app ${app}"
  flyctl secrets set "${pairs[@]}" --app "$app" --stage

  if [[ "$FLY_SECRETS_MODE" == "stage-and-deploy" ]]; then
    echo "sync-secrets: deploying staged secrets to Fly app ${app}"
    flyctl secrets deploy --app "$app"
  fi
}

sync_wrangler_secret() {
  local worker="$1"
  local key="$2"
  local value="${!key-}"

  if [[ -z "$value" ]]; then
    return 0
  fi

  echo "sync-secrets: syncing ${key} to Cloudflare Worker ${worker}"
  printf '%s' "$value" | wrangler secret put "$key" --name "$worker"
}

require_cmd flyctl
require_cmd wrangler

if [[ -z "${FLY_API_TOKEN:-}" ]]; then
  echo "sync-secrets: FLY_API_TOKEN must be set" >&2
  exit 1
fi

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "sync-secrets: CLOUDFLARE_API_TOKEN must be set" >&2
  exit 1
fi

if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  echo "sync-secrets: CLOUDFLARE_ACCOUNT_ID must be set" >&2
  exit 1
fi

export CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN}"
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID}"

# Required GHA storage keys per service — must match scripts/sync-secrets-manifest.ts
# (validated by scripts/validate-sync-secrets-manifest.ts in CI).
preflight_required_gha_keys() {
  local service="$1"
  local -a keys=()
  local -a missing=()

  case "$service" in
    api)
      keys=(
        SESSION_SECRET
        ENCRYPTION_KEY
        DATABASE_URL
        APP_BASE_URL
        FRONTEND_ORIGIN
      )
      ;;
    web)
      keys=(API_BASE_URL)
      ;;
    marketing)
      keys=()
      ;;
    *)
      echo "sync-secrets: unknown service for preflight: ${service}" >&2
      exit 1
      ;;
  esac

  for key in "${keys[@]}"; do
    if [[ -z "${!key-}" ]]; then
      missing+=("$key")
    fi
  done

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "sync-secrets: missing required GHA secrets for ${service}: ${missing[*]}" >&2
    exit 1
  fi
}

run_service_preflight() {
  local service="$1"
  if service_selected "$service"; then
    preflight_required_gha_keys "$service"
  fi
}

API_APP="slugbase-${GHA_ENV}-api"
WEB_WORKER="slugbase-${GHA_ENV}-web"
MARKETING_WORKER="slugbase-${GHA_ENV}-marketing"

API_FLY_KEYS=(
  NODE_ENV
  SESSION_SECRET
  ENCRYPTION_KEY
  DATABASE_URL
  APP_BASE_URL
  FRONTEND_ORIGIN
  MARKETING_ORIGIN
  PUBLIC_REGISTRATION
  EMAIL_VERIFICATION_REQUIRED
  SMTP_HOST
  SMTP_PORT
  SMTP_SECURE
  SMTP_USER
  SMTP_PASS
  SMTP_FROM
  OPENAI_API_KEY
  OPENAI_MODEL
  STRIPE_SECRET_KEY
  STRIPE_WEBHOOK_SECRET
  STRIPE_PRICE_PERSONAL_MONTHLY
  STRIPE_PRICE_PERSONAL_ANNUAL
  STRIPE_PRICE_TEAM_MONTHLY
  STRIPE_PRICE_TEAM_ANNUAL
  STRIPE_PRICE_SUPPORTER
  SUPPORTER_PROMOTION_END
  DOWNGRADE_GRACE_PERIOD_DAYS
  SESSION_TTL_DAYS
  SESSION_REMEMBER_TTL_DAYS
  MFA_TOTP_ISSUER
  RATE_LIMIT_LOGIN_MAX
  RATE_LIMIT_LOGIN_TTL_SECONDS
  RATE_LIMIT_TOKEN_CREATION_MAX
  RATE_LIMIT_TOKEN_CREATION_TTL_SECONDS
  RATE_LIMIT_EMAIL_VERIFICATION_MAX
  RATE_LIMIT_EMAIL_VERIFICATION_TTL_SECONDS
  TURNSTILE_SECRET_KEY
  CHALLENGE_DEV_SKIP
  UMAMI_HOST
  UMAMI_WEBSITE_ID
  SENTRY_DSN
  SENTRY_ENVIRONMENT
  SENTRY_TRACES_SAMPLE_RATE
  SENTRY_PROFILING_SAMPLE_RATE
  SENTRY_REPLAY_SAMPLE_RATE
  SENTRY_LOG_LEVEL
  SENTRY_ENABLE_CONSOLE_LOGGING
  OIDC_DEPLOYMENT_PROVIDERS
)

WEB_WRANGLER_KEYS=(
  API_BASE_URL
)

MARKETING_WRANGLER_KEYS=()

echo "sync-secrets: Fly mode ${FLY_SECRETS_MODE}"

run_service_preflight api
run_service_preflight web
run_service_preflight marketing

if service_selected api; then
  map_sentry_storage_to_runtime api
  sync_fly_secrets "$API_APP" "${API_FLY_KEYS[@]}"
fi

if service_selected web; then
  for key in "${WEB_WRANGLER_KEYS[@]}"; do
    sync_wrangler_secret "$WEB_WORKER" "$key"
  done
fi

if service_selected marketing; then
  for key in "${MARKETING_WRANGLER_KEYS[@]}"; do
    sync_wrangler_secret "$MARKETING_WORKER" "$key"
  done
fi

echo "sync-secrets: complete (${GHA_ENV})"
