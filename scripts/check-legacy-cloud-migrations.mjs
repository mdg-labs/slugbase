#!/usr/bin/env node
/**
 * Fail if core migration index registers _legacy_cloud_* files (reference-only; must not run on self-hosted).
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const indexPath = join(root, 'backend', 'src', 'db', 'migrations', 'index.ts');
const src = readFileSync(indexPath, 'utf8');
if (src.includes('_legacy_cloud_')) {
  console.error(
    'check-legacy-cloud-migrations: backend/src/db/migrations/index.ts must not import or reference _legacy_cloud_ migrations.'
  );
  process.exit(1);
}
console.log('check-legacy-cloud-migrations: ok');
