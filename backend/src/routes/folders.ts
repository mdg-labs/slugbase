import { Router } from 'express';
import { query, queryOne, execute } from '../db/index.js';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { canAccessFolder, canModifyFolder } from '../auth/authorization.js';
import { v4 as uuidv4 } from 'uuid';
import { isCloud } from '../config/mode.js';
import { getCurrentOrgId, getUserPlan } from '../utils/organizations.js';
import { PLAN_ERRORS } from '../utils/plan-errors.js';
import { validateLength, sanitizeString, MAX_LENGTHS } from '../utils/validation.js';

const router = Router();
router.use(requireAuth());

/**
 * @swagger
 * /api/folders:
 *   get:
 *     summary: Get all folders
 *     description: Returns all folders for the authenticated user, including own folders and folders shared via teams or users.
 *     tags: [Folders]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of folders
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
 *                     example: "My Folder"
 *                   icon:
 *                     type: string
 *                     nullable: true
 *                     description: Lucide icon name
 *                     example: "Folder"
 *                   folder_type:
 *                     type: string
 *                     enum: [own, shared]
 *                     example: "own"
 *                   shared_teams:
 *                     type: array
 *                     items:
 *                       type: object
 *                   shared_users:
 *                     type: array
 *                     items:
 *                       type: object
 *       401:
 *         description: Unauthorized
 */
// Get all folders for user (own + shared)
router.get('/', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    
    // Get user's teams
    const userTeams = await query(
      'SELECT team_id FROM team_members WHERE user_id = ?',
      [userId]
    );
    const teamIds = Array.isArray(userTeams) ? userTeams.map((t: any) => t.team_id) : [];

    // Get own folders + shared folders (via users, teams, or folder shares)
    let sql = `
      SELECT DISTINCT f.*,
             CASE WHEN f.user_id = ? THEN 'own' ELSE 'shared' END as folder_type
      FROM folders f
      LEFT JOIN folder_user_shares fus ON f.id = fus.folder_id
      LEFT JOIN folder_team_shares fts ON f.id = fts.folder_id
      WHERE (f.user_id = ?
        OR fus.user_id = ?
        OR (fts.team_id IN (${teamIds.length > 0 ? teamIds.map(() => '?').join(',') : 'NULL'}) AND fts.team_id IS NOT NULL))
    `;
    const params: any[] = [userId, userId, userId];
    if (teamIds.length > 0) {
      params.push(...teamIds);
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

    const folders = await query(sql, params);

    // Get shared teams and users for each folder
    for (const folder of folders as any[]) {
      // Get owner info for shared folders
      if (folder.user_id !== userId) {
        const owner = await queryOne('SELECT id, name, email FROM users WHERE id = ?', [folder.user_id]);
        if (owner) {
          folder.user_name = owner.name;
          folder.user_email = owner.email;
        }
      }
      
      const sharedTeams = await query(
        `SELECT t.* FROM teams t
         INNER JOIN folder_team_shares fts ON t.id = fts.team_id
         WHERE fts.folder_id = ?`,
        [folder.id]
      );
      folder.shared_teams = Array.isArray(sharedTeams) ? sharedTeams : (sharedTeams ? [sharedTeams] : []);
      
      const sharedUsers = await query(
        `SELECT u.id, u.name, u.email FROM users u
         INNER JOIN folder_user_shares fus ON u.id = fus.user_id
         WHERE fus.folder_id = ?`,
        [folder.id]
      );
      folder.shared_users = Array.isArray(sharedUsers) ? sharedUsers : (sharedUsers ? [sharedUsers] : []);
    }

    res.json(folders);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/folders/{id}:
 *   get:
 *     summary: Get folder by ID
 *     description: Returns a single folder by ID. User must own the folder or have access via sharing.
 *     tags: [Folders]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Folder ID
 *         example: "123e4567-e89b-12d3-a456-426614174000"
 *     responses:
 *       200:
 *         description: Folder details
 *       404:
 *         description: Folder not found
 *       401:
 *         description: Unauthorized
 */
// Get single folder (own or shared)
router.get('/:id', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const { id } = req.params;

    const canAccess = await canAccessFolder(userId, id);
    if (!canAccess) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    const folder = await queryOne('SELECT * FROM folders WHERE id = ?', [id]);
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

/**
 * @swagger
 * /api/folders:
 *   post:
 *     summary: Create a new folder
 *     description: Creates a new folder. Can optionally share with teams or users.
 *     tags: [Folders]
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
 *                 example: "My New Folder"
 *               icon:
 *                 type: string
 *                 nullable: true
 *                 description: Lucide icon name (e.g., "Folder", "Archive", "Briefcase")
 *                 example: "Folder"
 *               team_ids:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of team IDs to share folder with
 *                 example: ["123e4567-e89b-12d3-a456-426614174000"]
 *               user_ids:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of user IDs to share folder with
 *                 example: ["123e4567-e89b-12d3-a456-426614174000"]
 *               share_all_teams:
 *                 type: boolean
 *                 default: false
 *                 description: Share folder with all teams user is a member of
 *                 example: false
 *     responses:
 *       201:
 *         description: Folder created successfully
 *       400:
 *         description: Missing name or folder with same name already exists
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: User is not member of team
 */
// Create folder
router.post('/', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
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
    const existing = await queryOne('SELECT id FROM folders WHERE user_id = ? AND name = ?', [userId, sanitizedName]);
    if (existing) {
      return res.status(400).json({ error: 'Folder with this name already exists' });
    }

    const folderId = uuidv4();
    let { team_ids, user_ids, share_all_teams } = req.body;

    // Cloud: Free/Personal cannot share folders
    if (isCloud) {
      const plan = await getUserPlan(userId);
      if (plan === 'free' || plan === 'personal') {
        if (share_all_teams || (team_ids && team_ids.length > 0) || (user_ids && user_ids.length > 0)) {
          return res.status(403).json({
            error: PLAN_ERRORS.FOLDER_SHARING.message,
            code: PLAN_ERRORS.FOLDER_SHARING.code,
          });
        }
      }
    }

    await execute('INSERT INTO folders (id, user_id, name, icon) VALUES (?, ?, ?, ?)', [folderId, userId, sanitizedName, icon || null]);

    // Add team shares
    if (share_all_teams) {
      const userTeams = await query(
        'SELECT team_id FROM team_members WHERE user_id = ?',
        [userId]
      );
      const teamIds = Array.isArray(userTeams) ? userTeams.map((t: any) => t.team_id) : [];
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
          'SELECT * FROM team_members WHERE user_id = ? AND team_id = ?',
          [userId, teamId]
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
      if (isCloud) {
        const orgId = await getCurrentOrgId(userId);
        if (!orgId) {
          return res.status(403).json({ error: 'No organization selected' });
        }
        for (const shareUserId of filteredUserIds) {
          const inOrg = await queryOne(
            'SELECT 1 FROM org_members WHERE user_id = ? AND org_id = ?',
            [shareUserId, orgId]
          );
          if (!inOrg) {
            return res.status(403).json({ error: 'One or more users are not in your organization' });
          }
        }
      }
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

    const folder = await queryOne('SELECT * FROM folders WHERE id = ?', [folderId]);
    res.status(201).json(folder);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/folders/{id}:
 *   put:
 *     summary: Update folder
 *     description: Updates an existing folder. User must own the folder.
 *     tags: [Folders]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Folder ID
 *         example: "123e4567-e89b-12d3-a456-426614174000"
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
 *                 example: "Updated Folder Name"
 *               icon:
 *                 type: string
 *                 nullable: true
 *                 example: "Archive"
 *               team_ids:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of team IDs (replaces existing shares)
 *               user_ids:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of user IDs (replaces existing shares)
 *               share_all_teams:
 *                 type: boolean
 *                 description: Share with all teams user is a member of
 *     responses:
 *       200:
 *         description: Folder updated successfully
 *       400:
 *         description: Missing name or folder with same name already exists
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Folder not found
 */
// Update folder
router.put('/:id', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const { id } = req.params;
    const { name, icon } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const canModify = await canModifyFolder(userId, id);
    if (!canModify) {
      return res.status(404).json({ error: 'Folder not found' });
    }
    const folder = await queryOne('SELECT * FROM folders WHERE id = ?', [id]);
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
    const existing = await queryOne('SELECT id FROM folders WHERE user_id = ? AND name = ? AND id != ?', [userId, sanitizedName, id]);
    if (existing) {
      return res.status(400).json({ error: 'Folder with this name already exists' });
    }

    let { team_ids, user_ids, share_all_teams } = req.body;

    // Cloud: Free/Personal - strip folder shares (allow editing name/icon)
    if (isCloud) {
      const plan = await getUserPlan(userId);
      if (plan === 'free' || plan === 'personal') {
        team_ids = [];
        user_ids = [];
        share_all_teams = false;
      }
    }

    await execute('UPDATE folders SET name = ?, icon = ? WHERE id = ?', [sanitizedName, icon || null, id]);

    // Update team shares if provided
    if (share_all_teams !== undefined || team_ids !== undefined) {
      await execute('DELETE FROM folder_team_shares WHERE folder_id = ?', [id]);
      if (share_all_teams) {
        const userTeams = await query(
          'SELECT team_id FROM team_members WHERE user_id = ?',
          [userId]
        );
        const teamIds = Array.isArray(userTeams) ? userTeams.map((t: any) => t.team_id) : [];
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
            'SELECT * FROM team_members WHERE user_id = ? AND team_id = ?',
            [userId, teamId]
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
        if (isCloud) {
          const orgId = await getCurrentOrgId(userId);
          if (!orgId) {
            return res.status(403).json({ error: 'No organization selected' });
          }
          for (const shareUserId of filteredUserIds) {
            const inOrg = await queryOne(
              'SELECT 1 FROM org_members WHERE user_id = ? AND org_id = ?',
              [shareUserId, orgId]
            );
            if (!inOrg) {
              return res.status(403).json({ error: 'One or more users are not in your organization' });
            }
          }
        }
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

    const updated = await queryOne('SELECT * FROM folders WHERE id = ?', [id]);
    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/folders/{id}:
 *   delete:
 *     summary: Delete folder
 *     description: Deletes a folder and all bookmarks within it. User must own the folder.
 *     tags: [Folders]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Folder ID
 *         example: "123e4567-e89b-12d3-a456-426614174000"
 *     responses:
 *       200:
 *         description: Folder deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Folder deleted"
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Folder not found
 */
// Delete folder
router.delete('/:id', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const { id } = req.params;

    const canModify = await canModifyFolder(userId, id);
    if (!canModify) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    await execute('DELETE FROM folders WHERE id = ?', [id]);
    res.json({ message: 'Folder deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
