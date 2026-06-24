#!/usr/bin/env bash
# Pre-deploy admin Drizzle migrations — uses DATABASE_URL from GHA environment secrets (admin PRD §5.0).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "run-migrate-admin: DATABASE_URL must be set" >&2
  exit 1
fi

MIGRATE_URL="${DATABASE_URL_UNPOOLED:-$DATABASE_URL}"
export MIGRATE_URL

echo "run-migrate-admin: ensuring admin schema exists"
node --input-type=module -e "
import postgres from 'postgres';

const databaseUrl = process.env.MIGRATE_URL?.trim();
if (!databaseUrl) {
  throw new Error('MIGRATE_URL must be set');
}

const sql = postgres(databaseUrl, { max: 1 });
try {
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS admin');
} finally {
  await sql.end({ timeout: 5 });
}
" 

echo "run-migrate-admin: applying @slugbase/db-admin Drizzle migrations"
pnpm --filter @slugbase/db-admin exec drizzle-kit migrate

echo "run-migrate-admin: done"
