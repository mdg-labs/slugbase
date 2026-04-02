/**
 * Health and version endpoints.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Router } from 'express';
import { mode } from '../config/mode.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Read semantic version from root package.json. Falls back to COMMIT_SHA or 'dev'. */
function getAppVersion(): string {
  try {
    const rootPkgPath = join(__dirname, '..', '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : 'dev';
  } catch {
    return process.env.COMMIT_SHA || 'dev';
  }
}

const appVersion = getAppVersion();

const router = Router();

router.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

router.get('/version', (req, res) => {
  res.json({
    version: appVersion,
    commit: process.env.COMMIT_SHA || null,
    mode,
  });
});

export default router;
