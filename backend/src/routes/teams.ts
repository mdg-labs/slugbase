import { Router } from 'express';
import { query } from '../db/index.js';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { getTenantId } from '../utils/tenant.js';

const router = Router();
router.use(requireAuth());

router.get('/', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const tenantId = getTenantId(req);
    const teams = await query(
      `SELECT t.* FROM teams t
       INNER JOIN team_members tm ON t.id = tm.team_id
       WHERE tm.user_id = ? AND tm.tenant_id = ? AND t.tenant_id = ?
       ORDER BY t.name`,
      [userId, tenantId, tenantId]
    );
    const teamsList = Array.isArray(teams) ? teams : (teams ? [teams] : []);
    res.json(teamsList);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
