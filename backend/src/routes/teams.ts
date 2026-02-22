import { Router } from 'express';
import { query } from '../db/index.js';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { getTenantId } from '../utils/tenant.js';

const router = Router();
router.use(requireAuth());

/**
 * @swagger
 * /api/teams:
 *   get:
 *     summary: Get teams for current user
 *     description: Returns all teams that the authenticated user is a member of
 *     tags: [Teams]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of teams the user is a member of
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: string
 *                     example: "123e4567-e89b-12d3-a456-426614174000"
 *                   name:
 *                     type: string
 *                     example: "Development Team"
 *                   description:
 *                     type: string
 *                     nullable: true
 *                     example: "Team for development work"
 *                   created_at:
 *                     type: string
 *                     format: date-time
 *       401:
 *         description: Unauthorized
 */
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
