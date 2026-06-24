#!/usr/bin/env bash
# Build and deploy SlugBase Fly.io services (spec §22.5, admin PRD §6.1).
# FLY_API_TOKEN and FLY_APP must be set — never log token values.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

SERVICE="${1:-api}"
FLY_APP="${FLY_APP:-}"

case "$SERVICE" in
  api)
    FLY_CONFIG="${ROOT}/fly.toml"
    DEPLOY_DIR="${ROOT}"
    ;;
  admin)
    FLY_CONFIG="${ROOT}/packages/admin/fly.toml"
    DEPLOY_DIR="${ROOT}"
    ;;
  *)
    echo "deploy-fly: unsupported service: ${SERVICE} (expected api or admin)" >&2
    exit 1
    ;;
esac

if [[ -z "$FLY_APP" ]]; then
  echo "deploy-fly: FLY_APP must be set" >&2
  exit 1
fi

if [[ -z "${FLY_API_TOKEN:-}" ]]; then
  echo "deploy-fly: FLY_API_TOKEN must be set" >&2
  exit 1
fi

if [[ ! -f "$FLY_CONFIG" ]]; then
  echo "deploy-fly: missing Fly config: ${FLY_CONFIG}" >&2
  exit 1
fi

deploy_config="$(mktemp "${ROOT}/.fly-deploy.XXXXXX.toml")"
sed "s/^app = .*/app = \"${FLY_APP}\"/" "$FLY_CONFIG" >"$deploy_config"
trap 'rm -f "$deploy_config"' EXIT

wait_timeout="${FLY_DEPLOY_WAIT_TIMEOUT:-20m}"

echo "deploy-fly: deploying ${SERVICE} to ${FLY_APP}"
(
  cd "$DEPLOY_DIR"
  flyctl deploy \
    --app "$FLY_APP" \
    --config "$deploy_config" \
    --remote-only \
    --wait-timeout "${wait_timeout}" \
    --yes
)

echo "deploy-fly: ${FLY_APP} deployed"
