#!/usr/bin/env bash
# Build and deploy web or marketing to Cloudflare Workers (spec §22.5).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "$ROOT"

APP="${1:-}"
DEPLOY_ENVIRONMENT="${DEPLOY_ENVIRONMENT:-}"

if [[ -z "$APP" || -z "$DEPLOY_ENVIRONMENT" ]]; then
  echo "deploy-cf-worker: usage: DEPLOY_ENVIRONMENT=<staging|production> deploy-cf-worker.sh <web|marketing>" >&2
  exit 1
fi

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "deploy-cf-worker: CLOUDFLARE_API_TOKEN must be set" >&2
  exit 1
fi

if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  echo "deploy-cf-worker: CLOUDFLARE_ACCOUNT_ID must be set" >&2
  exit 1
fi

case "$APP" in
  web)
    echo "deploy-cf-worker: building @slugbase/web dependencies"
    env NODE_ENV=production pnpm --filter @slugbase/web^... build

    WEB_BUILD_ENV=(
      NODE_ENV=production
      SLUGBASE_EDITION=cloud
      SENTRY_PROJECT=slugbase-web
      VITE_SENTRY_ENVIRONMENT="${DEPLOY_ENVIRONMENT}"
    )
    if [[ -n "${VITE_SENTRY_RELEASE:-}" ]]; then
      WEB_BUILD_ENV+=(VITE_SENTRY_RELEASE="${VITE_SENTRY_RELEASE}")
    fi
    if [[ -n "${VITE_API_BASE_URL:-}" ]]; then
      WEB_BUILD_ENV+=(VITE_API_BASE_URL="${VITE_API_BASE_URL}")
    fi
    if [[ -n "${API_BASE_URL:-}" ]]; then
      WEB_BUILD_ENV+=(API_BASE_URL="${API_BASE_URL}")
    fi

    echo "deploy-cf-worker: building @slugbase/web"
    env "${WEB_BUILD_ENV[@]}" pnpm --filter @slugbase/web build

    find packages/web/build -name '*.js.map' -delete
    echo "deploy-cf-worker: stripped .map files from web build"

    if [[ "$DEPLOY_ENVIRONMENT" == "production" ]]; then
      sed \
        -e 's/slugbase-staging-web/slugbase-production-web/g' \
        -e 's/staging-cloud\.slugbase\.app/cloud.slugbase.app/g' \
        packages/web/build/server/wrangler.json \
        > packages/web/build/server/wrangler.deploy.json
      WRANGLER_CONFIG="build/server/wrangler.deploy.json"
    else
      WRANGLER_CONFIG="build/server/wrangler.json"
    fi

    bash "${SCRIPT_DIR}/wrangler-deploy-web-retry.sh" packages/web "${WRANGLER_CONFIG}"
    ;;

  marketing)
    echo "deploy-cf-worker: building @slugbase/marketing dependencies"
    env NODE_ENV=production pnpm --filter @slugbase/marketing^... build

    echo "deploy-cf-worker: building @slugbase/marketing"
    env NODE_ENV=production pnpm --filter @slugbase/marketing build

    if [[ "$DEPLOY_ENVIRONMENT" == "production" ]]; then
      if [[ -f packages/marketing/wrangler.production.jsonc ]]; then
        WRANGLER_ARGS=(--config wrangler.production.jsonc)
      else
        sed \
          -e 's/slugbase-staging-marketing/slugbase-production-marketing/g' \
          -e 's/staging\.slugbase\.app/slugbase.app/g' \
          packages/marketing/wrangler.jsonc \
          > packages/marketing/wrangler.production.jsonc
        WRANGLER_ARGS=(--config wrangler.production.jsonc)
      fi
    else
      WRANGLER_ARGS=(--config wrangler.jsonc)
    fi

    bash "${SCRIPT_DIR}/wrangler-deploy-retry.sh" packages/marketing "${WRANGLER_ARGS[@]}"
    ;;

  *)
    echo "deploy-cf-worker: unsupported app: ${APP}" >&2
    exit 1
    ;;
esac

echo "deploy-cf-worker: ${APP} (${DEPLOY_ENVIRONMENT}) deployed"
