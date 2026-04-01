#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendRoot = join(__dirname, '..');
const src = join(backendRoot, 'openapi');
const dest = join(backendRoot, 'dist', 'openapi');
if (!existsSync(src)) {
  console.error('copy-openapi: missing', src);
  process.exit(1);
}
mkdirSync(dirname(dest), { recursive: true });
cpSync(src, dest, { recursive: true });
console.log('copy-openapi: copied openapi -> dist/openapi');
