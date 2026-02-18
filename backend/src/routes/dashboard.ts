import { Router } from 'express';
import { query, queryOne } from '../db/index.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { isCloud } from '../config/mode.js';
import { getCurrentOrgId } from '../utils/organizations.js';
import { getTeamIdsForUser, getTeamIdsForUserInOrg } from '../auth/authorization.js';

const router = Router();

/**
 * @swagger
 * /api/dashboard/stats:
 *   get:
 *     summary: Get dashboard statistics
 *     description: Returns statistics for the authenticated user's dashboard
 *     tags: [Dashboard]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 totalBookmarks:
 *                   type: number
 *                 totalFolders:
 *                   type: number
 *                 totalTags:
 *                   type: number
 *                 sharedBookmarks:
 *                   type: number
 *                 sharedFolders:
 *                   type: number
 *                 recentBookmarks:
 *                   type: array
 *                 topTags:
 *                   type: array
 *       401:
 *         description: Unauthorized
 */
router.get('/stats', requireAuth(), async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const orgId = isCloud ? await getCurrentOrgId(userId) : null;

    // Get user's teams (org-scoped in cloud mode)
    const teamIds = orgId
      ? await getTeamIdsForUserInOrg(userId, orgId)
      : await getTeamIdsForUser(userId);

    // Total bookmarks (own only)
    const totalBookmarksResult = await queryOne(
      'SELECT COUNT(*) as count FROM bookmarks WHERE user_id = ?',
      [userId]
    );
    const totalBookmarks = totalBookmarksResult ? parseInt((totalBookmarksResult as any).count) : 0;

    // Total folders (own only)
    const totalFoldersResult = await queryOne(
      'SELECT COUNT(*) as count FROM folders WHERE user_id = ?',
      [userId]
    );
    const totalFolders = totalFoldersResult ? parseInt((totalFoldersResult as any).count) : 0;

    // Total tags (own only)
    const totalTagsResult = await queryOne(
      'SELECT COUNT(*) as count FROM tags WHERE user_id = ?',
      [userId]
    );
    const totalTags = totalTagsResult ? parseInt((totalTagsResult as any).count) : 0;

    // Shared bookmarks count (bookmarks shared with user)
    // Use simpler queries that don't cause cartesian products
    const sharedBookmarkIds = new Set<string>();
    
    // Direct user shares (org-scoped in cloud: only from owners in same org)
    const userSharedBookmarksSql = orgId
      ? `SELECT DISTINCT bus.bookmark_id FROM bookmark_user_shares bus
         INNER JOIN bookmarks b ON b.id = bus.bookmark_id
         WHERE bus.user_id = ? AND b.user_id IN (SELECT user_id FROM org_members WHERE org_id = ?)`
      : 'SELECT DISTINCT bookmark_id FROM bookmark_user_shares WHERE user_id = ?';
    const userSharedBookmarks = await query(
      userSharedBookmarksSql,
      orgId ? [userId, orgId] : [userId]
    );
    (Array.isArray(userSharedBookmarks) ? userSharedBookmarks : []).forEach((row: any) => {
      if (row.bookmark_id) sharedBookmarkIds.add(row.bookmark_id);
    });
    
    // Team shares
    if (teamIds.length > 0) {
      const teamSharedBookmarks = await query(
        `SELECT DISTINCT bookmark_id FROM bookmark_team_shares WHERE team_id IN (${teamIds.map(() => '?').join(',')})`,
        teamIds
      );
      (Array.isArray(teamSharedBookmarks) ? teamSharedBookmarks : []).forEach((row: any) => {
        if (row.bookmark_id) sharedBookmarkIds.add(row.bookmark_id);
      });
    }
    
    // Folder user shares (org-scoped in cloud: only from owners in same org)
    const folderUserSharesSql = orgId
      ? `SELECT DISTINCT fus.folder_id FROM folder_user_shares fus
         INNER JOIN folders f ON f.id = fus.folder_id
         WHERE fus.user_id = ? AND f.user_id IN (SELECT user_id FROM org_members WHERE org_id = ?)`
      : 'SELECT DISTINCT folder_id FROM folder_user_shares WHERE user_id = ?';
    const folderUserShares = await query(
      folderUserSharesSql,
      orgId ? [userId, orgId] : [userId]
    );
    if (Array.isArray(folderUserShares) && folderUserShares.length > 0) {
      const folderIds = folderUserShares.map((row: any) => row.folder_id).filter(Boolean);
      if (folderIds.length > 0) {
        const bookmarkFolderShares = await query(
          `SELECT DISTINCT bookmark_id FROM bookmark_folders WHERE folder_id IN (${folderIds.map(() => '?').join(',')})`,
          folderIds
        );
        (Array.isArray(bookmarkFolderShares) ? bookmarkFolderShares : []).forEach((row: any) => {
          if (row.bookmark_id) sharedBookmarkIds.add(row.bookmark_id);
        });
      }
    }
    
    // Folder team shares
    if (teamIds.length > 0) {
      const folderTeamShares = await query(
        `SELECT DISTINCT folder_id FROM folder_team_shares WHERE team_id IN (${teamIds.map(() => '?').join(',')})`,
        teamIds
      );
      if (Array.isArray(folderTeamShares) && folderTeamShares.length > 0) {
        const folderIds = folderTeamShares.map((row: any) => row.folder_id).filter(Boolean);
        if (folderIds.length > 0) {
          const bookmarkFolderShares = await query(
            `SELECT DISTINCT bookmark_id FROM bookmark_folders WHERE folder_id IN (${folderIds.map(() => '?').join(',')})`,
            folderIds
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
        `SELECT COUNT(*) as count FROM bookmarks WHERE id IN (${sharedBookmarkIdsArray.map(() => '?').join(',')}) AND user_id != ?`,
        [...sharedBookmarkIdsArray, userId]
      );
      sharedBookmarks = sharedBookmarksResult ? parseInt((sharedBookmarksResult as any).count) : 0;
    }

    // Shared folders count (folders shared with user)
    const sharedFolderIds = new Set<string>();
    
    // Direct user shares (org-scoped in cloud: only from owners in same org)
    const userSharedFolders = await query(
      orgId ? folderUserSharesSql : 'SELECT DISTINCT folder_id FROM folder_user_shares WHERE user_id = ?',
      orgId ? [userId, orgId] : [userId]
    );
    (Array.isArray(userSharedFolders) ? userSharedFolders : []).forEach((row: any) => {
      if (row.folder_id) sharedFolderIds.add(row.folder_id);
    });
    
    // Team shares
    if (teamIds.length > 0) {
      const teamSharedFolders = await query(
        `SELECT DISTINCT folder_id FROM folder_team_shares WHERE team_id IN (${teamIds.map(() => '?').join(',')})`,
        teamIds
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
        `SELECT COUNT(*) as count FROM folders WHERE id IN (${sharedFolderIdsArray.map(() => '?').join(',')}) AND user_id != ?`,
        [...sharedFolderIdsArray, userId]
      );
      sharedFolders = sharedFoldersResult ? parseInt((sharedFoldersResult as any).count) : 0;
    }

    // Recent bookmarks (last 5, own only) with last_accessed_at
    const recentBookmarks = await query(
      'SELECT id, title, url, created_at, last_accessed_at FROM bookmarks WHERE user_id = ? ORDER BY created_at DESC LIMIT 5',
      [userId]
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
         WHERE bf.bookmark_id IN (${placeholders})`,
        bookmarkIds
      ) as any[];
      const tagRows = await query(
        `SELECT bt.bookmark_id, t.name
         FROM bookmark_tags bt
         INNER JOIN tags t ON bt.tag_id = t.id
         WHERE bt.bookmark_id IN (${placeholders})`,
        bookmarkIds
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

    // Top tags (most used, top 5)
    const topTags = await query(
      `SELECT t.id, t.name, COUNT(bt.bookmark_id) as bookmark_count
       FROM tags t
       INNER JOIN bookmark_tags bt ON t.id = bt.tag_id
       INNER JOIN bookmarks b ON bt.bookmark_id = b.id
       WHERE t.user_id = ?
       GROUP BY t.id, t.name
       ORDER BY bookmark_count DESC
       LIMIT 5`,
      [userId]
    );
    const topTagsList = Array.isArray(topTags) ? topTags : (topTags ? [topTags] : []);

    res.json({
      totalBookmarks,
      totalFolders,
      totalTags,
      sharedBookmarks,
      sharedFolders,
      recentBookmarks: recentBookmarksEnriched,
      topTags: topTagsList,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
