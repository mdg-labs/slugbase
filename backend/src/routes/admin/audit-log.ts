import { Router } from 'express';
import { requireAuth, requireAdmin } from '../../middleware/auth.js';
import { getTenantId } from '../../utils/tenant.js';
import { isAuditLogEnabledForRequest, listAuditEvents } from '../../services/audit-log.js';

const router = Router();
router.use(requireAuth());
router.use(requireAdmin());

router.get('/', async (req, res) => {
  try {
    if (!(await isAuditLogEnabledForRequest(req))) {
      return res.status(403).json({
        error: 'Audit log is available on SlugBase Cloud for the Team plan. Self-hosted includes the audit log for all admins.',
        code: 'audit_log_unavailable',
      });
    }

    const tenantId = getTenantId(req);
    const limitRaw = parseInt(String(req.query.limit ?? '50'), 10);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 50, 1), 100);
    const beforeCreatedAt =
      typeof req.query.before_created_at === 'string' && req.query.before_created_at.trim()
        ? req.query.before_created_at.trim()
        : undefined;
    const beforeId =
      typeof req.query.before_id === 'string' && req.query.before_id.trim()
        ? req.query.before_id.trim()
        : undefined;

    if ((beforeCreatedAt && !beforeId) || (!beforeCreatedAt && beforeId)) {
      return res.status(400).json({ error: 'Pagination requires both before_created_at and before_id' });
    }

    const events = await listAuditEvents(tenantId, {
      limit,
      beforeCreatedAt,
      beforeId,
    });

    let next_cursor: { before_created_at: string; before_id: string } | null = null;
    if (events.length === limit) {
      const last = events[events.length - 1];
      next_cursor = { before_created_at: String(last.created_at), before_id: last.id };
    }

    res.json({
      events: events.map((e) => ({
        id: e.id,
        created_at: e.created_at,
        action: e.action,
        entity_type: e.entity_type,
        entity_id: e.entity_id,
        metadata: e.metadata,
        actor_user_id: e.actor_user_id,
        actor_email: e.actor_email,
        actor_name: e.actor_name,
      })),
      next_cursor,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
