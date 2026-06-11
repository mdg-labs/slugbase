#!/usr/bin/env bash
# Pack web + marketing Worker deploy artifacts for production (spec §22.7).
set -euo pipefail

OUT="${1:?Usage: pack-production-worker-artifacts.sh <output.tar.gz>}"

sed \
  -e 's/slugbase-staging-web/slugbase-production-web/g' \
  -e 's/staging-cloud\.slugbase\.app/cloud.slugbase.app/g' \
  packages/web/build/server/wrangler.json \
  > packages/web/build/server/wrangler.deploy.json
sed \
  -e 's/slugbase-staging-marketing/slugbase-production-marketing/g' \
  -e 's/staging\.slugbase\.app/slugbase.app/g' \
  packages/marketing/wrangler.jsonc \
  > packages/marketing/wrangler.production.jsonc

tar -czf "${OUT}" \
  --exclude='*.js.map' \
  --exclude='*.css.map' \
  packages/web/build \
  packages/marketing/dist \
  packages/marketing/wrangler.production.jsonc
