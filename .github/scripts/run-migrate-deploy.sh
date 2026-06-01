#!/usr/bin/env bash
# Apply Drizzle migrations (spec §22.5 staging/production deploy).
# Prefer DATABASE_URL_UNPOOLED (Neon direct) over pooled DATABASE_URL.
set -euo pipefail

MIGRATION_DATABASE_URL="${DATABASE_URL_UNPOOLED:-${DATABASE_URL:-}}"
: "${MIGRATION_DATABASE_URL:?DATABASE_URL or DATABASE_URL_UNPOOLED is required}"
export MIGRATION_DATABASE_URL

pnpm exec turbo run build --filter=@slugbase/backend...

node --input-type=module --eval "
import { runMigrations } from './packages/backend/dist/db/migrate/run-migrations.js';
await runMigrations(process.env.MIGRATION_DATABASE_URL);
console.log('Migrations applied');
"
