#!/usr/bin/env bash
# Pack web + marketing Worker deploy artifacts for production (spec §22.7).
set -euo pipefail

OUT="${1:?Usage: pack-production-worker-artifacts.sh <output.tar.gz>}"

sed 's/slugbase-staging-web/slugbase-production-web/g' packages/web/wrangler.jsonc \
  > packages/web/wrangler.production.jsonc
sed 's/slugbase-staging-marketing/slugbase-production-marketing/g' packages/marketing/wrangler.jsonc \
  > packages/marketing/wrangler.production.jsonc

tar -czf "${OUT}" \
  packages/web/build \
  packages/web/wrangler.production.jsonc \
  packages/web/workers \
  packages/marketing/dist \
  packages/marketing/wrangler.production.jsonc
