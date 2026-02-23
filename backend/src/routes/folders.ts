import { Router } from 'express';
import { query, queryOne, execute } from '../db/index.js';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { canAccessFolder, canModifyFolder, getTeamIdsForUser } from '../auth/authorization.js';
import { v4 as uuidv4 } from 'uuid';
import { validateLength, sanitizeString, MAX_LENGTHS } from '../utils/validation.js';
import { getTenantId } from '../utils/tenant.js';

const router = Router();
router.use(requireAuth());

// Get all folders for user (own + shared), optionally filtered by scope
// When limit is provided, returns { items, total }; otherwise returns array (backward compat)
router.get('/', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const tenantId = getTenantId(req);
    const scopeParam = req.query.scope;
    const scope = scopeParam === 'mine' || scopeParam === 'shared_with_me' || scopeParam === 'shared_by_me'
      ? scopeParam
      : 'all';
    const limitParam = req.query.limit;
    const offsetParam = req.query.offset;
    const usePagination = limitParam != null && limitParam !== '';
    const limit = usePagination ? Math.min(500, Math.max(1, parseInt(String(limitParam), 10) || 50)) : 0;
    const offset = usePagination ? Math.max(0, parseInt(String(offsetParam), 10) || 0) : 0;
    const teamIds = await getTeamIdsForUser(userId, tenantId);

    // Get own folders + shared folders (via users, teams, or folder shares)
    // In cloud mode, user shares (fus) only count when folder owner is in same org
    const fusCond = 'fus.user_id = ?';
    let sql = `
      SELECT DISTINCT f.*,
             CASE WHEN f.user_id = ? THEN 'own' ELSE 'shared' END as folder_type
      FROM folders f
      LEFT JOIN folder_user_shares fus ON f.id = fus.folder_id
      LEFT JOIN folder_team_shares fts ON f.id = fts.folder_id
      WHERE f.tenant_id = ?
        AND (f.user_id = ?
        OR ${fusCond}
        OR (fts.team_id IN (${teamIds.length > 0 ? teamIds.map(() => '?').join(',') : 'NULL'}) AND fts.team_id IS NOT NULL))
    `;
    // Placeholder order: CASE f.user_id, WHERE f.tenant_id, f.user_id, fus.user_id, [teamIds]
    const params: any[] = [userId, tenantId, userId, userId];
    if (teamIds.length > 0) {
      params.push(...teamIds);
    }

    if (scope === 'mine') {
      sql += ' AND f.user_id = ?';
      params.push(userId);
    }
    if (scope === 'shared_with_me') {
      sql += ' AND f.user_id != ?';
      params.push(userId);
    }
    if (scope === 'shared_by_me') {
      sql += ' AND f.user_id = ? AND (EXISTS (SELECT 1 FROM folder_team_shares fts WHERE fts.folder_id = f.id) OR EXISTS (SELECT 1 FROM folder_user_shares fus WHERE fus.folder_id = f.id))';
      params.push(userId);
    }

    let total = 0;
    if (usePagination) {
      const countSql = `
        SELECT COUNT(DISTINCT f.id) as total FROM folders f
        LEFT JOIN folder_user_shares fus ON f.id = fus.folder_id
        LEFT JOIN folder_team_shares fts ON f.id = fts.folder_id
        WHERE f.tenant_id = ?
          AND (f.user_id = ?
          OR ${fusCond}
          OR (fts.team_id IN (${teamIds.length > 0 ? teamIds.map(() => '?').join(',') : 'NULL'}) AND fts.team_id IS NOT NULL))
        ${scope === 'mine' ? 'AND f.user_id = ?' : ''}
        ${scope === 'shared_with_me' ? 'AND f.user_id != ?' : ''}
        ${scope === 'shared_by_me' ? 'AND f.user_id = ? AND (EXISTS (SELECT 1 FROM folder_team_shares fts WHERE fts.folder_id = f.id) OR EXISTS (SELECT 1 FROM folder_user_shares fus WHERE fus.folder_id = f.id))' : ''}
      `;
      const countParams = [tenantId, userId, userId];
      if (teamIds.length > 0) countParams.push(...teamIds);
      if (scope === 'mine') countParams.push(userId);
      if (scope === 'shared_with_me') countParams.push(userId);
      if (scope === 'shared_by_me') countParams.push(userId);
      const countRow = await queryOne(countSql, countParams);
      total = countRow ? parseInt((countRow as any).total, 10) : 0;
    }

    // Add sorting
    const sortBy = (req.query.sort_by as string) || 'alphabetical';
    switch (sortBy) {
      case 'recently_added':
        sql += ' ORDER BY f.created_at DESC';
        break;
      case 'alphabetical':
      default:
        sql += ' ORDER BY f.name ASC';
        break;
    }

    if (usePagination) {
      sql += ' LIMIT ? OFFSET ?';
      params.push(limit, offset);
    }

    const folders = await query(sql, params);
    const folderList = folders as any[];

    if (folderList.length === 0) {
      if (usePagination) return res.json({ items: [], total });
      return res.json(folders);
    }

    const folderIds = folderList.map((f) => f.id).filter(Boolean);
    const placeholders = folderIds.map(() => '?').join(',');

    // Batch fetch folder_team_shares and folder_user_shares
    const ftsRows = await query(
      `SELECT fts.folder_id, t.id, t.name, t.description, t.created_at FROM folder_team_shares fts
       INNER JOIN teams t ON fts.team_id = t.id
       WHERE fts.folder_id IN (${placeholders})`,
      folderIds
    );
    const sharedTeamsByFolder = new Map<string, any[]>();
    for (const row of Array.isArray(ftsRows) ? ftsRows : []) {
      const r = row as any;
      const fid = r.folder_id;
      if (!fid) continue;
      const team = { id: r.id, name: r.name, description: r.description, created_at: r.created_at };
      if (!sharedTeamsByFolder.has(fid)) sharedTeamsByFolder.set(fid, []);
      sharedTeamsByFolder.get(fid)!.push(team);
    }

    const fusRows = await query(
      `SELECT fus.folder_id, u.id, u.name, u.email FROM folder_user_shares fus
       INNER JOIN users u ON fus.user_id = u.id
       WHERE fus.folder_id IN (${placeholders})`,
      folderIds
    );
    const sharedUsersByFolder = new Map<string, any[]>();
    for (const row of Array.isArray(fusRows) ? fusRows : []) {
      const r = row as any;
      const fid = r.folder_id;
      if (!fid) continue;
      const user = { id: r.id, name: r.name, email: r.email };
      if (!sharedUsersByFolder.has(fid)) sharedUsersByFolder.set(fid, []);
      sharedUsersByFolder.get(fid)!.push(user);
    }

    // Batch fetch owner info for shared folders
    const ownerIds = [...new Set(folderList.filter((f) => f.user_id !== userId).map((f) => f.user_id))];
    const ownersById = new Map<string, { name: string; email: string }>();
    if (ownerIds.length > 0) {
      const ownerPlaceholders = ownerIds.map(() => '?').join(',');
      const ownerRows = await query(
        `SELECT id, name, email FROM users WHERE id IN (${ownerPlaceholders})`,
        ownerIds
      );
      for (const row of Array.isArray(ownerRows) ? ownerRows : []) {
        const r = row as any;
        ownersById.set(r.id, { name: r.name, email: r.email });
      }
    }

    for (const folder of folderList) {
      if (folder.user_id !== userId) {
        const owner = ownersById.get(folder.user_id);
        if (owner) {
          folder.user_name = owner.name;
          folder.user_email = owner.email;
        }
      }
      folder.shared_teams = sharedTeamsByFolder.get(folder.id) || [];
      folder.shared_users = sharedUsersByFolder.get(folder.id) || [];
    }

    if (usePagination) {
      return res.json({ items: folderList, total });
    }
    res.json(folders);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get single folder (own or shared)
router.get('/:id', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const tenantId = getTenantId(req);
    const { id } = req.params;

    const canAccess = await canAccessFolder(userId, id, null, tenantId);
    if (!canAccess) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    const folder = await queryOne('SELECT * FROM folders WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    if (!folder) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    // Get shared teams
    const sharedTeams = await query(
      `SELECT t.* FROM teams t
       INNER JOIN folder_team_shares fts ON t.id = fts.team_id
       WHERE fts.folder_id = ?`,
      [id]
    );
    (folder as any).shared_teams = Array.isArray(sharedTeams) ? sharedTeams : (sharedTeams ? [sharedTeams] : []);
    
    // Get shared users
    const sharedUsers = await query(
      `SELECT u.id, u.name, u.email FROM users u
       INNER JOIN folder_user_shares fus ON u.id = fus.user_id
       WHERE fus.folder_id = ?`,
      [id]
    );
    (folder as any).shared_users = Array.isArray(sharedUsers) ? sharedUsers : (sharedUsers ? [sharedUsers] : []);

    res.json(folder);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Create folder
router.post('/', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const tenantId = getTenantId(req);
    const { name, icon } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    // Validate and sanitize name
    const nameValidation = validateLength(name, 'Name', 1, MAX_LENGTHS.folderName);
    if (!nameValidation.valid) {
      return res.status(400).json({ error: nameValidation.error });
    }
    const sanitizedName = sanitizeString(name);

    // Validate icon length if provided
    if (icon !== undefined && icon !== null) {
      const iconValidation = validateLength(icon, 'Icon', 0, MAX_LENGTHS.icon);
      if (!iconValidation.valid) {
        return res.status(400).json({ error: iconValidation.error });
      }
    }

    // Check if folder with same name exists
    const existing = await queryOne('SELECT id FROM folders WHERE tenant_id = ? AND user_id = ? AND name = ?', [tenantId, userId, sanitizedName]);
    if (existing) {
      return res.status(400).json({ error: 'Folder with this name already exists' });
    }

    const folderId = uuidv4();
    let { team_ids, user_ids, share_all_teams } = req.body;

    await execute('INSERT INTO folders (id, tenant_id, user_id, name, icon) VALUES (?, ?, ?, ?, ?)', [folderId, tenantId, userId, sanitizedName, icon || null]);

    // Add team shares
    if (share_all_teams) {
      const teamIds = await getTeamIdsForUser(userId, tenantId);
      for (const teamId of teamIds) {
        await execute(
          'INSERT INTO folder_team_shares (folder_id, team_id) VALUES (?, ?)',
          [folderId, teamId]
        );
      }
    } else if (team_ids && team_ids.length > 0) {
      // Verify user is member of all teams
      for (const teamId of team_ids) {
        const isMember = await queryOne(
          'SELECT * FROM team_members WHERE user_id = ? AND team_id = ? AND tenant_id = ?',
          [userId, teamId, tenantId]
        );
        if (!isMember) {
          return res.status(403).json({ error: `You are not a member of team ${teamId}` });
        }
        await execute(
          'INSERT INTO folder_team_shares (folder_id, team_id) VALUES (?, ?)',
          [folderId, teamId]
        );
      }
    }

    // Add user shares
    if (user_ids && user_ids.length > 0) {
      const filteredUserIds = user_ids.filter((uid: string) => uid !== userId);
      for (const shareUserId of filteredUserIds) {
        const user = await queryOne('SELECT id FROM users WHERE id = ?', [shareUserId]);
        if (!user) {
          return res.status(404).json({ error: `User ${shareUserId} not found` });
        }
        await execute(
          'INSERT INTO folder_user_shares (folder_id, user_id) VALUES (?, ?)',
          [folderId, shareUserId]
        );
      }
    }

    const folder = await queryOne('SELECT * FROM folders WHERE id = ? AND tenant_id = ?', [folderId, tenantId]);
    res.status(201).json(folder);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Update folder
router.put('/:id', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const tenantId = getTenantId(req);
    const { id } = req.params;
    const { name, icon } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const canModify = await canModifyFolder(userId, id, tenantId);
    if (!canModify) {
      return res.status(404).json({ error: 'Folder not found' });
    }
    const folder = await queryOne('SELECT * FROM folders WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    if (!folder) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    // Validate and sanitize name
    const nameValidation = validateLength(name, 'Name', 1, MAX_LENGTHS.folderName);
    if (!nameValidation.valid) {
      return res.status(400).json({ error: nameValidation.error });
    }
    const sanitizedName = sanitizeString(name);

    // Validate icon length if provided
    if (icon !== undefined && icon !== null) {
      const iconValidation = validateLength(icon, 'Icon', 0, MAX_LENGTHS.icon);
      if (!iconValidation.valid) {
        return res.status(400).json({ error: iconValidation.error });
      }
    }

    // Check if new name conflicts
    const existing = await queryOne('SELECT id FROM folders WHERE tenant_id = ? AND user_id = ? AND name = ? AND id != ?', [tenantId, userId, sanitizedName, id]);
    if (existing) {
      return res.status(400).json({ error: 'Folder with this name already exists' });
    }

    let { team_ids, user_ids, share_all_teams } = req.body;

    await execute('UPDATE folders SET name = ?, icon = ? WHERE id = ? AND tenant_id = ?', [sanitizedName, icon || null, id, tenantId]);

    // Update team shares if provided
    if (share_all_teams !== undefined || team_ids !== undefined) {
      await execute('DELETE FROM folder_team_shares WHERE folder_id = ?', [id]);
      if (share_all_teams) {
        const teamIds = await getTeamIdsForUser(userId, tenantId);
        for (const teamId of teamIds) {
          await execute(
            'INSERT INTO folder_team_shares (folder_id, team_id) VALUES (?, ?)',
            [id, teamId]
          );
        }
      } else if (team_ids && team_ids.length > 0) {
        // Verify user is member of all teams
        for (const teamId of team_ids) {
          const isMember = await queryOne(
            'SELECT * FROM team_members WHERE user_id = ? AND team_id = ? AND tenant_id = ?',
            [userId, teamId, tenantId]
          );
          if (!isMember) {
            return res.status(403).json({ error: `You are not a member of team ${teamId}` });
          }
          await execute(
            'INSERT INTO folder_team_shares (folder_id, team_id) VALUES (?, ?)',
            [id, teamId]
          );
        }
      }
    }

    // Update user shares if provided
    if (user_ids !== undefined) {
      await execute('DELETE FROM folder_user_shares WHERE folder_id = ?', [id]);
      if (user_ids.length > 0) {
        const filteredUserIds = user_ids.filter((uid: string) => uid !== userId);
        for (const shareUserId of filteredUserIds) {
          const user = await queryOne('SELECT id FROM users WHERE id = ?', [shareUserId]);
          if (!user) {
            return res.status(404).json({ error: `User ${shareUserId} not found` });
          }
          await execute(
            'INSERT INTO folder_user_shares (folder_id, user_id) VALUES (?, ?)',
            [id, shareUserId]
          );
        }
      }
    }

    const updated = await queryOne('SELECT * FROM folders WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Delete folder
router.delete('/:id', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const tenantId = getTenantId(req);
    const { id } = req.params;

    const canModify = await canModifyFolder(userId, id, tenantId);
    if (!canModify) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    await execute('DELETE FROM folders WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    res.json({ message: 'Folder deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
