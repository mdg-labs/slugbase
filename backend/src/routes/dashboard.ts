import { Router } from 'express';
import { query, queryOne, getDbType } from '../db/index.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { getTeamIdsForUser } from '../auth/authorization.js';
import { getTenantId } from '../utils/tenant.js';
import { isCloud } from '../config/mode.js';

const router = Router();

router.get('/stats', requireAuth(), async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const tenantId = getTenantId(req);
    const teamIds = await getTeamIdsForUser(userId, tenantId);
    const isPg = getDbType() === 'postgresql';
    const pinnedCondition = isPg ? 'pinned = true' : 'pinned = 1';

    // Total bookmarks (own only)
    const totalBookmarksResult = await queryOne(
      'SELECT COUNT(*) as count FROM bookmarks WHERE user_id = ? AND tenant_id = ?',
      [userId, tenantId]
    );
    const totalBookmarks = totalBookmarksResult ? parseInt((totalBookmarksResult as any).count) : 0;

    // Total folders (own only)
    const totalFoldersResult = await queryOne(
      'SELECT COUNT(*) as count FROM folders WHERE user_id = ? AND tenant_id = ?',
      [userId, tenantId]
    );
    const totalFolders = totalFoldersResult ? parseInt((totalFoldersResult as any).count) : 0;

    // Total tags (own only)
    const totalTagsResult = await queryOne(
      'SELECT COUNT(*) as count FROM tags WHERE user_id = ? AND tenant_id = ?',
      [userId, tenantId]
    );
    const totalTags = totalTagsResult ? parseInt((totalTagsResult as any).count) : 0;

    // Shared bookmarks count (bookmarks shared with user)
    // Use simpler queries that don't cause cartesian products
    const sharedBookmarkIds = new Set<string>();

    const userSharedBookmarksSql = `SELECT DISTINCT bus.bookmark_id
      FROM bookmark_user_shares bus
      INNER JOIN bookmarks b ON b.id = bus.bookmark_id
      WHERE bus.user_id = ? AND b.tenant_id = ?`;
    const userSharedBookmarks = await query(
      userSharedBookmarksSql,
      [userId, tenantId]
    );
    (Array.isArray(userSharedBookmarks) ? userSharedBookmarks : []).forEach((row: any) => {
      if (row.bookmark_id) sharedBookmarkIds.add(row.bookmark_id);
    });
    
    // Team shares
    if (teamIds.length > 0) {
      const teamSharedBookmarks = await query(
        `SELECT DISTINCT bts.bookmark_id
         FROM bookmark_team_shares bts
         INNER JOIN bookmarks b ON b.id = bts.bookmark_id
         WHERE bts.team_id IN (${teamIds.map(() => '?').join(',')}) AND b.tenant_id = ?`,
        [...teamIds, tenantId]
      );
      (Array.isArray(teamSharedBookmarks) ? teamSharedBookmarks : []).forEach((row: any) => {
        if (row.bookmark_id) sharedBookmarkIds.add(row.bookmark_id);
      });
    }

    const folderUserSharesSql = `SELECT DISTINCT fus.folder_id
      FROM folder_user_shares fus
      INNER JOIN folders f ON f.id = fus.folder_id
      WHERE fus.user_id = ? AND f.tenant_id = ?`;
    const folderUserShares = await query(
      folderUserSharesSql,
      [userId, tenantId]
    );
    if (Array.isArray(folderUserShares) && folderUserShares.length > 0) {
      const folderIds = folderUserShares.map((row: any) => row.folder_id).filter(Boolean);
      if (folderIds.length > 0) {
        const bookmarkFolderShares = await query(
          `SELECT DISTINCT bf.bookmark_id
           FROM bookmark_folders bf
           INNER JOIN bookmarks b ON b.id = bf.bookmark_id
           WHERE bf.folder_id IN (${folderIds.map(() => '?').join(',')}) AND b.tenant_id = ?`,
          [...folderIds, tenantId]
        );
        (Array.isArray(bookmarkFolderShares) ? bookmarkFolderShares : []).forEach((row: any) => {
          if (row.bookmark_id) sharedBookmarkIds.add(row.bookmark_id);
        });
      }
    }
    
    // Folder team shares
    if (teamIds.length > 0) {
      const folderTeamShares = await query(
        `SELECT DISTINCT fts.folder_id
         FROM folder_team_shares fts
         INNER JOIN folders f ON f.id = fts.folder_id
         WHERE fts.team_id IN (${teamIds.map(() => '?').join(',')}) AND f.tenant_id = ?`,
        [...teamIds, tenantId]
      );
      if (Array.isArray(folderTeamShares) && folderTeamShares.length > 0) {
        const folderIds = folderTeamShares.map((row: any) => row.folder_id).filter(Boolean);
        if (folderIds.length > 0) {
          const bookmarkFolderShares = await query(
            `SELECT DISTINCT bf.bookmark_id
             FROM bookmark_folders bf
             INNER JOIN bookmarks b ON b.id = bf.bookmark_id
             WHERE bf.folder_id IN (${folderIds.map(() => '?').join(',')}) AND b.tenant_id = ?`,
            [...folderIds, tenantId]
          );
          (Array.isArray(bookmarkFolderShares) ? bookmarkFolderShares : []).forEach((row: any) => {
            if (row.bookmark_id) sharedBookmarkIds.add(row.bookmark_id);
          });
        }
      }
    }
    
    // Filter out own bookmarks and count
    const sharedBookmarkIdsArray = Array.from(sharedBookmarkIds);
    let sharedBookmarks = 0;
    if (sharedBookmarkIdsArray.length > 0) {
      const sharedBookmarksResult = await queryOne(
        `SELECT COUNT(*) as count FROM bookmarks WHERE id IN (${sharedBookmarkIdsArray.map(() => '?').join(',')}) AND user_id != ? AND tenant_id = ?`,
        [...sharedBookmarkIdsArray, userId, tenantId]
      );
      sharedBookmarks = sharedBookmarksResult ? parseInt((sharedBookmarksResult as any).count) : 0;
    }

    // Shared folders count (folders shared with user)
    const sharedFolderIds = new Set<string>();
    
    const userSharedFolders = await query(
      folderUserSharesSql,
      [userId, tenantId]
    );
    (Array.isArray(userSharedFolders) ? userSharedFolders : []).forEach((row: any) => {
      if (row.folder_id) sharedFolderIds.add(row.folder_id);
    });
    
    // Team shares
    if (teamIds.length > 0) {
      const teamSharedFolders = await query(
        `SELECT DISTINCT fts.folder_id
         FROM folder_team_shares fts
         INNER JOIN folders f ON f.id = fts.folder_id
         WHERE fts.team_id IN (${teamIds.map(() => '?').join(',')}) AND f.tenant_id = ?`,
        [...teamIds, tenantId]
      );
      (Array.isArray(teamSharedFolders) ? teamSharedFolders : []).forEach((row: any) => {
        if (row.folder_id) sharedFolderIds.add(row.folder_id);
      });
    }
    
    // Filter out own folders and count
    const sharedFolderIdsArray = Array.from(sharedFolderIds);
    let sharedFolders = 0;
    if (sharedFolderIdsArray.length > 0) {
      const sharedFoldersResult = await queryOne(
        `SELECT COUNT(*) as count FROM folders WHERE id IN (${sharedFolderIdsArray.map(() => '?').join(',')}) AND user_id != ? AND tenant_id = ?`,
        [...sharedFolderIdsArray, userId, tenantId]
      );
      sharedFolders = sharedFoldersResult ? parseInt((sharedFoldersResult as any).count) : 0;
    }

    // Recent bookmarks (last 5, own only) with last_accessed_at
    const recentBookmarks = await query(
      'SELECT id, title, url, created_at, last_accessed_at FROM bookmarks WHERE user_id = ? AND tenant_id = ? ORDER BY created_at DESC LIMIT 5',
      [userId, tenantId]
    );
    const recentBookmarksList = Array.isArray(recentBookmarks) ? recentBookmarks : (recentBookmarks ? [recentBookmarks] : []);

    // Enrich with folder and tag names (optional fields, backward-compatible)
    const bookmarkIds = (recentBookmarksList as any[]).map((b: any) => b.id).filter(Boolean);
    const folderNamesByBookmark: Record<string, string[]> = {};
    const tagNamesByBookmark: Record<string, string[]> = {};
    if (bookmarkIds.length > 0) {
      const placeholders = bookmarkIds.map(() => '?').join(',');
      const folderRows = await query(
        `SELECT bf.bookmark_id, f.name
         FROM bookmark_folders bf
         INNER JOIN folders f ON bf.folder_id = f.id
         WHERE bf.bookmark_id IN (${placeholders}) AND f.tenant_id = ?`,
        [...bookmarkIds, tenantId]
      ) as any[];
      const tagRows = await query(
        `SELECT bt.bookmark_id, t.name
         FROM bookmark_tags bt
         INNER JOIN tags t ON bt.tag_id = t.id
         WHERE bt.bookmark_id IN (${placeholders}) AND t.tenant_id = ?`,
        [...bookmarkIds, tenantId]
      ) as any[];
      (Array.isArray(folderRows) ? folderRows : []).forEach((row: any) => {
        if (!folderNamesByBookmark[row.bookmark_id]) folderNamesByBookmark[row.bookmark_id] = [];
        folderNamesByBookmark[row.bookmark_id].push(row.name);
      });
      (Array.isArray(tagRows) ? tagRows : []).forEach((row: any) => {
        if (!tagNamesByBookmark[row.bookmark_id]) tagNamesByBookmark[row.bookmark_id] = [];
        tagNamesByBookmark[row.bookmark_id].push(row.name);
      });
    }
    const recentBookmarksEnriched = (recentBookmarksList as any[]).map((b: any) => ({
      id: b.id,
      title: b.title,
      url: b.url,
      created_at: b.created_at,
      last_accessed_at: b.last_accessed_at ?? undefined,
      folder_names: folderNamesByBookmark[b.id] || [],
      tag_names: (tagNamesByBookmark[b.id] || []).slice(0, 3),
    }));

    // Top tags (most used, top 10)
    const topTags = await query(
      `SELECT t.id, t.name, COUNT(bt.bookmark_id) as bookmark_count
       FROM tags t
       INNER JOIN bookmark_tags bt ON t.id = bt.tag_id
       INNER JOIN bookmarks b ON bt.bookmark_id = b.id
       WHERE t.user_id = ? AND t.tenant_id = ? AND b.tenant_id = ?
       GROUP BY t.id, t.name
       ORDER BY bookmark_count DESC
       LIMIT 10`,
      [userId, tenantId, tenantId]
    );
    const topTagsList = Array.isArray(topTags) ? topTags : (topTags ? [topTags] : []);

    // Quick access bookmarks: 16 most opened (by access_count); when all are 0, show 16 random.
    const hasAnyOpened = await queryOne(
      `SELECT 1 FROM bookmarks
       WHERE user_id = ? AND tenant_id = ? AND slug IS NOT NULL AND slug != ''
         AND COALESCE(access_count, 0) > 0
       LIMIT 1`,
      [userId, tenantId]
    );
    const quickAccessBookmarks = await query(
      hasAnyOpened
        ? `SELECT id, title, url, slug FROM bookmarks
           WHERE user_id = ? AND tenant_id = ? AND slug IS NOT NULL AND slug != ''
           ORDER BY COALESCE(access_count, 0) DESC, last_accessed_at DESC NULLS LAST, created_at DESC
           LIMIT 16`
        : `SELECT id, title, url, slug FROM bookmarks
           WHERE user_id = ? AND tenant_id = ? AND slug IS NOT NULL AND slug != ''
           ORDER BY RANDOM()
           LIMIT 16`,
      [userId, tenantId]
    );
    const quickAccessList = Array.isArray(quickAccessBookmarks)
      ? quickAccessBookmarks
      : quickAccessBookmarks
        ? [quickAccessBookmarks]
        : [];

    // Pinned bookmarks (own only, up to 16)
    const pinnedBookmarks = await query(
      `SELECT id, title, url, slug FROM bookmarks
       WHERE user_id = ? AND tenant_id = ? AND ${pinnedCondition}
       ORDER BY COALESCE(updated_at, created_at) DESC
       LIMIT 16`,
      [userId, tenantId]
    );
    const pinnedList = Array.isArray(pinnedBookmarks)
      ? pinnedBookmarks
      : pinnedBookmarks
        ? [pinnedBookmarks]
        : [];

    const plan = (req as any).plan as string | undefined;
    const payload: Record<string, unknown> = {
      totalBookmarks,
      totalFolders,
      totalTags,
      sharedBookmarks,
      sharedFolders,
      recentBookmarks: recentBookmarksEnriched,
      topTags: topTagsList,
      quickAccessBookmarks: quickAccessList,
      pinnedBookmarks: pinnedList,
    };
    if (isCloud && plan) {
      payload.plan = plan;
      payload.bookmarkLimit = plan === 'free' ? 50 : null;
      payload.canShareWithTeams = plan === 'team';
      if (plan === 'free') {
        const tenantCountResult = await queryOne('SELECT COUNT(*) as count FROM bookmarks WHERE tenant_id = ?', [tenantId]);
        payload.tenantBookmarkCount = tenantCountResult ? parseInt(String((tenantCountResult as any).count), 10) : 0;
      }
    }
    res.json(payload);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
