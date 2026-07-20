#!/usr/bin/env bash
# Cloud pre-deploy migrations — Pangolin tunnel + Drizzle (product and/or admin).
#
# Requires (repo secrets): PANGOLIN_MACHINE_ID, PANGOLIN_MACHINE_SECRET, PANGOLIN_ENDPOINT
# Requires (GHA environment): DATABASE_URL; DATABASE_URL_UNPOOLED optional for admin migrate
# Requires (plan outputs): RUN_MIGRATE and/or RUN_MIGRATE_ADMIN set to "true"
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

: "${PANGOLIN_MACHINE_ID:?PANGOLIN_MACHINE_ID is required}"
: "${PANGOLIN_MACHINE_SECRET:?PANGOLIN_MACHINE_SECRET is required}"
: "${PANGOLIN_ENDPOINT:?PANGOLIN_ENDPOINT is required}"
: "${DATABASE_URL:?DATABASE_URL is required}"

run_migrate="${RUN_MIGRATE:-false}"
run_migrate_admin="${RUN_MIGRATE_ADMIN:-false}"

if [[ "$run_migrate" != "true" && "$run_migrate_admin" != "true" ]]; then
  echo "run-cloud-migrate: nothing to do (RUN_MIGRATE and RUN_MIGRATE_ADMIN are both false)" >&2
  exit 0
fi

export ROOT
export RUN_MIGRATE="$run_migrate"
export RUN_MIGRATE_ADMIN="$run_migrate_admin"

bash scripts/ci/with-pangolin-tunnel.sh bash -c '
  set -euo pipefail
  cd "$ROOT"

  if [[ "${RUN_MIGRATE}" == "true" ]]; then
    echo "run-cloud-migrate: applying product migrations"
    bash scripts/ci/run-migrate.sh
  fi

  if [[ "${RUN_MIGRATE_ADMIN}" == "true" ]]; then
    echo "run-cloud-migrate: applying admin migrations"
    bash scripts/ci/run-migrate-admin.sh
  fi
'

echo "run-cloud-migrate: done"
