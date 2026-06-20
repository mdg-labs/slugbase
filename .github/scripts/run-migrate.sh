#!/usr/bin/env bash
# Pre-deploy Drizzle migrations — uses DATABASE_URL from GHA environment secrets (spec §22).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "run-migrate: DATABASE_URL must be set" >&2
  exit 1
fi

echo "run-migrate: applying Drizzle migrations"
pnpm --filter @slugbase/backend exec drizzle-kit migrate

echo "run-migrate: done"
