/**
 * Public config endpoints for frontend feature detection.
 * Does not expose sensitive data (API keys, etc.).
 */

import { Router } from 'express';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { isAISuggestionsEnabled, isAIFeatureAvailable } from '../utils/ai-feature.js';
import { getTenantId } from '../utils/tenant.js';

const router = Router();

/**
 * @swagger
 * /api/config/ai-suggestions:
 *   get:
 *     summary: Check AI suggestions config for the current user
 *     description: Returns whether AI suggestions are enabled and if the feature is available (for profile toggle). Does not expose API keys.
 *     tags: [Config]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: AI suggestions config
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 enabled:
 *                   type: boolean
 *                   description: Whether AI suggestions are currently enabled for this user
 *                 available:
 *                   type: boolean
 *                   description: Whether the feature is available (for showing profile toggle)
 *       401:
 *         description: Unauthorized
 */
router.get('/ai-suggestions', requireAuth(), async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const tenantId = getTenantId(req);
    const [enabled, available] = await Promise.all([
      isAISuggestionsEnabled(userId, tenantId),
      isAIFeatureAvailable(userId, tenantId),
    ]);
    res.json({ enabled, available });
  } catch (error: any) {
    console.error('Config ai-suggestions error:', error);
    res.status(500).json({ error: 'Failed to load config' });
  }
});

export default router;
