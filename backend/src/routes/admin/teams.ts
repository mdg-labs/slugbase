import { Router } from 'express';
import { query, queryOne, execute } from '../../db/index.js';
import { AuthRequest, requireAuth, requireAdmin } from '../../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';
import { getTenantId } from '../../utils/tenant.js';

const router = Router();
router.use(requireAuth());
router.use(requireAdmin());

/**
 * @swagger
 * /api/admin/teams:
 *   get:
 *     summary: Get all teams
 *     description: Returns a list of all teams in the system. Admin only.
 *     tags: [Admin - Teams]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of teams
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
 *       403:
 *         description: Admin access required
 */
router.get('/', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const tenantId = getTenantId(req);
    const teams = await query('SELECT * FROM teams WHERE tenant_id = ? ORDER BY created_at DESC', [tenantId]);
    const teamsList = Array.isArray(teams) ? teams : (teams ? [teams] : []);
    res.json(teamsList);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/admin/teams/{id}:
 *   get:
 *     summary: Get team by ID with members
 *     description: Returns detailed information about a team including all members. Admin only.
 *     tags: [Admin - Teams]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Team ID
 *         example: "123e4567-e89b-12d3-a456-426614174000"
 *     responses:
 *       200:
 *         description: Team with members
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                 name:
 *                   type: string
 *                 description:
 *                   type: string
 *                   nullable: true
 *                 created_at:
 *                   type: string
 *                   format: date-time
 *                 members:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       email:
 *                         type: string
 *                       name:
 *                         type: string
 *                       is_admin:
 *                         type: boolean
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *       404:
 *         description: Team not found
 */
router.get('/:id', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const { id } = req.params;
    const tenantId = getTenantId(req);
    const team = await queryOne('SELECT * FROM teams WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    const members = await query(
      `SELECT u.id, u.email, u.name, u.is_admin 
       FROM users u 
       INNER JOIN team_members tm ON u.id = tm.user_id 
       WHERE tm.team_id = ? AND tm.tenant_id = ?`,
      [id, tenantId]
    );

    res.json({
      ...team,
      members: Array.isArray(members) ? members : (members ? [members] : []),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/admin/teams:
 *   post:
 *     summary: Create a new team
 *     description: Creates a new team. Team names must be unique. Admin only.
 *     tags: [Admin - Teams]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *                 example: "Development Team"
 *                 description: Unique team name
 *               description:
 *                 type: string
 *                 nullable: true
 *                 example: "Team for development work"
 *     responses:
 *       201:
 *         description: Team created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                 name:
 *                   type: string
 *                 description:
 *                   type: string
 *                   nullable: true
 *                 created_at:
 *                   type: string
 *                   format: date-time
 *       400:
 *         description: Missing name or team with same name already exists
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 */
router.post('/', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const { name, description } = req.body;
    const tenantId = getTenantId(req);

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const existing = await queryOne('SELECT id FROM teams WHERE tenant_id = ? AND name = ?', [tenantId, name]);
    if (existing) {
      return res.status(400).json({ error: 'Team with this name already exists' });
    }

    const teamId = uuidv4();
    await execute(
      'INSERT INTO teams (id, tenant_id, name, description) VALUES (?, ?, ?, ?)',
      [teamId, tenantId, name, description || null]
    );

    const team = await queryOne('SELECT * FROM teams WHERE id = ? AND tenant_id = ?', [teamId, tenantId]);
    res.status(201).json(team);
  } catch (error: any) {
    if (error.message && (error.message.includes('UNIQUE constraint') || error.message.includes('duplicate'))) {
      return res.status(400).json({ error: 'Team with this name already exists' });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/admin/teams/{id}:
 *   put:
 *     summary: Update team
 *     description: Updates an existing team. All fields are optional. Team names must be unique. Admin only.
 *     tags: [Admin - Teams]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Team ID
 *         example: "123e4567-e89b-12d3-a456-426614174000"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 example: "Updated Team Name"
 *               description:
 *                 type: string
 *                 nullable: true
 *                 example: "Updated description"
 *     responses:
 *       200:
 *         description: Team updated successfully
 *       400:
 *         description: Team name already exists or no fields to update
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *       404:
 *         description: Team not found
 */
router.put('/:id', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const { id } = req.params;
    const { name, description } = req.body;
    const tenantId = getTenantId(req);

    const existing = await queryOne('SELECT * FROM teams WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    if (!existing) {
      return res.status(404).json({ error: 'Team not found' });
    }

    if (name && name !== (existing as any).name) {
      const nameCheck = await queryOne('SELECT id FROM teams WHERE tenant_id = ? AND name = ? AND id != ?', [tenantId, name, id]);
      if (nameCheck) {
        return res.status(400).json({ error: 'Team with this name already exists' });
      }
    }

    const updates: string[] = [];
    const params: any[] = [];

    if (name !== undefined) {
      updates.push('name = ?');
      params.push(name);
    }
    if (description !== undefined) {
      updates.push('description = ?');
      params.push(description);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    params.push(id, tenantId);
    await execute(`UPDATE teams SET ${updates.join(', ')} WHERE id = ? AND tenant_id = ?`, params);

    const team = await queryOne('SELECT * FROM teams WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    res.json(team);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/admin/teams/{id}:
 *   delete:
 *     summary: Delete team
 *     description: Deletes a team. This removes all team memberships and team shares. Admin only.
 *     tags: [Admin - Teams]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Team ID
 *         example: "123e4567-e89b-12d3-a456-426614174000"
 *     responses:
 *       200:
 *         description: Team deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Team deleted"
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *       404:
 *         description: Team not found
 */
router.delete('/:id', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const { id } = req.params;
    const tenantId = getTenantId(req);
    const team = await queryOne('SELECT * FROM teams WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    await execute('DELETE FROM teams WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    res.json({ message: 'Team deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/admin/teams/{id}/members:
 *   post:
 *     summary: Add user to team
 *     description: Adds a user to a team. Admin only.
 *     tags: [Admin - Teams]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Team ID
 *         example: "123e4567-e89b-12d3-a456-426614174000"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - user_id
 *             properties:
 *               user_id:
 *                 type: string
 *                 description: User ID to add to the team
 *                 example: "123e4567-e89b-12d3-a456-426614174000"
 *     responses:
 *       200:
 *         description: User added to team successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "User added to team"
 *       400:
 *         description: Missing user_id or user already in team
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *       404:
 *         description: Team or user not found
 */
router.post('/:id/members', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const { id } = req.params;
    const { user_id } = req.body;
    const tenantId = getTenantId(req);

    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    const team = await queryOne('SELECT * FROM teams WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    const user = await queryOne('SELECT * FROM users WHERE id = ?', [user_id]);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const existing = await queryOne('SELECT * FROM team_members WHERE team_id = ? AND user_id = ? AND tenant_id = ?', [id, user_id, tenantId]);
    if (existing) {
      return res.status(400).json({ error: 'User is already in this team' });
    }

    await execute('INSERT INTO team_members (team_id, user_id, tenant_id) VALUES (?, ?, ?)', [id, user_id, tenantId]);
    res.json({ message: 'User added to team' });
  } catch (error: any) {
    if (error.message && (error.message.includes('UNIQUE constraint') || error.message.includes('duplicate'))) {
      return res.status(400).json({ error: 'User is already in this team' });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/admin/teams/{id}/members/{userId}:
 *   delete:
 *     summary: Remove user from team
 *     tags: [Admin - Teams]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: User removed from team
 */
/**
 * @swagger
 * /api/admin/teams/{id}/members/{userId}:
 *   delete:
 *     summary: Remove user from team
 *     description: Removes a user from a team. Admin only.
 *     tags: [Admin - Teams]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Team ID
 *         example: "123e4567-e89b-12d3-a456-426614174000"
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID to remove from the team
 *         example: "123e4567-e89b-12d3-a456-426614174000"
 *     responses:
 *       200:
 *         description: User removed from team successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "User removed from team"
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *       404:
 *         description: Team or user not found, or user not in team
 */
router.delete('/:id/members/:userId', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const { id, userId } = req.params;
    const tenantId = getTenantId(req);
    await execute('DELETE FROM team_members WHERE team_id = ? AND user_id = ? AND tenant_id = ?', [id, userId, tenantId]);
    res.json({ message: 'User removed from team' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
