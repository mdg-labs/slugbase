/**
 * Health and version endpoints.
 */

import { Router } from 'express';
import { mode } from '../config/mode.js';

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
 *                   description: "Commit SHA or 'dev'"
 *                 commit:
 *                   type: string
 *                   nullable: true
 *                 mode:
 *                   type: string
 *                   description: "'selfhosted' or 'cloud'"
 */
router.get('/version', (req, res) => {
  res.json({
    version: process.env.COMMIT_SHA || 'dev',
    commit: process.env.COMMIT_SHA || null,
    mode,
  });
});

export default router;
