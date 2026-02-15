import { Router } from 'express';
import { query, queryOne, execute } from '../db/index.js';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { canAccessBookmark, canModifyBookmark, canAccessFolder, canAccessTag, getTeamIdsForUser, getTeamIdsForUserInOrg } from '../auth/authorization.js';
import { v4 as uuidv4 } from 'uuid';
import { isCloud } from '../config/mode.js';
import { getCurrentOrgId, getUserPlan } from '../utils/organizations.js';
import { PLAN_ERRORS } from '../utils/plan-errors.js';
import { CreateBookmarkInput, UpdateBookmarkInput } from '../types.js';
import { validateUrl, validateSlug, validateLength, sanitizeString, MAX_LENGTHS } from '../utils/validation.js';

const router = Router();
router.use(requireAuth());

/**
 * @swagger
 * /api/bookmarks:
 *   get:
 *     summary: Get all bookmarks
 *     description: Returns all bookmarks for the authenticated user, including own bookmarks and bookmarks shared via teams or users. Supports filtering by folder and tag.
 *     tags: [Bookmarks]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: folder_id
 *         schema:
 *           type: string
 *         description: Filter bookmarks by folder ID
 *         example: "123e4567-e89b-12d3-a456-426614174000"
 *       - in: query
 *         name: tag_id
 *         schema:
 *           type: string
 *         description: Filter bookmarks by tag ID
 *         example: "123e4567-e89b-12d3-a456-426614174000"
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Max items per page (1-100)
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of items to skip
 *     responses:
 *       200:
 *         description: List of bookmarks
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
 *                   title:
 *                     type: string
 *                     example: "Example Bookmark"
 *                   url:
 *                     type: string
 *                     example: "https://example.com"
 *                   slug:
 *                     type: string
 *                     nullable: true
 *                     example: "example-slug"
 *                   forwarding_enabled:
 *                     type: boolean
 *                     example: true
 *                   bookmark_type:
 *                     type: string
 *                     enum: [own, shared]
 *                     example: "own"
 *                   folders:
 *                     type: array
 *                     items:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: string
 *                         name:
 *                           type: string
 *                         icon:
 *                           type: string
 *                           nullable: true
 *                   tags:
 *                     type: array
 *                     items:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: string
 *                         name:
 *                           type: string
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
// Get all bookmarks for user (including shared bookmarks)
router.get('/', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const orgId = isCloud ? await getCurrentOrgId(userId) : null;
    const { folder_id, tag_id, sort_by, limit: limitParam, offset: offsetParam } = req.query;

    // Pagination: default 50, max 100
    const limit = Math.min(100, Math.max(1, parseInt(String(limitParam), 10) || 50));
    const offset = Math.max(0, parseInt(String(offsetParam), 10) || 0);

    // Validate folder_id and tag_id so we don't leak other users' resources (IDOR)
    const folderIdStr = typeof folder_id === 'string' ? folder_id : undefined;
    const tagIdStr = typeof tag_id === 'string' ? tag_id : undefined;
    if (folderIdStr) {
      const canAccess = await canAccessFolder(userId, folderIdStr, orgId);
      if (!canAccess) {
        return res.status(404).json({ error: 'Folder not found' });
      }
    }
    if (tagIdStr) {
      const canAccess = await canAccessTag(userId, tagIdStr);
      if (!canAccess) {
        return res.status(404).json({ error: 'Tag not found' });
      }
    }

    // Get user's teams (org-scoped in cloud mode)
    const teamIds = orgId
      ? await getTeamIdsForUserInOrg(userId, orgId)
      : await getTeamIdsForUser(userId);

    // Build query for own bookmarks + shared bookmarks (directly shared with user, teams, or via shared folders)
    // In cloud mode, user shares (bus/fus) only count when owner is in same org
    const busCond = orgId ? '(bus.user_id = ? AND b.user_id IN (SELECT user_id FROM org_members WHERE org_id = ?))' : 'bus.user_id = ?';
    const fusCond = orgId ? '(fus.user_id = ? AND bf.folder_id IN (SELECT id FROM folders WHERE user_id IN (SELECT user_id FROM org_members WHERE org_id = ?)))' : 'fus.user_id = ?';
    let sql = `
      SELECT DISTINCT b.*,
             CASE WHEN b.user_id = ? THEN 'own' ELSE 'shared' END as bookmark_type
      FROM bookmarks b
      LEFT JOIN bookmark_user_shares bus ON b.id = bus.bookmark_id
      LEFT JOIN bookmark_team_shares bts ON b.id = bts.bookmark_id
      LEFT JOIN bookmark_folders bf ON b.id = bf.bookmark_id
      LEFT JOIN folder_user_shares fus ON bf.folder_id = fus.folder_id
      LEFT JOIN folder_team_shares fts ON bf.folder_id = fts.folder_id
      WHERE (b.user_id = ? 
        OR ${busCond}
        OR (bts.team_id IN (${teamIds.length > 0 ? teamIds.map(() => '?').join(',') : 'NULL'}) AND bts.team_id IS NOT NULL)
        OR ${fusCond}
        OR (fts.team_id IN (${teamIds.length > 0 ? teamIds.map(() => '?').join(',') : 'NULL'}) AND fts.team_id IS NOT NULL AND bf.folder_id IS NOT NULL))
    `;
    const params: any[] = [userId, userId];
    if (orgId) {
      params.push(userId, orgId, userId, orgId);
    } else {
      params.push(userId, userId);
    }
    if (teamIds.length > 0) {
      params.push(...teamIds);
      params.push(...teamIds); // Second set for folder shares
    }

    if (folderIdStr) {
      sql += ' AND b.id IN (SELECT bookmark_id FROM bookmark_folders WHERE folder_id = ?)';
      params.push(folderIdStr);
    }

    if (tagIdStr) {
      sql += `
        AND b.id IN (
          SELECT bookmark_id FROM bookmark_tags WHERE tag_id = ?
        )
      `;
      params.push(tagIdStr);
    }

    // Count query: same FROM/WHERE, no ORDER BY/LIMIT
    const countSql = `
      SELECT COUNT(DISTINCT b.id) as total
      FROM bookmarks b
      LEFT JOIN bookmark_user_shares bus ON b.id = bus.bookmark_id
      LEFT JOIN bookmark_team_shares bts ON b.id = bts.bookmark_id
      LEFT JOIN bookmark_folders bf ON b.id = bf.bookmark_id
      LEFT JOIN folder_user_shares fus ON bf.folder_id = fus.folder_id
      LEFT JOIN folder_team_shares fts ON bf.folder_id = fts.folder_id
      WHERE (b.user_id = ?
        OR ${busCond}
        OR (bts.team_id IN (${teamIds.length > 0 ? teamIds.map(() => '?').join(',') : 'NULL'}) AND bts.team_id IS NOT NULL)
        OR ${fusCond}
        OR (fts.team_id IN (${teamIds.length > 0 ? teamIds.map(() => '?').join(',') : 'NULL'}) AND fts.team_id IS NOT NULL AND bf.folder_id IS NOT NULL))
      ${folderIdStr ? 'AND b.id IN (SELECT bookmark_id FROM bookmark_folders WHERE folder_id = ?)' : ''}
      ${tagIdStr ? 'AND b.id IN (SELECT bookmark_id FROM bookmark_tags WHERE tag_id = ?)' : ''}
    `;
    const countParams = [userId];
    if (orgId) {
      countParams.push(userId, orgId, userId, orgId);
    } else {
      countParams.push(userId, userId);
    }
    if (teamIds.length > 0) {
      countParams.push(...teamIds, ...teamIds);
    }
    if (folderIdStr) countParams.push(folderIdStr);
    if (tagIdStr) countParams.push(tagIdStr);

    // Add sorting
    const sortBy = sort_by as string || 'recently_added';
    const DB_TYPE = process.env.DB_TYPE || 'sqlite';

    switch (sortBy) {
      case 'alphabetical':
        sql += ' ORDER BY b.title ASC';
        break;
      case 'most_used':
        sql += ' ORDER BY COALESCE(b.access_count, 0) DESC, b.created_at DESC';
        break;
      case 'recently_accessed':
        // SQLite doesn't support NULLS LAST, so use CASE to put NULLs at end
        if (DB_TYPE === 'postgresql') {
          sql += ' ORDER BY b.last_accessed_at DESC NULLS LAST, b.created_at DESC';
        } else {
          sql += ' ORDER BY CASE WHEN b.last_accessed_at IS NULL THEN 1 ELSE 0 END, b.last_accessed_at DESC, b.created_at DESC';
        }
        break;
      case 'recently_added':
      default:
        sql += ' ORDER BY b.created_at DESC';
        break;
    }

    // Fetch limit+1 to determine hasMore
    sql += ` LIMIT ? OFFSET ?`;
    params.push(limit + 1, offset);

    const [rawBookmarksResult, countResult] = await Promise.all([
      query(sql, params),
      query(countSql, countParams),
    ]);

    const rawBookmarks = rawBookmarksResult;
    const rawTotal = Array.isArray(countResult) && countResult[0] ? (countResult[0] as any).total : 0;
    const total = Number(rawTotal) || 0;
    const hasMore = Array.isArray(rawBookmarks) && rawBookmarks.length > limit;
    const bookmarks = hasMore ? rawBookmarks.slice(0, limit) : rawBookmarks;
    const bookmarkList = (Array.isArray(bookmarks) ? bookmarks : []) as any[];

    // Batch load related data (avoids N+1 queries)
    const bookmarkIds = bookmarkList.map((b) => b.id).filter(Boolean);
    if (bookmarkIds.length === 0) {
      return res.json({ items: bookmarks, total, hasMore });
    }

    // Placeholders for IN clause (SQLite limit ~999)
    const placeholders = bookmarkIds.map(() => '?').join(',');

    // 1. Batch fetch tags: bookmark_id -> tag[]
    const tagsRows = await query(
      `SELECT bt.bookmark_id, t.id, t.name, t.created_at FROM bookmark_tags bt
       INNER JOIN tags t ON bt.tag_id = t.id
       WHERE bt.bookmark_id IN (${placeholders})`,
      bookmarkIds
    );
    const tagsByBookmark = new Map<string, any[]>();
    for (const row of Array.isArray(tagsRows) ? tagsRows : []) {
      const bid = (row as any).bookmark_id;
      if (!bid) continue;
      const tag = { id: (row as any).id, name: (row as any).name, created_at: (row as any).created_at };
      if (!tagsByBookmark.has(bid)) tagsByBookmark.set(bid, []);
      tagsByBookmark.get(bid)!.push(tag);
    }

    // 2. Batch fetch bookmark_folders with folder details
    const bfRows = await query(
      `SELECT bf.bookmark_id, f.id, f.name, f.icon FROM bookmark_folders bf
       INNER JOIN folders f ON bf.folder_id = f.id
       WHERE bf.bookmark_id IN (${placeholders})`,
      bookmarkIds
    );
    const foldersByBookmark = new Map<string, any[]>();
    const folderIds = new Set<string>();
    for (const row of Array.isArray(bfRows) ? bfRows : []) {
      const r = row as any;
      const bid = r.bookmark_id;
      const fid = r.id;
      if (!bid || !fid) continue;
      folderIds.add(fid);
      const folder = { id: fid, name: r.name, icon: r.icon };
      if (!foldersByBookmark.has(bid)) foldersByBookmark.set(bid, []);
      foldersByBookmark.get(bid)!.push(folder);
    }

    // 3. Batch fetch folder sharing (folder_team_shares, folder_user_shares)
    const folderIdsArr = Array.from(folderIds);
    const folderPlaceholders = folderIdsArr.length > 0 ? folderIdsArr.map(() => '?').join(',') : '';
    let folderTeamsByFolder = new Map<string, any[]>();
    let folderUsersByFolder = new Map<string, any[]>();
    if (folderPlaceholders) {
      const ftsRows = await query(
        `SELECT fts.folder_id, t.id, t.name, t.description, t.created_at FROM folder_team_shares fts
         INNER JOIN teams t ON fts.team_id = t.id
         WHERE fts.folder_id IN (${folderPlaceholders})`,
        folderIdsArr
      );
      for (const row of Array.isArray(ftsRows) ? ftsRows : []) {
        const r = row as any;
        const fid = r.folder_id;
        if (!fid) continue;
        const team = { id: r.id, name: r.name, description: r.description, created_at: r.created_at };
        if (!folderTeamsByFolder.has(fid)) folderTeamsByFolder.set(fid, []);
        folderTeamsByFolder.get(fid)!.push(team);
      }
      const fusRows = await query(
        `SELECT fus.folder_id, u.id, u.name, u.email FROM folder_user_shares fus
         INNER JOIN users u ON fus.user_id = u.id
         WHERE fus.folder_id IN (${folderPlaceholders})`,
        folderIdsArr
      );
      for (const row of Array.isArray(fusRows) ? fusRows : []) {
        const r = row as any;
        const fid = r.folder_id;
        if (!fid) continue;
        const user = { id: r.id, name: r.name, email: r.email };
        if (!folderUsersByFolder.has(fid)) folderUsersByFolder.set(fid, []);
        folderUsersByFolder.get(fid)!.push(user);
      }
    }

    // 4. Batch fetch bookmark sharing (bookmark_team_shares, bookmark_user_shares)
    const btsRows = await query(
      `SELECT bts.bookmark_id, t.id, t.name, t.description, t.created_at FROM bookmark_team_shares bts
       INNER JOIN teams t ON bts.team_id = t.id
       WHERE bts.bookmark_id IN (${placeholders})`,
      bookmarkIds
    );
    const bookmarkTeamsByBookmark = new Map<string, any[]>();
    for (const row of Array.isArray(btsRows) ? btsRows : []) {
      const r = row as any;
      const bid = r.bookmark_id;
      if (!bid) continue;
      const team = { id: r.id, name: r.name, description: r.description, created_at: r.created_at };
      if (!bookmarkTeamsByBookmark.has(bid)) bookmarkTeamsByBookmark.set(bid, []);
      bookmarkTeamsByBookmark.get(bid)!.push(team);
    }
    const busRows = await query(
      `SELECT bus.bookmark_id, u.id, u.name, u.email FROM bookmark_user_shares bus
       INNER JOIN users u ON bus.user_id = u.id
       WHERE bus.bookmark_id IN (${placeholders})`,
      bookmarkIds
    );
    const bookmarkUsersByBookmark = new Map<string, any[]>();
    for (const row of Array.isArray(busRows) ? busRows : []) {
      const r = row as any;
      const bid = r.bookmark_id;
      if (!bid) continue;
      const user = { id: r.id, name: r.name, email: r.email };
      if (!bookmarkUsersByBookmark.has(bid)) bookmarkUsersByBookmark.set(bid, []);
      bookmarkUsersByBookmark.get(bid)!.push(user);
    }

    // 5. Batch fetch owner info for shared bookmarks
    const ownerIds = [...new Set(bookmarkList.filter((b) => b.user_id !== userId).map((b) => b.user_id))];
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

    // 6. Assemble bookmarks with related data
    for (const bookmark of bookmarkList) {
      bookmark.forwarding_enabled = Boolean(bookmark.forwarding_enabled);
      bookmark.pinned = Boolean(bookmark.pinned || false);
      bookmark.access_count = bookmark.access_count || 0;
      if (!bookmark.slug || bookmark.slug.startsWith('_internal_')) {
        bookmark.slug = '';
      }
      if (bookmark.user_id !== userId) {
        const owner = ownersById.get(bookmark.user_id);
        if (owner) {
          bookmark.user_name = owner.name;
          bookmark.user_email = owner.email;
        }
      }
      bookmark.tags = tagsByBookmark.get(bookmark.id) || [];
      const foldersList = foldersByBookmark.get(bookmark.id) || [];
      for (const folder of foldersList) {
        folder.shared_teams = folderTeamsByFolder.get(folder.id) || [];
        folder.shared_users = folderUsersByFolder.get(folder.id) || [];
      }
      bookmark.folders = foldersList;
      bookmark.shared_teams = bookmarkTeamsByBookmark.get(bookmark.id) || [];
      bookmark.shared_users = bookmarkUsersByBookmark.get(bookmark.id) || [];
    }

    res.json({
      items: bookmarks,
      total,
      hasMore,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/bookmarks/{id}:
 *   get:
 *     summary: Get bookmark by ID
 *     description: Returns a single bookmark by ID. User must own the bookmark or have access via sharing.
 *     tags: [Bookmarks]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Bookmark ID
 *         example: "123e4567-e89b-12d3-a456-426614174000"
 *     responses:
 *       200:
 *         description: Bookmark details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                 title:
 *                   type: string
 *                 url:
 *                   type: string
 *                 slug:
 *                   type: string
 *                   nullable: true
 *                 forwarding_enabled:
 *                   type: boolean
 *                 folders:
 *                   type: array
 *                 tags:
 *                   type: array
 *                 shared_teams:
 *                   type: array
 *                 shared_users:
 *                   type: array
 *       404:
 *         description: Bookmark not found
 *       401:
 *         description: Unauthorized
 */
/**
 * @swagger
 * /api/bookmarks/search:
 *   get:
 *     summary: Search bookmarks, folders, and tags
 *     description: Global search across bookmarks, folders, and tags
 *     tags: [Bookmarks]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema:
 *           type: string
 *         description: Search query
 *     responses:
 *       200:
 *         description: Search results
 *       401:
 *         description: Unauthorized
 */
// Search endpoint (must be before /:id route)
router.get('/search', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const orgId = isCloud ? await getCurrentOrgId(userId) : null;
    const { q } = req.query;

    if (!q || typeof q !== 'string') {
      return res.status(400).json({ error: 'Search query is required' });
    }

    const searchTerm = `%${q.toLowerCase()}%`;

    // Get user's teams for share checks (org-scoped in cloud mode)
    const teamIds = orgId
      ? await getTeamIdsForUserInOrg(userId, orgId)
      : await getTeamIdsForUser(userId);
    const teamPlaceholders = teamIds.length > 0 ? teamIds.map(() => '?').join(',') : 'NULL';
    const busCond = orgId ? '(bus.user_id = ? AND b.user_id IN (SELECT user_id FROM org_members WHERE org_id = ?))' : 'bus.user_id = ?';
    const fusCond = orgId ? '(fus.user_id = ? AND bf.folder_id IN (SELECT id FROM folders WHERE user_id IN (SELECT user_id FROM org_members WHERE org_id = ?)))' : 'fus.user_id = ?';

    // Search bookmarks (same access as GET /: own + user share + team share + folder-based sharing)
    const bookmarkSql = `
      SELECT DISTINCT b.*, 'bookmark' as type,
             CASE WHEN b.user_id = ? THEN 'own' ELSE 'shared' END as bookmark_type
      FROM bookmarks b
      LEFT JOIN bookmark_user_shares bus ON b.id = bus.bookmark_id
      LEFT JOIN bookmark_team_shares bts ON b.id = bts.bookmark_id
      LEFT JOIN bookmark_folders bf ON b.id = bf.bookmark_id
      LEFT JOIN folder_user_shares fus ON bf.folder_id = fus.folder_id
      LEFT JOIN folder_team_shares fts ON bf.folder_id = fts.folder_id
      WHERE (b.user_id = ? OR ${busCond}
        OR (bts.team_id IN (${teamPlaceholders}) AND bts.team_id IS NOT NULL)
        OR ${fusCond}
        OR (fts.team_id IN (${teamPlaceholders}) AND fts.team_id IS NOT NULL AND bf.folder_id IS NOT NULL))
      AND (LOWER(b.title) LIKE ? OR LOWER(b.url) LIKE ? OR LOWER(COALESCE(b.slug, '')) LIKE ?)
      LIMIT 10
    `;
    const bookmarkParams: any[] = [userId, userId];
    if (orgId) {
      bookmarkParams.push(userId, orgId, userId, orgId);
    } else {
      bookmarkParams.push(userId, userId);
    }
    if (teamIds.length > 0) {
      bookmarkParams.push(...teamIds);
      bookmarkParams.push(...teamIds);
    }
    bookmarkParams.push(searchTerm, searchTerm, searchTerm);
    const bookmarkResults = await query(bookmarkSql, bookmarkParams);

    // Search folders (same access as GET /folders: own + shared via user/team)
    const folderFusCond = orgId ? '(fus.user_id = ? AND f.user_id IN (SELECT user_id FROM org_members WHERE org_id = ?))' : 'fus.user_id = ?';
    const folderSql = `
      SELECT DISTINCT f.*, 'folder' as type
      FROM folders f
      LEFT JOIN folder_user_shares fus ON f.id = fus.folder_id
      LEFT JOIN folder_team_shares fts ON f.id = fts.folder_id
      WHERE (f.user_id = ? OR ${folderFusCond}
        OR (fts.team_id IN (${teamPlaceholders}) AND fts.team_id IS NOT NULL))
      AND LOWER(f.name) LIKE ?
      LIMIT 5
    `;
    const folderParams: any[] = [userId];
    if (orgId) {
      folderParams.push(userId, orgId);
    } else {
      folderParams.push(userId);
    }
    if (teamIds.length > 0) folderParams.push(...teamIds);
    folderParams.push(searchTerm);
    const folderResults = await query(folderSql, folderParams);

    // Search tags
    const tagResults = await query(
      `SELECT t.*, 'tag' as type
       FROM tags t
       WHERE t.user_id = ? AND LOWER(t.name) LIKE ?
       LIMIT 5`,
      [userId, searchTerm]
    );

    // Process results
    const results = [
      ...bookmarkResults.map((b: any) => ({
        id: b.id,
        type: 'bookmark',
        title: b.title,
        url: b.url,
        slug: b.slug || '',
        forwarding_enabled: Boolean(b.forwarding_enabled),
      })),
      ...folderResults.map((f: any) => ({
        id: f.id,
        type: 'folder',
        title: f.name,
        icon: f.icon,
      })),
      ...tagResults.map((t: any) => ({
        id: t.id,
        type: 'tag',
        title: t.name,
      })),
    ];

    res.json(results);
  } catch (error: any) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

/**
 * @swagger
 * /api/bookmarks/export:
 *   get:
 *     summary: Export bookmarks as JSON
 *     description: Export all user's bookmarks as JSON
 *     tags: [Bookmarks]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: JSON export of bookmarks
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *       401:
 *         description: Unauthorized
 */
// Export bookmarks as JSON (must be before /:id route)
router.get('/export', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const orgId = isCloud ? await getCurrentOrgId(userId) : null;

    // Get all bookmarks (same access as GET /: own + user share + team share + folder-based sharing)
    const teamIds = orgId
      ? await getTeamIdsForUserInOrg(userId, orgId)
      : await getTeamIdsForUser(userId);
    const teamPlaceholders = teamIds.length > 0 ? teamIds.map(() => '?').join(',') : 'NULL';
    const busCond = orgId ? '(bus.user_id = ? AND b.user_id IN (SELECT user_id FROM org_members WHERE org_id = ?))' : 'bus.user_id = ?';
    const fusCond = orgId ? '(fus.user_id = ? AND bf.folder_id IN (SELECT id FROM folders WHERE user_id IN (SELECT user_id FROM org_members WHERE org_id = ?)))' : 'fus.user_id = ?';
    const exportSql = `
      SELECT DISTINCT b.*,
             CASE WHEN b.user_id = ? THEN 'own' ELSE 'shared' END as bookmark_type
      FROM bookmarks b
      LEFT JOIN bookmark_user_shares bus ON b.id = bus.bookmark_id
      LEFT JOIN bookmark_team_shares bts ON b.id = bts.bookmark_id
      LEFT JOIN bookmark_folders bf ON b.id = bf.bookmark_id
      LEFT JOIN folder_user_shares fus ON bf.folder_id = fus.folder_id
      LEFT JOIN folder_team_shares fts ON bf.folder_id = fts.folder_id
      WHERE (b.user_id = ? OR ${busCond}
        OR (bts.team_id IN (${teamPlaceholders}) AND bts.team_id IS NOT NULL)
        OR ${fusCond}
        OR (fts.team_id IN (${teamPlaceholders}) AND fts.team_id IS NOT NULL AND bf.folder_id IS NOT NULL))
      ORDER BY b.created_at DESC
    `;
    const exportParams: any[] = [userId, userId];
    if (orgId) {
      exportParams.push(userId, orgId, userId, orgId);
    } else {
      exportParams.push(userId, userId);
    }
    if (teamIds.length > 0) {
      exportParams.push(...teamIds);
      exportParams.push(...teamIds);
    }
    const bookmarks = await query(exportSql, exportParams);

    // Process bookmarks (simplified - no folders/tags for export)
    const exportData = bookmarks.map((b: any) => ({
      title: b.title,
      url: b.url,
      slug: b.slug || '',
      forwarding_enabled: Boolean(b.forwarding_enabled),
      pinned: Boolean(b.pinned || false),
      created_at: b.created_at,
    }));

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="slugbase-bookmarks-${new Date().toISOString().split('T')[0]}.json"`);
    res.json(exportData);
  } catch (error: any) {
    console.error('Export error:', error);
    res.status(500).json({ error: 'Export failed' });
  }
});

// Get bookmark IDs only (for select-all-across-pages) - must be before /:id route
router.get('/ids', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const orgId = isCloud ? await getCurrentOrgId(userId) : null;
    const { folder_id, tag_id, sort_by } = req.query;

    const folderIdStr = typeof folder_id === 'string' ? folder_id : undefined;
    const tagIdStr = typeof tag_id === 'string' ? tag_id : undefined;
    if (folderIdStr) {
      const canAccess = await canAccessFolder(userId, folderIdStr, orgId);
      if (!canAccess) {
        return res.status(404).json({ error: 'Folder not found' });
      }
    }
    if (tagIdStr) {
      const canAccess = await canAccessTag(userId, tagIdStr);
      if (!canAccess) {
        return res.status(404).json({ error: 'Tag not found' });
      }
    }

    const teamIds = orgId
      ? await getTeamIdsForUserInOrg(userId, orgId)
      : await getTeamIdsForUser(userId);

    const busCond = orgId ? '(bus.user_id = ? AND b.user_id IN (SELECT user_id FROM org_members WHERE org_id = ?))' : 'bus.user_id = ?';
    const fusCond = orgId ? '(fus.user_id = ? AND bf.folder_id IN (SELECT id FROM folders WHERE user_id IN (SELECT user_id FROM org_members WHERE org_id = ?)))' : 'fus.user_id = ?';
    let idsSql = `
      SELECT DISTINCT b.id
      FROM bookmarks b
      LEFT JOIN bookmark_user_shares bus ON b.id = bus.bookmark_id
      LEFT JOIN bookmark_team_shares bts ON b.id = bts.bookmark_id
      LEFT JOIN bookmark_folders bf ON b.id = bf.bookmark_id
      LEFT JOIN folder_user_shares fus ON bf.folder_id = fus.folder_id
      LEFT JOIN folder_team_shares fts ON bf.folder_id = fts.folder_id
      WHERE (b.user_id = ?
        OR ${busCond}
        OR (bts.team_id IN (${teamIds.length > 0 ? teamIds.map(() => '?').join(',') : 'NULL'}) AND bts.team_id IS NOT NULL)
        OR ${fusCond}
        OR (fts.team_id IN (${teamIds.length > 0 ? teamIds.map(() => '?').join(',') : 'NULL'}) AND fts.team_id IS NOT NULL AND bf.folder_id IS NOT NULL))
    `;
    const idsParams: any[] = [userId];
    if (orgId) {
      idsParams.push(userId, orgId, userId, orgId);
    } else {
      idsParams.push(userId, userId);
    }
    if (teamIds.length > 0) {
      idsParams.push(...teamIds);
      idsParams.push(...teamIds);
    }
    if (folderIdStr) {
      idsSql += ' AND b.id IN (SELECT bookmark_id FROM bookmark_folders WHERE folder_id = ?)';
      idsParams.push(folderIdStr);
    }
    if (tagIdStr) {
      idsSql += ' AND b.id IN (SELECT bookmark_id FROM bookmark_tags WHERE tag_id = ?)';
      idsParams.push(tagIdStr);
    }

    const sortBy = sort_by as string || 'recently_added';
    const DB_TYPE = process.env.DB_TYPE || 'sqlite';
    switch (sortBy) {
      case 'alphabetical':
        idsSql += ' ORDER BY b.title ASC';
        break;
      case 'most_used':
        idsSql += ' ORDER BY COALESCE(b.access_count, 0) DESC, b.created_at DESC';
        break;
      case 'recently_accessed':
        if (DB_TYPE === 'postgresql') {
          idsSql += ' ORDER BY b.last_accessed_at DESC NULLS LAST, b.created_at DESC';
        } else {
          idsSql += ' ORDER BY CASE WHEN b.last_accessed_at IS NULL THEN 1 ELSE 0 END, b.last_accessed_at DESC, b.created_at DESC';
        }
        break;
      default:
        idsSql += ' ORDER BY b.created_at DESC';
        break;
    }

    idsSql += ' LIMIT 10000';
    const rows = await query(idsSql, idsParams);
    const ids = (Array.isArray(rows) ? rows : [])
      .map((r: any) => r?.id)
      .filter(Boolean);

    res.json({ ids });
  } catch (error: any) {
    console.error('Bookmark IDs fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch bookmark IDs' });
  }
});

// Get single bookmark (own or shared) - must be after /export and /search routes
router.get('/:id', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const orgId = isCloud ? await getCurrentOrgId(userId) : null;
    const { id } = req.params;

    const canAccess = await canAccessBookmark(userId, id, orgId);
    if (!canAccess) {
      return res.status(404).json({ error: 'Bookmark not found' });
    }

    const bookmark = await queryOne('SELECT * FROM bookmarks WHERE id = ?', [id]);
    if (!bookmark) {
      return res.status(404).json({ error: 'Bookmark not found' });
    }

    // Convert boolean fields from SQLite (0/1) to boolean
    bookmark.forwarding_enabled = Boolean(bookmark.forwarding_enabled);
    bookmark.pinned = Boolean(bookmark.pinned || false);
    bookmark.access_count = bookmark.access_count || 0;
    // Convert null slug to empty string for frontend
    if (!bookmark.slug) {
      bookmark.slug = '';
    }

    const tags = await query(
      `SELECT t.* FROM tags t
       INNER JOIN bookmark_tags bt ON t.id = bt.tag_id
       WHERE bt.bookmark_id = ?`,
      [id]
    );

    // Get folders for this bookmark (including icon and sharing info)
    const bookmarkFolders = await query(
      `SELECT f.id, f.name, f.icon FROM folders f
       INNER JOIN bookmark_folders bf ON f.id = bf.folder_id
       WHERE bf.bookmark_id = ?`,
      [id]
    );
    const foldersList = Array.isArray(bookmarkFolders) ? bookmarkFolders : (bookmarkFolders ? [bookmarkFolders] : []);
    
    // Get sharing information for each folder
    for (const folder of foldersList as any[]) {
      const folderSharedTeams = await query(
        `SELECT t.* FROM teams t
         INNER JOIN folder_team_shares fts ON t.id = fts.team_id
         WHERE fts.folder_id = ?`,
        [folder.id]
      );
      folder.shared_teams = Array.isArray(folderSharedTeams) ? folderSharedTeams : (folderSharedTeams ? [folderSharedTeams] : []);
      
      const folderSharedUsers = await query(
        `SELECT u.id, u.name, u.email FROM users u
         INNER JOIN folder_user_shares fus ON u.id = fus.user_id
         WHERE fus.folder_id = ?`,
        [folder.id]
      );
      folder.shared_users = Array.isArray(folderSharedUsers) ? folderSharedUsers : (folderSharedUsers ? [folderSharedUsers] : []);
    }

    // Get shared teams for this bookmark
    const sharedTeams = await query(
      `SELECT t.* FROM teams t
       INNER JOIN bookmark_team_shares bts ON t.id = bts.team_id
       WHERE bts.bookmark_id = ?`,
      [id]
    );

    // Get shared users for this bookmark
    const sharedUsers = await query(
      `SELECT u.id, u.name, u.email FROM users u
       INNER JOIN bookmark_user_shares bus ON u.id = bus.user_id
       WHERE bus.bookmark_id = ?`,
      [id]
    );

    (bookmark as any).tags = tags;
    (bookmark as any).folders = foldersList;
    (bookmark as any).shared_teams = Array.isArray(sharedTeams) ? sharedTeams : (sharedTeams ? [sharedTeams] : []);
    (bookmark as any).shared_users = Array.isArray(sharedUsers) ? sharedUsers : (sharedUsers ? [sharedUsers] : []);

    res.json(bookmark);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/bookmarks/{id}/track-access:
 *   post:
 *     summary: Track bookmark access
 *     description: Increments access_count and updates last_accessed_at for a bookmark when it is opened
 *     tags: [Bookmarks]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Bookmark ID
 *     responses:
 *       200:
 *         description: Access tracked successfully
 *       404:
 *         description: Bookmark not found
 *       401:
 *         description: Unauthorized
 */
// Track bookmark access (must be before PUT /:id)
router.post('/:id/track-access', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const orgId = isCloud ? await getCurrentOrgId(userId) : null;
    const { id } = req.params;

    const canAccess = await canAccessBookmark(userId, id, orgId);
    if (!canAccess) {
      return res.status(404).json({ error: 'Bookmark not found' });
    }

    // Update access_count and last_accessed_at
    await execute(
      `UPDATE bookmarks 
       SET access_count = COALESCE(access_count, 0) + 1,
           last_accessed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [id]
    );

    res.json({ success: true });
  } catch (error: any) {
    console.error('Failed to track bookmark access:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/bookmarks:
 *   post:
 *     summary: Create a new bookmark
 *     description: Creates a new bookmark. Slug is required only if forwarding is enabled. Can assign to multiple folders, tags, and share with users/teams.
 *     tags: [Bookmarks]
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
 *               - title
 *               - url
 *             properties:
 *               title:
 *                 type: string
 *                 example: "Example Bookmark"
 *               url:
 *                 type: string
 *                 format: uri
 *                 example: "https://example.com"
 *               slug:
 *                 type: string
 *                 nullable: true
 *                 description: Required if forwarding_enabled is true, optional otherwise
 *                 example: "example-slug"
 *               forwarding_enabled:
 *                 type: boolean
 *                 default: false
 *                 example: true
 *               folder_ids:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of folder IDs to assign bookmark to
 *                 example: ["123e4567-e89b-12d3-a456-426614174000"]
 *               tag_ids:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of tag IDs to assign to bookmark
 *                 example: ["123e4567-e89b-12d3-a456-426614174000"]
 *               team_ids:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of team IDs to share bookmark with
 *                 example: ["123e4567-e89b-12d3-a456-426614174000"]
 *               user_ids:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of user IDs to share bookmark with
 *                 example: ["123e4567-e89b-12d3-a456-426614174000"]
 *               share_all_teams:
 *                 type: boolean
 *                 default: false
 *                 description: Share bookmark with all teams user is a member of
 *                 example: false
 *     responses:
 *       201:
 *         description: Bookmark created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                 title:
 *                   type: string
 *                 url:
 *                   type: string
 *                 slug:
 *                   type: string
 *                   nullable: true
 *                 forwarding_enabled:
 *                   type: boolean
 *       400:
 *         description: Missing required fields, slug required when forwarding enabled, or slug already exists
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: User does not own folder or is not member of team
 */
const FREE_BOOKMARK_LIMIT = 100;

// Create bookmark
router.post('/', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const orgId = isCloud ? await getCurrentOrgId(userId) : null;
    const data: CreateBookmarkInput = req.body;

    if (!data.title || !data.url) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Cloud: enforce Free plan bookmark limit
    if (isCloud) {
      const plan = await getUserPlan(userId);
      if (plan === 'free') {
        const countResult = await queryOne('SELECT COUNT(*) as count FROM bookmarks WHERE user_id = ?', [userId]);
        const count = countResult ? parseInt((countResult as any).count) : 0;
        if (count >= FREE_BOOKMARK_LIMIT) {
          return res.status(403).json({
            error: PLAN_ERRORS.BOOKMARK_LIMIT.message,
            code: PLAN_ERRORS.BOOKMARK_LIMIT.code,
          });
        }
      }
      // Cloud: Free/Personal cannot share to teams
      if (plan === 'free' || plan === 'personal') {
        if (data.share_all_teams || (data.team_ids && data.team_ids.length > 0)) {
          return res.status(403).json({
            error: PLAN_ERRORS.SHARE_TO_TEAM.message,
            code: PLAN_ERRORS.SHARE_TO_TEAM.code,
          });
        }
      }
    }

    // Validate and sanitize title
    const titleValidation = validateLength(data.title, 'Title', 1, MAX_LENGTHS.title);
    if (!titleValidation.valid) {
      return res.status(400).json({ error: titleValidation.error });
    }
    const sanitizedTitle = sanitizeString(data.title);

    // Validate URL
    const urlValidation = validateUrl(data.url);
    if (!urlValidation.valid) {
      return res.status(400).json({ error: urlValidation.error });
    }

    // Slug is required only if forwarding is enabled
    if (data.forwarding_enabled && !data.slug) {
      return res.status(400).json({ error: 'Slug is required when forwarding is enabled' });
    }

    // Slug can be null/empty if forwarding is disabled
    let slug = data.slug && data.slug.trim() ? data.slug.trim() : null;
    
    // Validate slug format if provided
    if (slug) {
      const slugValidation = validateSlug(slug);
      if (!slugValidation.valid) {
        return res.status(400).json({ error: slugValidation.error });
      }
      
      // Check if slug is globally unique (required for shared bookmark forwarding)
      const existing = await queryOne(
        'SELECT id FROM bookmarks WHERE slug = ?',
        [slug]
      );

      if (existing) {
        return res.status(400).json({ error: 'Slug already exists. Slugs must be unique across all bookmarks.' });
      }
    }

    const bookmarkId = uuidv4();
    await execute(
      `INSERT INTO bookmarks (id, user_id, title, url, slug, forwarding_enabled, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [bookmarkId, userId, sanitizedTitle, data.url, slug, data.forwarding_enabled || false, Boolean((data as any).pinned || false)]
    );

    // Add folders
    if (data.folder_ids && data.folder_ids.length > 0) {
      // Verify user owns all folders
      for (const folderId of data.folder_ids) {
        const folder = await queryOne('SELECT * FROM folders WHERE id = ? AND user_id = ?', [folderId, userId]);
        if (!folder) {
          return res.status(403).json({ error: `You do not own folder ${folderId}` });
        }
        await execute(
          'INSERT INTO bookmark_folders (bookmark_id, folder_id) VALUES (?, ?)',
          [bookmarkId, folderId]
        );
      }
    }

    // Add tags (L1: verify user owns each tag)
    if (data.tag_ids && data.tag_ids.length > 0) {
      for (const tagId of data.tag_ids) {
        const canAccess = await canAccessTag(userId, tagId);
        if (!canAccess) {
          return res.status(403).json({ error: 'You do not have access to one or more of the selected tags' });
        }
        await execute(
          'INSERT INTO bookmark_tags (bookmark_id, tag_id) VALUES (?, ?)',
          [bookmarkId, tagId]
        );
      }
    }

    // Add team shares
    if (data.share_all_teams) {
      // Share with all teams user is a member of (org-scoped in cloud mode)
      const teamIds = orgId
        ? await getTeamIdsForUserInOrg(userId, orgId)
        : await getTeamIdsForUser(userId);
      for (const teamId of teamIds) {
        await execute(
          'INSERT INTO bookmark_team_shares (bookmark_id, team_id) VALUES (?, ?)',
          [bookmarkId, teamId]
        );
      }
    } else if (data.team_ids && data.team_ids.length > 0) {
      // Verify user is member of all teams (and team is in org in cloud mode)
      for (const teamId of data.team_ids) {
        const isMember = await queryOne(
          'SELECT * FROM team_members WHERE user_id = ? AND team_id = ?',
          [userId, teamId]
        );
        if (!isMember) {
          return res.status(403).json({ error: `You are not a member of team ${teamId}` });
        }
        if (orgId) {
          const teamInOrg = await queryOne('SELECT 1 FROM teams WHERE id = ? AND org_id = ?', [teamId, orgId]);
          if (!teamInOrg) {
            return res.status(403).json({ error: `Team ${teamId} is not in your organization` });
          }
        }
        await execute(
          'INSERT INTO bookmark_team_shares (bookmark_id, team_id) VALUES (?, ?)',
          [bookmarkId, teamId]
        );
      }
    }

    // Add user shares
    if (data.user_ids && data.user_ids.length > 0) {
      // Don't allow sharing with self
      const filteredUserIds = data.user_ids.filter((uid) => uid !== userId);
      if (isCloud) {
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
        // Verify user exists
        const user = await queryOne('SELECT id FROM users WHERE id = ?', [shareUserId]);
        if (!user) {
          return res.status(404).json({ error: `User ${shareUserId} not found` });
        }
        await execute(
          'INSERT INTO bookmark_user_shares (bookmark_id, user_id) VALUES (?, ?)',
          [bookmarkId, shareUserId]
        );
      }
    }

    const bookmark = await queryOne('SELECT * FROM bookmarks WHERE id = ?', [bookmarkId]);
    // Convert boolean fields from SQLite (0/1) to boolean
    bookmark.forwarding_enabled = Boolean(bookmark.forwarding_enabled);
    // Return null as empty string for frontend
    if (!bookmark.slug) {
      bookmark.slug = '';
    }
    res.status(201).json(bookmark);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/bookmarks/{id}:
 *   put:
 *     summary: Update bookmark
 *     description: Updates an existing bookmark. User must own the bookmark. All fields are optional.
 *     tags: [Bookmarks]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Bookmark ID
 *         example: "123e4567-e89b-12d3-a456-426614174000"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title:
 *                 type: string
 *                 example: "Updated Bookmark Title"
 *               url:
 *                 type: string
 *                 format: uri
 *                 example: "https://updated-example.com"
 *               slug:
 *                 type: string
 *                 nullable: true
 *                 description: Required if forwarding_enabled is true
 *                 example: "updated-slug"
 *               forwarding_enabled:
 *                 type: boolean
 *                 example: true
 *               folder_ids:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of folder IDs (replaces existing assignments)
 *               tag_ids:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of tag IDs (replaces existing assignments)
 *               team_ids:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of team IDs to share with (replaces existing shares)
 *               user_ids:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of user IDs to share with (replaces existing shares)
 *               share_all_teams:
 *                 type: boolean
 *                 description: Share with all teams user is a member of
 *     responses:
 *       200:
 *         description: Bookmark updated successfully
 *       400:
 *         description: Slug required when forwarding enabled or slug already exists
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: User does not own folder or is not member of team
 *       404:
 *         description: Bookmark not found
 */
// Update bookmark
router.put('/:id', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const orgId = isCloud ? await getCurrentOrgId(userId) : null;
    const { id } = req.params;
    const data: UpdateBookmarkInput = req.body;

    const canModify = await canModifyBookmark(userId, id);
    if (!canModify) {
      return res.status(404).json({ error: 'Bookmark not found' });
    }
    const existing = await queryOne('SELECT * FROM bookmarks WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Bookmark not found' });
    }

    // Cloud: Free/Personal cannot share to teams
    if (isCloud) {
      const plan = await getUserPlan(userId);
      if (plan === 'free' || plan === 'personal') {
        if (data.share_all_teams || (data.team_ids && data.team_ids.length > 0)) {
          return res.status(403).json({
            error: PLAN_ERRORS.SHARE_TO_TEAM.message,
            code: PLAN_ERRORS.SHARE_TO_TEAM.code,
          });
        }
      }
    }

    // Slug validation
    if (data.forwarding_enabled && !data.slug) {
      return res.status(400).json({ error: 'Slug is required when forwarding is enabled' });
    }

    // Check slug uniqueness if changed
    if (data.slug !== undefined && data.slug !== (existing as any).slug) {
      // If slug is being set/changed, check uniqueness (only if slug is provided)
      const newSlug = data.slug && data.slug.trim() ? data.slug.trim() : null;
      if (newSlug) {
        // Validate slug format
        const slugValidation = validateSlug(newSlug);
        if (!slugValidation.valid) {
          return res.status(400).json({ error: slugValidation.error });
        }
        
        const slugExists = await queryOne(
          'SELECT id FROM bookmarks WHERE slug = ? AND id != ?',
          [newSlug, id]
        );
        if (slugExists) {
          return res.status(400).json({ error: 'Slug already exists. Slugs must be unique across all bookmarks.' });
        }
      }
    }

    // Validate and sanitize title if provided
    let sanitizedTitle = data.title;
    if (data.title !== undefined) {
      const titleValidation = validateLength(data.title, 'Title', 1, MAX_LENGTHS.title);
      if (!titleValidation.valid) {
        return res.status(400).json({ error: titleValidation.error });
      }
      sanitizedTitle = sanitizeString(data.title);
    }

    // Validate URL if provided
    if (data.url !== undefined) {
      const urlValidation = validateUrl(data.url);
      if (!urlValidation.valid) {
        return res.status(400).json({ error: urlValidation.error });
      }
    }

    // Update bookmark
    const updates: string[] = [];
    const params: any[] = [];

    if (data.title !== undefined) {
      updates.push('title = ?');
      params.push(sanitizedTitle);
    }
    if (data.url !== undefined) {
      updates.push('url = ?');
      params.push(data.url);
    }
    if (data.slug !== undefined) {
      // Store null if slug is empty/whitespace, otherwise store the trimmed slug
      const dbSlug = data.slug && data.slug.trim() ? data.slug.trim() : null;
      updates.push('slug = ?');
      params.push(dbSlug);
    }
    if (data.forwarding_enabled !== undefined) {
      updates.push('forwarding_enabled = ?');
      params.push(data.forwarding_enabled);
    }
    if (data.pinned !== undefined) {
      updates.push('pinned = ?');
      params.push(data.pinned);
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);

    await execute(
      `UPDATE bookmarks SET ${updates.join(', ')} WHERE id = ?`,
      params
    );

    // Update folders if provided
    if (data.folder_ids !== undefined) {
      await execute('DELETE FROM bookmark_folders WHERE bookmark_id = ?', [id]);
      if (data.folder_ids.length > 0) {
        // Verify user owns all folders
        for (const folderId of data.folder_ids) {
          const folder = await queryOne('SELECT * FROM folders WHERE id = ? AND user_id = ?', [folderId, userId]);
          if (!folder) {
            return res.status(403).json({ error: `You do not own folder ${folderId}` });
          }
          await execute(
            'INSERT INTO bookmark_folders (bookmark_id, folder_id) VALUES (?, ?)',
            [id, folderId]
          );
        }
      }
    }

    // Update tags if provided (L1: verify user owns each tag)
    if (data.tag_ids !== undefined) {
      for (const tagId of data.tag_ids) {
        const canAccess = await canAccessTag(userId, tagId);
        if (!canAccess) {
          return res.status(403).json({ error: 'You do not have access to one or more of the selected tags' });
        }
      }
      await execute('DELETE FROM bookmark_tags WHERE bookmark_id = ?', [id]);
      for (const tagId of data.tag_ids) {
        await execute('INSERT INTO bookmark_tags (bookmark_id, tag_id) VALUES (?, ?)', [id, tagId]);
      }
    }

    // Update team shares if provided
    if (data.share_all_teams !== undefined || data.team_ids !== undefined) {
      await execute('DELETE FROM bookmark_team_shares WHERE bookmark_id = ?', [id]);
      if (data.share_all_teams) {
        // Share with all teams user is a member of (org-scoped in cloud mode)
        const teamIds = orgId
          ? await getTeamIdsForUserInOrg(userId, orgId)
          : await getTeamIdsForUser(userId);
        for (const teamId of teamIds) {
          await execute(
            'INSERT INTO bookmark_team_shares (bookmark_id, team_id) VALUES (?, ?)',
            [id, teamId]
          );
        }
      } else if (data.team_ids && data.team_ids.length > 0) {
        // Verify user is member of all teams (and team is in org in cloud mode)
        for (const teamId of data.team_ids) {
          const isMember = await queryOne(
            'SELECT * FROM team_members WHERE user_id = ? AND team_id = ?',
            [userId, teamId]
          );
          if (!isMember) {
            return res.status(403).json({ error: `You are not a member of team ${teamId}` });
          }
          if (orgId) {
            const teamInOrg = await queryOne('SELECT 1 FROM teams WHERE id = ? AND org_id = ?', [teamId, orgId]);
            if (!teamInOrg) {
              return res.status(403).json({ error: `Team ${teamId} is not in your organization` });
            }
          }
          await execute(
            'INSERT INTO bookmark_team_shares (bookmark_id, team_id) VALUES (?, ?)',
            [id, teamId]
          );
        }
      }
    }

    // Update user shares if provided
    if (data.user_ids !== undefined) {
      await execute('DELETE FROM bookmark_user_shares WHERE bookmark_id = ?', [id]);
      if (data.user_ids.length > 0) {
        // Don't allow sharing with self
        const filteredUserIds = data.user_ids.filter((uid) => uid !== userId);
        if (isCloud) {
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
          // Verify user exists
          const user = await queryOne('SELECT id FROM users WHERE id = ?', [shareUserId]);
          if (!user) {
            return res.status(404).json({ error: `User ${shareUserId} not found` });
          }
          await execute(
            'INSERT INTO bookmark_user_shares (bookmark_id, user_id) VALUES (?, ?)',
            [id, shareUserId]
          );
        }
      }
    }

    const bookmark = await queryOne('SELECT * FROM bookmarks WHERE id = ?', [id]);
    // Convert boolean fields from SQLite (0/1) to boolean
    bookmark.forwarding_enabled = Boolean(bookmark.forwarding_enabled);
    // Return null as empty string for frontend
    if (!bookmark.slug) {
      bookmark.slug = '';
    }
    res.json(bookmark);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/bookmarks/{id}:
 *   delete:
 *     summary: Delete bookmark
 *     description: Deletes a bookmark. User must own the bookmark.
 *     tags: [Bookmarks]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Bookmark ID
 *         example: "123e4567-e89b-12d3-a456-426614174000"
 *     responses:
 *       200:
 *         description: Bookmark deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Bookmark deleted"
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Bookmark not found
 */
// Delete bookmark
router.delete('/:id', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const { id } = req.params;

    const canModify = await canModifyBookmark(userId, id);
    if (!canModify) {
      return res.status(404).json({ error: 'Bookmark not found' });
    }

    await execute('DELETE FROM bookmarks WHERE id = ?', [id]);
    res.json({ message: 'Bookmark deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/bookmarks/search:
 *   get:
 *     summary: Search bookmarks, folders, and tags
 *     description: Search across bookmarks, folders, and tags for the authenticated user
 *     tags: [Bookmarks]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema:
 *           type: string
 *         description: Search query
 *         example: "example"
 *     responses:
 *       200:
 *         description: Search results
 *       401:
 *         description: Unauthorized
 */
/**
 * @swagger
 * /api/bookmarks/import:
 *   post:
 *     summary: Import bookmarks from JSON
 *     description: Import bookmarks from a JSON array
 *     tags: [Bookmarks]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               bookmarks:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     title:
 *                       type: string
 *                     url:
 *                       type: string
 *                     slug:
 *                       type: string
 *                     forwarding_enabled:
 *                       type: boolean
 *     responses:
 *       200:
 *         description: Import successful
 *       400:
 *         description: Invalid import data
 *       401:
 *         description: Unauthorized
 */
// Import bookmarks from JSON
router.post('/import', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const { bookmarks: importBookmarks } = req.body;

    if (!Array.isArray(importBookmarks)) {
      return res.status(400).json({ error: 'Invalid import data: expected array of bookmarks' });
    }
    // L2: cap import size to prevent DoS
    const MAX_IMPORT_BOOKMARKS = 1000;
    if (importBookmarks.length > MAX_IMPORT_BOOKMARKS) {
      return res.status(400).json({
        error: `Import limited to ${MAX_IMPORT_BOOKMARKS} bookmarks per request`,
      });
    }

    const results = {
      success: 0,
      failed: 0,
      errors: [] as string[],
    };

    // Cloud: Free plan bookmark limit - get current count
    let currentBookmarkCount = 0;
    if (isCloud) {
      const plan = await getUserPlan(userId);
      if (plan === 'free') {
        const countResult = await queryOne('SELECT COUNT(*) as count FROM bookmarks WHERE user_id = ?', [userId]);
        currentBookmarkCount = countResult ? parseInt((countResult as any).count) : 0;
      }
    }

    let hitLimit = false;
    for (const bookmarkData of importBookmarks) {
      try {
        // Cloud: stop importing if at Free limit
        if (isCloud && currentBookmarkCount >= FREE_BOOKMARK_LIMIT) {
          if (!hitLimit) {
            hitLimit = true;
            results.errors.push(PLAN_ERRORS.BOOKMARK_LIMIT.message);
          }
          results.failed++;
          continue;
        }

        if (!bookmarkData.title || !bookmarkData.url) {
          results.failed++;
          results.errors.push(`Missing title or URL: ${JSON.stringify(bookmarkData)}`);
          continue;
        }

        // Validate URL
        const urlValidation = validateUrl(bookmarkData.url);
        if (!urlValidation.valid) {
          results.failed++;
          results.errors.push(`Invalid URL: ${bookmarkData.url}`);
          continue;
        }

        // Validate and sanitize title
        const titleValidation = validateLength(bookmarkData.title, 'Title', 1, MAX_LENGTHS.title);
        if (!titleValidation.valid) {
          results.failed++;
          results.errors.push(`Invalid title: ${bookmarkData.title}`);
          continue;
        }
        const sanitizedTitle = sanitizeString(bookmarkData.title);

        // Handle slug
        let slug = bookmarkData.slug && bookmarkData.slug.trim() ? bookmarkData.slug.trim() : null;
        if (slug) {
          const slugValidation = validateSlug(slug);
          if (!slugValidation.valid) {
            // Skip slug if invalid, but continue with import
            slug = null;
          } else {
            // Check global uniqueness (required for shared bookmark forwarding)
            const existing = await queryOne(
              'SELECT id FROM bookmarks WHERE slug = ?',
              [slug]
            );
            if (existing) {
              // Skip slug if not unique globally
              slug = null;
            }
          }
        }

        const bookmarkId = uuidv4();
        await execute(
          `INSERT INTO bookmarks (id, user_id, title, url, slug, forwarding_enabled, pinned)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            bookmarkId,
            userId,
            sanitizedTitle,
            bookmarkData.url,
            slug,
            Boolean(bookmarkData.forwarding_enabled || false),
            Boolean(bookmarkData.pinned || false),
          ]
        );

        results.success++;
        if (isCloud) currentBookmarkCount++;
      } catch (error: any) {
        results.failed++;
        console.error('Import bookmark error:', error?.message || error);
        results.errors.push('Failed to import bookmark');
      }
    }

    res.json({
      message: `Imported ${results.success} bookmark(s), ${results.failed} failed`,
      success: results.success,
      failed: results.failed,
      errors: results.errors,
    });
  } catch (error: any) {
    console.error('Import error:', error);
    res.status(500).json({ error: 'Import failed' });
  }
});

export default router;
