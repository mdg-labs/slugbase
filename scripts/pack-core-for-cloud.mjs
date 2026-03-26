#!/usr/bin/env node
/**
 * One-shot: build monorepo → assemble .publish-core → npm pack → copy .tgz to slugbase-cloud/vendor/.
 *
 * From slugbase repo root:
 *   npm run pack:cloud
 *
 * Env:
 *   SLUGBASE_CLOUD_ROOT — path to slugbase-cloud repo (default: ../slugbase-cloud relative to slugbase root).
 *     May be absolute, or relative to slugbase root (e.g. ../slugbase-cloud).
 */

import { spawnSync } from 'child_process';
import { copyFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from 'fs';
import { join, dirname, isAbsolute } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cloudRoot = process.env.SLUGBASE_CLOUD_ROOT
  ? isAbsolute(process.env.SLUGBASE_CLOUD_ROOT)
    ? process.env.SLUGBASE_CLOUD_ROOT
    : join(root, process.env.SLUGBASE_CLOUD_ROOT)
  : join(root, '..', 'slugbase-cloud');

const vendorDir = join(cloudRoot, 'vendor');
const pubDir = join(root, '.publish-core');

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: false });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (!existsSync(cloudRoot)) {
  console.error(`pack-core-for-cloud: cloud repo not found at ${cloudRoot}`);
  console.error('Set SLUGBASE_CLOUD_ROOT to your slugbase-cloud path (relative to slugbase root or absolute).');
  process.exit(1);
}

console.log('pack-core-for-cloud: npm run build');
run('npm', ['run', 'build'], root);

console.log('pack-core-for-cloud: assemble .publish-core');
run('node', ['scripts/assemble-core-package.js', '--no-build'], root);

for (const f of readdirSync(pubDir)) {
  if (f.endsWith('.tgz')) unlinkSync(join(pubDir, f));
}

console.log('pack-core-for-cloud: npm pack');
run('npm', ['pack'], pubDir);

const tgz = readdirSync(pubDir).find((f) => f.endsWith('.tgz'));
if (!tgz) {
  console.error('pack-core-for-cloud: no .tgz produced in .publish-core');
  process.exit(1);
}

mkdirSync(vendorDir, { recursive: true });
const src = join(pubDir, tgz);
const dest = join(vendorDir, tgz);
copyFileSync(src, dest);

console.log(`pack-core-for-cloud: wrote ${dest}`);
console.log(`Next: cd "${cloudRoot}" && npm install  (then commit vendor/${tgz} + package-lock.json if needed)`);
