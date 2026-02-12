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
