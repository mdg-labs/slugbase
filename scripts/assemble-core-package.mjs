#!/usr/bin/env node
/**
 * Assemble @mdguggenbichler/slugbase-core npm package tree into an output directory.
 * Used by pack-core-for-cloud.mjs and for manual inspection of `.publish-core/`.
 *
 * Usage (from repo root):
 *   node scripts/assemble-core-package.mjs
 *   node scripts/assemble-core-package.mjs --no-build    # skip npm run build (CI already built)
 *
 * Env:
 *   CORE_PACKAGE_VERSION  - if set (e.g. 1.2.3 or v1.2.3), written into assembled package.json
 *   CORE_PACKAGE_OUT      - output directory (default: .publish-core)
 */

import { readFileSync, writeFileSync, cpSync, mkdirSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const core = join(root, 'packages', 'core');
const outDir = process.env.CORE_PACKAGE_OUT
  ? join(root, process.env.CORE_PACKAGE_OUT)
  : join(root, '.publish-core');

const noBuild = process.argv.includes('--no-build');

function run(cmd, args, cwd = root) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: false });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (!noBuild) {
  console.log('Building monorepo (backend, frontend, core embed)...');
  run('npm', ['run', 'build']);
}

const coreBackendDist = join(core, 'backend', 'dist');
if (!existsSync(coreBackendDist)) {
  console.error('packages/core/backend/dist missing. Run npm run build from repo root.');
  process.exit(1);
}

const embedPublish = join(core, 'frontend', 'publish');
if (!existsSync(embedPublish)) {
  console.error(
    'packages/core/frontend/publish missing. Run npm run build:core-embed --workspace=frontend (included in npm run build).'
  );
  process.exit(1);
}

run('node', ['scripts/sync-core-locales.mjs'], root);

if (existsSync(outDir)) rmSync(outDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

const pkg = JSON.parse(readFileSync(join(core, 'package.json'), 'utf8'));
const ver = process.env.CORE_PACKAGE_VERSION;
if (ver) {
  pkg.version = String(ver).replace(/^v/, '');
}
writeFileSync(join(outDir, 'package.json'), JSON.stringify(pkg, null, 2));

if (existsSync(join(core, '.npmignore'))) {
  cpSync(join(core, '.npmignore'), join(outDir, '.npmignore'));
}

const copyInto = (srcRel, destRel) => {
  const from = join(core, srcRel);
  const to = join(outDir, destRel ?? srcRel);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
};

copyInto('backend/index.js');
copyInto('backend/dist', 'backend/dist');
copyInto('frontend/embed.js');
copyInto('frontend/locales', 'frontend/locales');
copyInto('frontend/publish', 'frontend/publish');
copyInto('types/index.js');

const backendOpenapi = join(root, 'backend', 'openapi');
if (existsSync(backendOpenapi)) {
  mkdirSync(join(outDir, 'openapi'), { recursive: true });
  cpSync(backendOpenapi, join(outDir, 'openapi'), { recursive: true });
}

console.log(`Assembled @mdguggenbichler/slugbase-core in ${outDir} (version ${pkg.version})`);
