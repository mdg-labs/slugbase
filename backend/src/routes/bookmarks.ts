import { Router } from 'express';
import { query, queryOne, execute, getDbType } from '../db/index.js';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { canAccessBookmark, canModifyBookmark, canAccessFolder, canAccessTag, getTeamIdsForUser } from '../auth/authorization.js';
import { v4 as uuidv4 } from 'uuid';
import { CreateBookmarkInput, UpdateBookmarkInput, AiSuggestionUsed } from '../types.js';
import { validateUrl, validateSlug, validateLength, sanitizeString, MAX_LENGTHS } from '../utils/validation.js';
import { isAISuggestionsEnabled, getAIApiKey, getAIModel } from '../utils/ai-feature.js';
import { sanitizeUrlForAI, callAIProvider } from '../services/ai-suggestions.js';
import { fetchPageMetadata } from '../services/fetch-page-metadata.js';
import { getTenantId } from '../utils/tenant.js';
import { isCloud } from '../config/mode.js';
import { recordAuditEvent } from '../services/audit-log.js';

/** Free plan bookmark limit (must match pricing page). Used only when isCloud. */
const FREE_PLAN_BOOKMARK_LIMIT = 50;

const router = Router();
router.use(requireAuth());

/** Record AI suggestion usage for analytics. Does not fail the request if insert fails (e.g. migration not run). */
async function recordAiSuggestionUsage(userId: string, used: AiSuggestionUsed | undefined): Promise<void> {
  if (!used || typeof used !== 'object') return;
  try {
    const id = uuidv4();
    const titleUsed = Boolean(used.title);
    const slugUsed = Boolean(used.slug);
    const tagsUsed = Boolean(used.tags);
    await execute(
      'INSERT INTO ai_suggestion_usage (id, user_id, title_used, slug_used, tags_used) VALUES (?, ?, ?, ?, ?)',
      [id, userId, titleUsed, slugUsed, tagsUsed]
    );
  } catch (_err) {
    // Table may not exist yet; do not fail the bookmark request
  }
}

// Get all bookmarks for user (including shared bookmarks)
router.get('/', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const tenantId = getTenantId(req);
    const { folder_id, tag_id, sort_by, limit: limitParam, offset: offsetParam, scope: scopeParam, pinned: pinnedParam, q: qParam } = req.query;

    // Scope: all (default) | mine | shared_with_me | shared_by_me (legacy "shared" = shared_with_me)
    const scopeRaw = scopeParam === 'mine' || scopeParam === 'shared_with_me' || scopeParam === 'shared_by_me' || scopeParam === 'shared'
      ? (scopeParam === 'shared' ? 'shared_with_me' : scopeParam)
      : 'all';
    const scope = scopeRaw as 'all' | 'mine' | 'shared_with_me' | 'shared_by_me';
    const pinnedFilter = pinnedParam === 'true';
    const pinnedCond = getDbType() === 'postgresql' ? 'b.pinned = true' : 'b.pinned = 1';
    const qStr = typeof qParam === 'string' ? qParam.trim() : '';
    const searchTerm = qStr.length > 0 ? `%${qStr.toLowerCase()}%` : null;

    // Pagination: default 50, max 500
    const limit = Math.min(500, Math.max(1, parseInt(String(limitParam), 10) || 50));
    const offset = Math.max(0, parseInt(String(offsetParam), 10) || 0);

    // Validate folder_id and tag_id so we don't leak other users' resources (IDOR)
    const folderIdStr = typeof folder_id === 'string' ? folder_id : undefined;
    const tagIdStr = typeof tag_id === 'string' ? tag_id : undefined;
    if (folderIdStr) {
      const canAccess = await canAccessFolder(userId, folderIdStr, null, tenantId);
      if (!canAccess) {
        return res.status(404).json({ error: 'Folder not found' });
      }
    }
    if (tagIdStr) {
      const canAccess = await canAccessTag(userId, tagIdStr, tenantId);
      if (!canAccess) {
        return res.status(404).json({ error: 'Tag not found' });
      }
    }

    const teamIds = await getTeamIdsForUser(userId, tenantId);

    // Build query for own bookmarks + shared bookmarks (directly shared with user, teams, or via shared folders)
    // In cloud mode, user shares (bus/fus) only count when owner is in same org
    // Param order: CASE b.user_id (SELECT), then WHERE tenant_id, b.user_id, bus.user_id, [teamIds], fus.user_id, [teamIds]
    const busCond = 'bus.user_id = ?';
    const fusCond = 'fus.user_id = ?';
    let sql = `
      SELECT DISTINCT b.*,
             CASE WHEN b.user_id = ? THEN 'own' ELSE 'shared' END as bookmark_type
      FROM bookmarks b
      LEFT JOIN bookmark_user_shares bus ON b.id = bus.bookmark_id
      LEFT JOIN bookmark_team_shares bts ON b.id = bts.bookmark_id
      LEFT JOIN bookmark_folders bf ON b.id = bf.bookmark_id
      LEFT JOIN folder_user_shares fus ON bf.folder_id = fus.folder_id
      LEFT JOIN folder_team_shares fts ON bf.folder_id = fts.folder_id
      WHERE b.tenant_id = ?
        AND (b.user_id = ? 
        OR ${busCond}
        OR (bts.team_id IN (${teamIds.length > 0 ? teamIds.map(() => '?').join(',') : 'NULL'}) AND bts.team_id IS NOT NULL)
        OR ${fusCond}
        OR (fts.team_id IN (${teamIds.length > 0 ? teamIds.map(() => '?').join(',') : 'NULL'}) AND fts.team_id IS NOT NULL AND bf.folder_id IS NOT NULL))
    `;
    const params: any[] = [userId, tenantId, userId, userId];
    if (teamIds.length > 0) {
      params.push(...teamIds);   // bts.team_id IN (...)
      params.push(userId);       // fus.user_id
      params.push(...teamIds);   // fts.team_id IN (...)
    } else {
      params.push(userId);       // fus.user_id (no IN placeholders when teamIds empty)
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

    if (scope === 'mine') {
      sql += ' AND b.user_id = ?';
      params.push(userId);
    }
    if (scope === 'shared_with_me') {
      sql += ' AND b.user_id != ?';
      params.push(userId);
    }
    if (scope === 'shared_by_me') {
      sql += ` AND b.user_id = ? AND (EXISTS (SELECT 1 FROM bookmark_team_shares bts WHERE bts.bookmark_id = b.id) OR EXISTS (SELECT 1 FROM bookmark_user_shares bus WHERE bus.bookmark_id = b.id))`;
      params.push(userId);
    }
    if (pinnedFilter) {
      sql += ` AND ${pinnedCond}`;
    }
    if (searchTerm) {
      sql += ' AND (LOWER(b.title) LIKE ? OR LOWER(b.url) LIKE ? OR LOWER(COALESCE(b.slug, \'\')) LIKE ?)';
      params.push(searchTerm, searchTerm, searchTerm);
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
      WHERE b.tenant_id = ?
        AND (b.user_id = ?
        OR ${busCond}
        OR (bts.team_id IN (${teamIds.length > 0 ? teamIds.map(() => '?').join(',') : 'NULL'}) AND bts.team_id IS NOT NULL)
        OR ${fusCond}
        OR (fts.team_id IN (${teamIds.length > 0 ? teamIds.map(() => '?').join(',') : 'NULL'}) AND fts.team_id IS NOT NULL AND bf.folder_id IS NOT NULL))
      ${folderIdStr ? 'AND b.id IN (SELECT bookmark_id FROM bookmark_folders WHERE folder_id = ?)' : ''}
      ${tagIdStr ? 'AND b.id IN (SELECT bookmark_id FROM bookmark_tags WHERE tag_id = ?)' : ''}
      ${scope === 'mine' ? 'AND b.user_id = ?' : ''}
      ${scope === 'shared_with_me' ? 'AND b.user_id != ?' : ''}
      ${scope === 'shared_by_me' ? 'AND b.user_id = ? AND (EXISTS (SELECT 1 FROM bookmark_team_shares bts WHERE bts.bookmark_id = b.id) OR EXISTS (SELECT 1 FROM bookmark_user_shares bus WHERE bus.bookmark_id = b.id))' : ''}
      ${pinnedFilter ? `AND ${pinnedCond}` : ''}
      ${searchTerm ? 'AND (LOWER(b.title) LIKE ? OR LOWER(b.url) LIKE ? OR LOWER(COALESCE(b.slug, \'\')) LIKE ?)' : ''}
    `;
    const countParams = [tenantId, userId, userId];
    if (teamIds.length > 0) {
      countParams.push(...teamIds);   // bts.team_id IN (...)
      countParams.push(userId);       // fus.user_id
      countParams.push(...teamIds);   // fts.team_id IN (...)
    } else {
      countParams.push(userId);       // fus.user_id
    }
    if (folderIdStr) countParams.push(folderIdStr);
    if (tagIdStr) countParams.push(tagIdStr);
    if (scope === 'mine') countParams.push(userId);
    if (scope === 'shared_with_me') countParams.push(userId);
    if (scope === 'shared_by_me') countParams.push(userId);
    if (searchTerm) countParams.push(searchTerm, searchTerm, searchTerm);

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

// Search endpoint (must be before /:id route)
router.get('/search', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const tenantId = getTenantId(req);
    const { q } = req.query;

    if (!q || typeof q !== 'string') {
      return res.status(400).json({ error: 'Search query is required' });
    }

    const searchTerm = `%${q.toLowerCase()}%`;

    // Get user's teams for share checks (org-scoped in cloud mode)
    const teamIds = await getTeamIdsForUser(userId, tenantId);
    const teamPlaceholders = teamIds.length > 0 ? teamIds.map(() => '?').join(',') : 'NULL';
    const busCond = 'bus.user_id = ?';
    const fusCond = 'fus.user_id = ?';

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
    bookmarkParams.push(userId, userId);
    if (teamIds.length > 0) {
      bookmarkParams.push(...teamIds);
      bookmarkParams.push(...teamIds);
    }
    bookmarkParams.push(searchTerm, searchTerm, searchTerm);
    const bookmarkResults = await query(bookmarkSql, bookmarkParams);

    // Search folders (same access as GET /folders: own + shared via user/team)
    const folderFusCond = 'fus.user_id = ?';
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
    folderParams.push(userId);
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

// Export bookmarks as JSON (must be before /:id route)
router.get('/export', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const tenantId = getTenantId(req);

    // Get all bookmarks (same access as GET /: own + user share + team share + folder-based sharing)
    const teamIds = await getTeamIdsForUser(userId, tenantId);
    const teamPlaceholders = teamIds.length > 0 ? teamIds.map(() => '?').join(',') : 'NULL';
    const busCond = 'bus.user_id = ?';
    const fusCond = 'fus.user_id = ?';
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
    exportParams.push(userId, userId);
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
    const tenantId = getTenantId(req);
    const { folder_id, tag_id, sort_by, scope: scopeParam, pinned: pinnedParam, q: qParam } = req.query;

    const folderIdStr = typeof folder_id === 'string' ? folder_id : undefined;
    const tagIdStr = typeof tag_id === 'string' ? tag_id : undefined;
    if (folderIdStr) {
      const canAccess = await canAccessFolder(userId, folderIdStr, null, tenantId);
      if (!canAccess) {
        return res.status(404).json({ error: 'Folder not found' });
      }
    }
    if (tagIdStr) {
      const canAccess = await canAccessTag(userId, tagIdStr, tenantId);
      if (!canAccess) {
        return res.status(404).json({ error: 'Tag not found' });
      }
    }

    const idsScopeRaw = scopeParam === 'mine' || scopeParam === 'shared_with_me' || scopeParam === 'shared_by_me' || scopeParam === 'shared'
      ? (scopeParam === 'shared' ? 'shared_with_me' : scopeParam)
      : 'all';
    const idsScope = idsScopeRaw as 'all' | 'mine' | 'shared_with_me' | 'shared_by_me';
    const pinnedFilter = pinnedParam === 'true';
    const pinnedCondIds = getDbType() === 'postgresql' ? 'b.pinned = true' : 'b.pinned = 1';
    const qStr = typeof qParam === 'string' ? qParam.trim() : '';
    const idsSearchTerm = qStr.length > 0 ? `%${qStr.toLowerCase()}%` : null;

    const teamIds = await getTeamIdsForUser(userId, tenantId);

    const busCond = 'bus.user_id = ?';
    const fusCond = 'fus.user_id = ?';
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
    idsParams.push(userId, userId);
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
    if (idsScope === 'mine') {
      idsSql += ' AND b.user_id = ?';
      idsParams.push(userId);
    }
    if (idsScope === 'shared_with_me') {
      idsSql += ' AND b.user_id != ?';
      idsParams.push(userId);
    }
    if (idsScope === 'shared_by_me') {
      idsSql += ` AND b.user_id = ? AND (EXISTS (SELECT 1 FROM bookmark_team_shares bts WHERE bts.bookmark_id = b.id) OR EXISTS (SELECT 1 FROM bookmark_user_shares bus WHERE bus.bookmark_id = b.id))`;
      idsParams.push(userId);
    }
    if (pinnedFilter) {
      idsSql += ` AND ${pinnedCondIds}`;
    }
    if (idsSearchTerm) {
      idsSql += ' AND (LOWER(b.title) LIKE ? OR LOWER(b.url) LIKE ? OR LOWER(COALESCE(b.slug, \'\')) LIKE ?)';
      idsParams.push(idsSearchTerm, idsSearchTerm, idsSearchTerm);
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

router.post('/ai-suggest', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const { url, page_title: pageTitle } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'URL is required' });
    }

    const urlValidation = validateUrl(url);
    if (!urlValidation.valid) {
      return res.status(400).json({ error: urlValidation.error });
    }

    const tenantId = getTenantId(req);
    // Cloud: AI suggestions only on Personal, Team, and Early Supporter – not Free
    if (isCloud && (req as any).plan === 'free') {
      return res.status(403).json({
        code: 'PLAN_REQUIRES_AI',
        error: 'AI suggestions are available on Personal, Team, and Early Supporter plans.',
      });
    }
    const enabled = await isAISuggestionsEnabled(userId, tenantId);
    if (!enabled) {
      return res.status(403).json({ error: 'AI suggestions are not available' });
    }

    const apiKey = await getAIApiKey(tenantId);
    if (!apiKey) {
      return res.status(503).json({ error: 'AI is not configured' });
    }

    const sanitizedUrl = sanitizeUrlForAI(url);
    if (!sanitizedUrl) {
      return res.status(400).json({ error: 'Invalid URL' });
    }

    const userRow = await queryOne('SELECT language FROM users WHERE id = ?', [userId]) as { language?: string } | null;
    const userLanguage = (userRow?.language || 'en').slice(0, 10);

    const DB_TYPE = process.env.DB_TYPE || 'sqlite';
    const cacheTtlDays = 7;
    const cacheCondition =
      DB_TYPE === 'postgresql'
        ? `AND created_at >= NOW() - INTERVAL '${cacheTtlDays} days'`
        : "AND datetime(created_at) >= datetime('now', '-7 days')";
    const cached = await queryOne(
      `SELECT title, slug, tags, language, confidence FROM ai_suggestions_cache WHERE user_id = ? AND canonical_url = ? AND output_language = ? ${cacheCondition}`,
      [userId, sanitizedUrl, userLanguage]
    );
    if (cached) {
      const tags = typeof (cached as any).tags === 'string'
        ? JSON.parse((cached as any).tags)
        : (cached as any).tags;
      return res.json({
        title: (cached as any).title,
        slug: (cached as any).slug || '',
        tags: Array.isArray(tags) ? tags : [],
        language: (cached as any).language || 'en',
        confidence: (cached as any).confidence ?? 0.5,
      });
    }

    const metadata = await fetchPageMetadata(sanitizedUrl);
    const fetchedTitle = metadata?.title;
    const fetchedDescription = metadata?.description;
    const siteName = metadata?.siteName;
    const pageTitleToUse =
      typeof pageTitle === 'string' && pageTitle.trim()
        ? pageTitle.trim()
        : fetchedTitle;

    const model = await getAIModel(tenantId);
    const result = await callAIProvider(
      sanitizedUrl,
      pageTitleToUse,
      fetchedDescription,
      apiKey,
      model,
      10000,
      userLanguage,
      siteName
    );

    if (!result) {
      return res.status(503).json({ error: 'AI suggestion failed' });
    }

    const tagsJson = DB_TYPE === 'postgresql'
      ? JSON.stringify(result.tags)
      : JSON.stringify(result.tags);
    await execute(
      `INSERT INTO ai_suggestions_cache (user_id, canonical_url, output_language, title, slug, tags, language, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, canonical_url, output_language) DO UPDATE SET title = excluded.title, slug = excluded.slug, tags = excluded.tags, language = excluded.language, confidence = excluded.confidence`,
      [userId, sanitizedUrl, userLanguage, result.title, result.slug, tagsJson, result.language, result.confidence]
    );

    res.json({
      title: result.title,
      slug: result.slug,
      tags: result.tags,
      language: result.language,
      confidence: result.confidence,
    });
  } catch (error: any) {
    if (error.name === 'AbortError') {
      return res.status(408).json({ error: 'AI request timed out' });
    }
    console.error('AI suggest error:', error);
    res.status(500).json({ error: 'AI suggestion failed' });
  }
});

// Get single bookmark (own or shared) - must be after /export and /search routes
router.get('/:id', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const tenantId = getTenantId(req);
    const { id } = req.params;

    const canAccess = await canAccessBookmark(userId, id, null, tenantId);
    if (!canAccess) {
      return res.status(404).json({ error: 'Bookmark not found' });
    }

    const bookmark = await queryOne('SELECT * FROM bookmarks WHERE id = ? AND tenant_id = ?', [id, tenantId]);
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

// Track bookmark access (must be before PUT /:id)
router.post('/:id/track-access', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const tenantId = getTenantId(req);
    const { id } = req.params;

    const canAccess = await canAccessBookmark(userId, id, null, tenantId);
    if (!canAccess) {
      return res.status(404).json({ error: 'Bookmark not found' });
    }

    // Update access_count and last_accessed_at
    await execute(
      `UPDATE bookmarks 
       SET access_count = COALESCE(access_count, 0) + 1,
           last_accessed_at = CURRENT_TIMESTAMP
       WHERE id = ? AND tenant_id = ?`,
      [id, tenantId]
    );

    res.json({ success: true });
  } catch (error: any) {
    console.error('Failed to track bookmark access:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create bookmark
router.post('/', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const tenantId = getTenantId(req);
    const data: CreateBookmarkInput = req.body;

    if (!data.title || !data.url) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Cloud: Free plan bookmark limit
    if (isCloud && (req as any).plan === 'free') {
      const countResult = await queryOne('SELECT COUNT(*) as count FROM bookmarks WHERE tenant_id = ?', [tenantId]);
      const count = parseInt(String((countResult as any)?.count ?? 0), 10);
      if (count >= FREE_PLAN_BOOKMARK_LIMIT) {
        return res.status(403).json({
          code: 'BOOKMARK_LIMIT_REACHED',
          error: `You've reached the Free plan limit (${FREE_PLAN_BOOKMARK_LIMIT} bookmarks). Upgrade to add more.`,
        });
      }
    }

    // Cloud: Team plan required for team sharing
    if (isCloud && (req as any).plan !== 'team' && (data.share_all_teams || (data.team_ids && data.team_ids.length > 0))) {
      return res.status(403).json({
        code: 'PLAN_REQUIRES_TEAM',
        error: 'Sharing to teams is available on the Team plan.',
      });
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
        'SELECT id FROM bookmarks WHERE slug = ? AND tenant_id = ?',
        [slug, tenantId]
      );

      if (existing) {
        return res.status(400).json({ error: 'Slug already exists. Slugs must be unique across all bookmarks.' });
      }
    }

    const bookmarkId = uuidv4();
    await execute(
      `INSERT INTO bookmarks (id, tenant_id, user_id, title, url, slug, forwarding_enabled, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [bookmarkId, tenantId, userId, sanitizedTitle, data.url, slug, data.forwarding_enabled || false, Boolean((data as any).pinned || false)]
    );

    // Add folders
    if (data.folder_ids && data.folder_ids.length > 0) {
      // Verify user owns all folders
      for (const folderId of data.folder_ids) {
        const folder = await queryOne('SELECT * FROM folders WHERE id = ? AND user_id = ? AND tenant_id = ?', [folderId, userId, tenantId]);
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
        const canAccess = await canAccessTag(userId, tagId, tenantId);
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
      const teamIds = await getTeamIdsForUser(userId, tenantId);
      for (const teamId of teamIds) {
        await execute(
          'INSERT INTO bookmark_team_shares (bookmark_id, team_id) VALUES (?, ?)',
          [bookmarkId, teamId]
        );
      }
    } else if (data.team_ids && data.team_ids.length > 0) {
      // Verify user is member of all teams
      for (const teamId of data.team_ids) {
        const isMember = await queryOne(
          'SELECT * FROM team_members WHERE user_id = ? AND team_id = ? AND tenant_id = ?',
          [userId, teamId, tenantId]
        );
        if (!isMember) {
          return res.status(403).json({ error: `You are not a member of team ${teamId}` });
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

    await recordAiSuggestionUsage(userId, data.ai_suggestion_used);

    const bookmark = await queryOne('SELECT * FROM bookmarks WHERE id = ? AND tenant_id = ?', [bookmarkId, tenantId]);
    // Convert boolean fields from SQLite (0/1) to boolean
    bookmark.forwarding_enabled = Boolean(bookmark.forwarding_enabled);
    // Return null as empty string for frontend
    if (!bookmark.slug) {
      bookmark.slug = '';
    }
    await recordAuditEvent(req, {
      action: 'bookmark.created',
      entityType: 'bookmark',
      entityId: bookmarkId,
      metadata: { title: sanitizedTitle, url: data.url },
    });
    res.status(201).json(bookmark);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Update bookmark
router.put('/:id', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const tenantId = getTenantId(req);
    const { id } = req.params;
    const data: UpdateBookmarkInput = req.body;

    const canModify = await canModifyBookmark(userId, id, tenantId);
    if (!canModify) {
      return res.status(404).json({ error: 'Bookmark not found' });
    }
    const existing = await queryOne('SELECT * FROM bookmarks WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    if (!existing) {
      return res.status(404).json({ error: 'Bookmark not found' });
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
          'SELECT id FROM bookmarks WHERE slug = ? AND id != ? AND tenant_id = ?',
          [newSlug, id, tenantId]
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
      `UPDATE bookmarks SET ${updates.join(', ')} WHERE id = ? AND tenant_id = ?`,
      [...params, tenantId]
    );

    // Update folders if provided
    if (data.folder_ids !== undefined) {
      await execute('DELETE FROM bookmark_folders WHERE bookmark_id = ?', [id]);
      if (data.folder_ids.length > 0) {
        // Verify user owns all folders
        for (const folderId of data.folder_ids) {
          const folder = await queryOne('SELECT * FROM folders WHERE id = ? AND user_id = ? AND tenant_id = ?', [folderId, userId, tenantId]);
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
        const canAccess = await canAccessTag(userId, tagId, tenantId);
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
      if (isCloud && (req as any).plan !== 'team' && (data.share_all_teams || (data.team_ids && data.team_ids.length > 0))) {
        return res.status(403).json({
          code: 'PLAN_REQUIRES_TEAM',
          error: 'Sharing to teams is available on the Team plan.',
        });
      }
      await execute('DELETE FROM bookmark_team_shares WHERE bookmark_id = ?', [id]);
      if (data.share_all_teams) {
        // Share with all teams user is a member of (org-scoped in cloud mode)
        const teamIds = await getTeamIdsForUser(userId, tenantId);
        for (const teamId of teamIds) {
          await execute(
            'INSERT INTO bookmark_team_shares (bookmark_id, team_id) VALUES (?, ?)',
            [id, teamId]
          );
        }
      } else if (data.team_ids && data.team_ids.length > 0) {
        // Verify user is member of all teams
        for (const teamId of data.team_ids) {
          const isMember = await queryOne(
            'SELECT * FROM team_members WHERE user_id = ? AND team_id = ? AND tenant_id = ?',
            [userId, teamId, tenantId]
          );
          if (!isMember) {
            return res.status(403).json({ error: `You are not a member of team ${teamId}` });
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

    await recordAiSuggestionUsage(userId, data.ai_suggestion_used);

    const bookmark = await queryOne('SELECT * FROM bookmarks WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    // Convert boolean fields from SQLite (0/1) to boolean
    bookmark.forwarding_enabled = Boolean(bookmark.forwarding_enabled);
    // Return null as empty string for frontend
    if (!bookmark.slug) {
      bookmark.slug = '';
    }
    await recordAuditEvent(req, {
      action: 'bookmark.updated',
      entityType: 'bookmark',
      entityId: id,
      metadata: { title: bookmark.title, url: bookmark.url },
    });
    res.json(bookmark);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Delete bookmark
router.delete('/:id', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const tenantId = getTenantId(req);
    const { id } = req.params;

    const canModify = await canModifyBookmark(userId, id, tenantId);
    if (!canModify) {
      return res.status(404).json({ error: 'Bookmark not found' });
    }

    const snap = await queryOne('SELECT title, url FROM bookmarks WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    await execute('DELETE FROM bookmarks WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    if (snap) {
      await recordAuditEvent(req, {
        action: 'bookmark.deleted',
        entityType: 'bookmark',
        entityId: id,
        metadata: { title: snap.title, url: snap.url },
      });
    }

    res.json({ message: 'Bookmark deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Import bookmarks from JSON
router.post('/import', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const tenantId = getTenantId(req);
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

    // Cloud: Free plan bookmark limit – reject import if it would exceed limit
    if (isCloud && (req as any).plan === 'free') {
      const countResult = await queryOne('SELECT COUNT(*) as count FROM bookmarks WHERE tenant_id = ?', [tenantId]);
      const count = parseInt(String((countResult as any)?.count ?? 0), 10);
      const remaining = FREE_PLAN_BOOKMARK_LIMIT - count;
      if (remaining <= 0) {
        return res.status(403).json({
          code: 'BOOKMARK_LIMIT_REACHED',
          error: `You've reached the Free plan limit (${FREE_PLAN_BOOKMARK_LIMIT} bookmarks). Upgrade to add more.`,
        });
      }
      if (importBookmarks.length > remaining) {
        return res.status(403).json({
          code: 'BOOKMARK_LIMIT_REACHED',
          error: `You can import up to ${remaining} more bookmarks (Free plan limit: ${FREE_PLAN_BOOKMARK_LIMIT}).`,
        });
      }
    }

    const results = {
      success: 0,
      failed: 0,
      errors: [] as string[],
    };

    // Cache for create-or-get folders/tags by name within this import
    const folderNameToId = new Map<string, string>();
    const tagNameToId = new Map<string, string>();

    for (const bookmarkData of importBookmarks) {
      try {
        if (!bookmarkData.title || !bookmarkData.url) {
          results.failed++;
          results.errors.push('Missing title or URL');
          continue;
        }

        // Validate URL
        const urlValidation = validateUrl(bookmarkData.url);
        if (!urlValidation.valid) {
          results.failed++;
          results.errors.push('Invalid URL');
          continue;
        }

        // Validate and sanitize title
        const titleValidation = validateLength(bookmarkData.title, 'Title', 1, MAX_LENGTHS.title);
        if (!titleValidation.valid) {
          results.failed++;
          results.errors.push('Invalid title');
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
              'SELECT id FROM bookmarks WHERE slug = ? AND tenant_id = ?',
              [slug, tenantId]
            );
            if (existing) {
              // Skip slug if not unique globally
              slug = null;
            }
          }
        }

        const bookmarkId = uuidv4();
        await execute(
          `INSERT INTO bookmarks (id, tenant_id, user_id, title, url, slug, forwarding_enabled, pinned)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            bookmarkId,
            tenantId,
            userId,
            sanitizedTitle,
            bookmarkData.url,
            slug,
            Boolean(bookmarkData.forwarding_enabled || false),
            Boolean(bookmarkData.pinned || false),
          ]
        );

        // Optional: assign to folders by name (create folder if not exists)
        const folderNames = Array.isArray(bookmarkData.folder_names) ? bookmarkData.folder_names : [];
        for (const rawName of folderNames) {
          const name = typeof rawName === 'string' ? rawName.trim() : '';
          if (!name) continue;
          const nameValidation = validateLength(name, 'Folder name', 1, MAX_LENGTHS.folderName);
          if (!nameValidation.valid) continue;
          const sanitizedName = sanitizeString(name);
          let folderId: string | undefined = folderNameToId.get(sanitizedName);
          if (!folderId) {
            const existingRow = await queryOne(
              'SELECT id FROM folders WHERE tenant_id = ? AND user_id = ? AND name = ?',
              [tenantId, userId, sanitizedName]
            );
            const existingId = existingRow && typeof (existingRow as any).id === 'string' && (existingRow as any).id ? (existingRow as any).id : null;
            if (existingId) {
              folderId = existingId;
            } else {
              folderId = uuidv4();
              await execute(
                'INSERT INTO folders (id, tenant_id, user_id, name, icon) VALUES (?, ?, ?, ?, ?)',
                [folderId, tenantId, userId, sanitizedName, null]
              );
            }
            folderNameToId.set(sanitizedName, folderId as string);
          }
          if (folderId) {
            await execute(
              'INSERT INTO bookmark_folders (bookmark_id, folder_id, tenant_id) VALUES (?, ?, ?)',
              [bookmarkId, folderId, tenantId]
            );
          }
        }

        // Optional: assign to tags by name (create tag if not exists)
        const tagNames = Array.isArray(bookmarkData.tag_names) ? bookmarkData.tag_names : [];
        for (const rawName of tagNames) {
          const name = typeof rawName === 'string' ? rawName.trim() : '';
          if (!name) continue;
          const nameValidation = validateLength(name, 'Tag name', 1, MAX_LENGTHS.tagName);
          if (!nameValidation.valid) continue;
          const sanitizedName = sanitizeString(name);
          let tagId: string | undefined = tagNameToId.get(sanitizedName);
          if (!tagId) {
            const existing = await queryOne(
              'SELECT id FROM tags WHERE user_id = ? AND tenant_id = ? AND name = ?',
              [userId, tenantId, sanitizedName]
            );
            tagId = (existing as any)?.id ?? uuidv4();
            if (!(existing as any)?.id) {
              await execute(
                'INSERT INTO tags (id, tenant_id, user_id, name) VALUES (?, ?, ?, ?)',
                [tagId, tenantId, userId, sanitizedName]
              );
            }
            tagNameToId.set(sanitizedName, tagId as string);
          }
          await execute('INSERT INTO bookmark_tags (bookmark_id, tag_id) VALUES (?, ?)', [bookmarkId, tagId as string]);
        }

        results.success++;
      } catch (error: any) {
        results.failed++;
        console.error('Import bookmark error:', error?.message || error);
        results.errors.push('Failed to import bookmark');
      }
    }

    if (results.success > 0) {
      await recordAuditEvent(req, {
        action: 'bookmark.import',
        entityType: 'bookmark',
        entityId: null,
        metadata: { success: results.success, failed: results.failed },
      });
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
