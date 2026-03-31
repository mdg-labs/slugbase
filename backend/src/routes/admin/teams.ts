import { Router } from 'express';
import { query, queryOne, execute } from '../../db/index.js';
import { AuthRequest, requireAuth, requireAdmin } from '../../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';
import { getTenantId } from '../../utils/tenant.js';

const router = Router();
router.use(requireAuth());
router.use(requireAdmin());

router.get('/', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const tenantId = getTenantId(req);
    const teams = await query(
      `SELECT t.*,
        (SELECT COUNT(*) FROM team_members tm WHERE tm.team_id = t.id AND tm.tenant_id = t.tenant_id) AS member_count
       FROM teams t
       WHERE t.tenant_id = ?
       ORDER BY t.created_at DESC`,
      [tenantId]
    );
    const teamsList = Array.isArray(teams) ? teams : (teams ? [teams] : []);
    res.json(teamsList);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

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
