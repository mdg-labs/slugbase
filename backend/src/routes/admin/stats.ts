/**
 * GET /api/admin/stats — Secret-protected system metrics.
 * Requires X-Stats-Secret header matching STATS_ENDPOINT_SECRET.
 */

import { Router, Request, Response } from 'express';
import { statsSecretAuth } from '../../middleware/stats-auth.js';
import { aggregateStats } from '../../services/stats.js';

const router = Router();

const CACHE_TTL_MS = 60 * 1000; // 60 seconds
let cache: { last: number; data: object } | null = null;

/**
 * @swagger
 * /api/admin/stats:
 *   get:
 *     summary: Get system statistics
 *     description: Returns platform-wide metrics (users, bookmarks, activity, etc.). Requires X-Stats-Secret header matching STATS_ENDPOINT_SECRET. Platform-operator only, not org-scoped.
 *     tags: [Admin - Stats]
 *     parameters:
 *       - in: header
 *         name: X-Stats-Secret
 *         required: true
 *         schema:
 *           type: string
 *         description: Secret for stats endpoint access
 *     responses:
 *       200:
 *         description: Aggregated statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 core_counts:
 *                   type: object
 *                 breakdowns:
 *                   type: object
 *                 activity:
 *                   type: object
 *                 distributions:
 *                   type: object
 *                 timeseries:
 *                   type: object
 *                 payments:
 *                   type: object
 *       401:
 *         description: Unauthorized (invalid or missing secret)
 *       500:
 *         description: Internal server error
 */
router.get('/', statsSecretAuth, async (req: Request, res: Response) => {
  try {
    const now = Date.now();
    if (cache && now - cache.last < CACHE_TTL_MS) {
      return res.json(cache.data);
    }

    const data = await aggregateStats();
    cache = { last: now, data };
    res.json(data);
  } catch (error: any) {
    console.error('Stats endpoint error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
