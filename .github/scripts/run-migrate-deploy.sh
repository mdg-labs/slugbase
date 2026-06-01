#!/usr/bin/env bash
# Apply Drizzle migrations against DATABASE_URL (spec §22.5 staging/production deploy).
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

pnpm exec turbo run build --filter=@slugbase/backend...

node --input-type=module --eval "
import { runMigrations } from './packages/backend/dist/db/migrate/run-migrations.js';
await runMigrations(process.env.DATABASE_URL);
console.log('Migrations applied');
"
