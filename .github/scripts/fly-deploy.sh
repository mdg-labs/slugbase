#!/usr/bin/env bash
# Deploy API to Fly.io using Infisical-injected credentials (spec §22.5).
# FLY_API_TOKEN and FLY_ORG must already be in the runner environment — never pass
# them via workflow expressions (${{ env.* }}) or log their values.
set -euo pipefail

app="${1:?Usage: fly-deploy.sh <fly-app-name>}"

if [[ -z "${FLY_API_TOKEN:-}" ]]; then
  echo "FLY_API_TOKEN is not set. Add it to Infisical for this environment." >&2
  exit 1
fi

if [[ -z "${FLY_ORG:-}" ]]; then
  echo "FLY_ORG is not set. Add it to Infisical for this environment." >&2
  exit 1
fi

wait_timeout="${FLY_DEPLOY_WAIT_TIMEOUT:-20m}"

flyctl deploy \
  --app "${app}" \
  --org "${FLY_ORG}" \
  --config fly.toml \
  --remote-only \
  --wait-timeout "${wait_timeout}"
