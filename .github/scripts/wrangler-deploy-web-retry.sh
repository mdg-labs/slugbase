#!/usr/bin/env bash
# Deploy prebuilt React Router SSR worker to Cloudflare (spec §22.5).
# Requires `react-router build` output at build/server/wrangler.json — do not deploy
# from wrangler.jsonc (that entrypoint is dev-only and imports virtual:react-router/*).
set -euo pipefail

package_dir="${1:?Usage: wrangler-deploy-web-retry.sh <package-dir>}"
config="${2:-build/server/wrangler.json}"

cd "${package_dir}"

if [[ ! -f "${config}" ]]; then
  echo "Missing ${config}. Run react-router build before deploying the web worker." >&2
  exit 1
fi

for attempt in 1 2 3; do
  if pnpm exec wrangler deploy --config "${config}"; then
    exit 0
  fi
  if [[ "${attempt}" -eq 3 ]]; then
    exit 1
  fi
  sleep_seconds=$((attempt * 10))
  echo "Web worker deploy failed (attempt ${attempt}). Retrying in ${sleep_seconds}s..."
  sleep "${sleep_seconds}"
done
