/**
 * Public config endpoints for frontend feature detection.
 * Does not expose sensitive data (API keys, etc.).
 */

import { Router } from 'express';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { isAISuggestionsEnabled, isAIFeatureAvailable } from '../utils/ai-feature.js';
import { getTenantId } from '../utils/tenant.js';

const router = Router();

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
