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

/**
 * @swagger
 * /api/health:
 *   get:
 *     summary: Health check
 *     description: Returns service health status. Public, no auth required.
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Service is healthy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: "ok"
 */
router.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

/**
 * @swagger
 * /api/version:
 *   get:
 *     summary: Get version info
 *     description: Returns application version, commit SHA, and mode. Public, no auth required.
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Version information
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 version:
 *                   type: string
 *                   description: "Semantic version from package.json (e.g. 1.0.0)"
 *                 commit:
 *                   type: string
 *                   nullable: true
 *                   description: "Git commit SHA when built in CI, null in dev"
 *                 mode:
 *                   type: string
 *                   description: "'selfhosted' or 'cloud'"
 */
router.get('/version', (req, res) => {
  res.json({
    version: appVersion,
    commit: process.env.COMMIT_SHA || null,
    mode,
  });
});

export default router;
