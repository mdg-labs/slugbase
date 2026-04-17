#!/usr/bin/env node
/**
 * Copy `frontend/src/locales/*.json` into `packages/core/frontend/locales/`
 * so @mdguggenbichler/slugbase-core can export them for the hosted product (and pack) without
 * duplicating JSON in the Cloud deployment.
 *
 * Run from repo root: node scripts/sync-core-locales.mjs
 * Invoked automatically from assemble-core-package.mjs and npm run build.
 */

import { readdirSync, mkdirSync, copyFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const srcDir = join(root, 'frontend', 'src', 'locales');
const destDir = join(root, 'packages', 'core', 'frontend', 'locales');

if (!existsSync(srcDir)) {
  console.error('sync-core-locales: missing', srcDir);
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
const files = readdirSync(srcDir).filter((f) => f.endsWith('.json'));
if (files.length === 0) {
  console.error('sync-core-locales: no .json files in', srcDir);
  process.exit(1);
}
for (const f of files) {
  copyFileSync(join(srcDir, f), join(destDir, f));
}
console.log(`sync-core-locales: copied ${files.length} file(s) → packages/core/frontend/locales/`);
