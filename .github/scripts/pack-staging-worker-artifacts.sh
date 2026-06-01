#!/usr/bin/env bash
# Pack web + marketing Worker deploy artifacts after staging build (spec §22.5).
set -euo pipefail

OUT="${1:?Usage: pack-staging-worker-artifacts.sh <output.tar.gz>}"

tar -czf "${OUT}" \
  packages/web/build \
  packages/web/wrangler.jsonc \
  packages/web/workers \
  packages/marketing/dist \
  packages/marketing/wrangler.jsonc
