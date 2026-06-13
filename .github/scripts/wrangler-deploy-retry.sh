#!/usr/bin/env bash
# Deploy to Cloudflare Workers with exponential backoff (spec §22.5).
set -euo pipefail

WORKDIR="${1:?Usage: wrangler-deploy-retry.sh <package-dir>}"
shift

cd "${WORKDIR}"

for attempt in 1 2 3; do
  if pnpm exec wrangler deploy "$@"; then
    exit 0
  fi
  if [[ "${attempt}" -eq 3 ]]; then
    exit 1
  fi
  sleep_seconds=$((attempt * 10))
  echo "Wrangler deploy failed (attempt ${attempt}). Retrying in ${sleep_seconds}s..."
  sleep "${sleep_seconds}"
done
