/**
 * Public config endpoints for frontend feature detection.
 * Does not expose sensitive data (API keys, etc.).
 */

import { Router } from 'express';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { isAISuggestionsEnabled, isAIFeatureAvailable } from '../utils/ai-feature.js';
import { getTenantId } from '../utils/tenant.js';
import { isCloud } from '../config/mode.js';
import { isAuditLogEnabledForRequest } from '../services/audit-log.js';

const router = Router();

/** GET /api/config/plan – cloud only. Returns plan, bookmarkLimit, canShareWithTeams, ai_available, audit_log_available. When !isCloud returns 404. */
router.get('/plan', requireAuth(), async (req, res) => {
  if (!isCloud) {
    return res.status(404).json({ error: 'Not available' });
  }
  const plan = (req as any).plan as string | undefined;
  const effectivePlan = plan ?? 'free';
  let audit_log_available = false;
  try {
    audit_log_available = await isAuditLogEnabledForRequest(req);
  } catch {
    audit_log_available = false;
  }
  res.json({
    plan: effectivePlan,
    bookmarkLimit: effectivePlan === 'free' ? 50 : null,
    canShareWithTeams: effectivePlan === 'team',
    ai_available: effectivePlan !== 'free',
    audit_log_available,
  });
});

router.get('/ai-suggestions', requireAuth(), async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const tenantId = getTenantId(req);
    let [enabled, available] = await Promise.all([
      isAISuggestionsEnabled(userId, tenantId),
      isAIFeatureAvailable(userId, tenantId),
    ]);
    // Cloud: AI suggestions only on Personal, Team, and Early Supporter (lifetime) – not Free
    if (isCloud && (req as any).plan === 'free') {
      enabled = false;
      available = false;
    }
    res.json({ enabled, available });
  } catch (error: any) {
    console.error('Config ai-suggestions error:', error);
    res.status(500).json({ error: 'Failed to load config' });
  }
});

export default router;
