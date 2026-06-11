#!/usr/bin/env bash
# Pack web + marketing Worker deploy artifacts after staging build (spec §22.5).
set -euo pipefail

OUT="${1:?Usage: pack-staging-worker-artifacts.sh <output.tar.gz>}"

tar -czf "${OUT}" \
  --exclude='*.js.map' \
  --exclude='*.css.map' \
  packages/web/build \
  packages/marketing/dist \
  packages/marketing/wrangler.jsonc
