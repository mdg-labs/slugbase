import { Router } from 'express';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { tokenCreateRateLimiter } from '../middleware/security.js';
import * as apiTokens from '../services/api-tokens.js';
import { getTenantId } from '../utils/tenant.js';
import { recordAuditEvent } from '../services/audit-log.js';

const router = Router();
router.use(requireAuth());

router.get('/', async (req, res) => {
  const authReq = req as AuthRequest;
  const userId = authReq.user!.id;
  const tenantId = getTenantId(req);
  try {
    const tokens = await apiTokens.listTokens(userId, tenantId);
    res.json(tokens);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', tokenCreateRateLimiter, async (req, res) => {
  const authReq = req as AuthRequest;
  const userId = authReq.user!.id;
  const tenantId = getTenantId(req);
  const { name } = req.body;
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Token name is required' });
  }
  const result = await apiTokens.createToken(userId, name, tenantId);
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  await recordAuditEvent(req, {
    action: 'api_token.created',
    entityType: 'api_token',
    entityId: result.data.id,
    metadata: { name: result.data.name },
  });
  res.status(201).json(result.data);
});

router.delete('/:id', async (req, res) => {
  const authReq = req as AuthRequest;
  const userId = authReq.user!.id;
  const tenantId = getTenantId(req);
  const { id } = req.params;
  if (!id) {
    return res.status(400).json({ error: 'Token ID is required' });
  }
  const result = await apiTokens.revokeToken(userId, id, tenantId);
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  await recordAuditEvent(req, {
    action: 'api_token.revoked',
    entityType: 'api_token',
    entityId: id,
    metadata: {},
  });
  res.json({ message: 'Token revoked' });
});

export default router;
