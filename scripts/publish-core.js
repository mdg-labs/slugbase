#!/usr/bin/env node
/**
 * Publish @mdguggenbichler/slugbase-core to npm from local.
 * Builds the repo, assembles the package (including backend/dist) in a temp dir,
 * then runs npm publish. Use when dist/ is gitignored and must not be committed.
 *
 * Usage (from repo root):
 *   node scripts/publish-core.js
 *   node scripts/publish-core.js --dry-run   # pack only, do not publish
 *
 * Prerequisites:
 *   - npm run build (this script runs it for you)
 *   - npm login (publishes under your username scope, e.g. @mdguggenbichler/slugbase-core)
 *   - If you get 403 (2FA required): enable 2FA at https://www.npmjs.com/settings/~/account
 *     and log in again with `npm login`, or create a granular token at
 *     https://www.npmjs.com/settings/~/tokens with "Publish" and "Bypass 2FA" then
 *     use it: npm login --auth-type=legacy (paste token as password)
 */

import { cpSync, mkdirSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const core = join(root, 'packages', 'core');
const outDir = join(root, '.publish-core');

const dryRun = process.argv.includes('--dry-run');

function run(cmd, args, cwd = root) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: false });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// 1. Build (so packages/core/backend/dist exists)
console.log('Building...');
run('npm', ['run', 'build']);

const coreBackendDist = join(core, 'backend', 'dist');
if (!existsSync(coreBackendDist)) {
  console.error('packages/core/backend/dist missing after build. Aborting.');
  process.exit(1);
}

// 2. Assemble package in .publish-core (includes dist)
if (existsSync(outDir)) rmSync(outDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

const copy = (src, dest) => {
  const target = join(outDir, dest ?? src);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(core, src), target, { recursive: true });
};

copy('package.json');
if (existsSync(join(core, '.npmignore'))) copy('.npmignore');
copy('backend/index.js');
copy('backend/dist', 'backend/dist');
copy('frontend/index.js');
copy('frontend/index.tsx');
copy('types/index.js');

console.log('Package assembled in .publish-core');

// 3. Publish
if (dryRun) {
  run('npm', ['pack'], outDir);
  console.log('Dry run: tarball created in .publish-core. Not published.');
  process.exit(0);
}

console.log('Publishing @mdguggenbichler/slugbase-core to npm...');
run('npm', ['publish', '--access', 'public'], outDir);
console.log('Done. @mdguggenbichler/slugbase-core published. You can remove .publish-core if you like.');
