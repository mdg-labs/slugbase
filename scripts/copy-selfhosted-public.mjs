#!/usr/bin/env node
/**
 * Copy frontend dist into apps/selfhosted/public so the self-hosted server can serve it.
 */

import { cpSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const frontendDist = join(root, 'frontend', 'dist');
const selfhostedPublic = join(root, 'apps', 'selfhosted', 'public');

if (!existsSync(frontendDist)) {
  console.warn('scripts/copy-selfhosted-public.mjs: frontend/dist not found. Run frontend build first.');
  process.exit(0);
}
mkdirSync(selfhostedPublic, { recursive: true });
cpSync(frontendDist, selfhostedPublic, { recursive: true });
console.log('Copied frontend/dist to apps/selfhosted/public');
