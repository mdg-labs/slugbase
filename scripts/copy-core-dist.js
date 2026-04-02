#!/usr/bin/env node
/**
 * Copy backend dist into packages/core so that @slugbase/core/backend can re-export.
 * Run after building the backend (e.g. from root: npm run build --workspace=backend && node scripts/copy-core-dist.js).
 */

import { cpSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const backendDist = join(root, 'backend', 'dist');
const coreBackendDist = join(root, 'packages', 'core', 'backend', 'dist');
const schemaSrc = join(root, 'backend', 'src', 'db', 'schema.sql');
const schemaDest = join(backendDist, 'db', 'schema.sql');

if (!existsSync(backendDist)) {
  console.warn('scripts/copy-core-dist.js: backend/dist not found. Run npm run build --workspace=backend first.');
  process.exit(0);
}
// initDatabase() reads schema.sql from dist/db/; include it so published package has it
if (existsSync(schemaSrc)) {
  mkdirSync(join(backendDist, 'db'), { recursive: true });
  cpSync(schemaSrc, schemaDest);
}
mkdirSync(coreBackendDist, { recursive: true });
cpSync(backendDist, coreBackendDist, { recursive: true });
console.log('Copied backend/dist to packages/core/backend/dist');
