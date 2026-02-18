/**
 * Helpers for /go slug resolution and bookmark lookup
 */

import { query, queryOne } from '../db/index.js';
import { getTeamIdsForUser, getTeamIdsForUserInOrg } from '../auth/authorization.js';

const DB_TYPE = process.env.DB_TYPE || 'sqlite';

/** Convert ? placeholders to $1, $2 for PostgreSQL */
function toPg(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

function runSql(sql: string, params: any[]): [string, any[]] {
  return DB_TYPE === 'postgresql' ? [toPg(sql), params] : [sql, params];
}

export interface BookmarkCandidate {
  id: string;
  title: string;
  url: string;
  slug: string;
  user_id: string;
  workspace: string; // 'Personal' or team name or owner name for shared
}

/**
 * Get all bookmarks accessible to the user that match the slug and have forwarding enabled.
 * Returns candidates with workspace labels for collision UI.
 * @param orgId - Optional. In cloud mode, pass to scope team shares to current org.
 */
export async function getAccessibleBookmarksBySlug(
  userId: string,
  slug: string,
  orgId?: string | null
): Promise<BookmarkCandidate[]> {
  const teamIds = orgId
    ? await getTeamIdsForUserInOrg(userId, orgId)
    : await getTeamIdsForUser(userId);
  const teamPlaceholders = teamIds.length > 0 ? teamIds.map(() => '?').join(',') : 'NULL';
  const busCond = orgId ? '(bus.user_id = ? AND b.user_id IN (SELECT user_id FROM org_members WHERE org_id = ?))' : 'bus.user_id = ?';
  const fusCond = orgId ? '(fus.user_id = ? AND bf.folder_id IN (SELECT id FROM folders WHERE user_id IN (SELECT user_id FROM org_members WHERE org_id = ?)))' : 'fus.user_id = ?';

  const sql = `
    SELECT DISTINCT b.id, b.title, b.url, b.slug, b.user_id,
           CASE WHEN b.user_id = ? THEN 'Personal' ELSE COALESCE(u.name, u.email, 'Shared') END as workspace
    FROM bookmarks b
    LEFT JOIN bookmark_user_shares bus ON b.id = bus.bookmark_id
    LEFT JOIN bookmark_team_shares bts ON b.id = bts.bookmark_id
    LEFT JOIN bookmark_folders bf ON b.id = bf.bookmark_id
    LEFT JOIN folder_user_shares fus ON bf.folder_id = fus.folder_id
    LEFT JOIN folder_team_shares fts ON bf.folder_id = fts.folder_id
    LEFT JOIN users u ON b.user_id = u.id
    WHERE (b.user_id = ?
      OR ${busCond}
      OR (bts.team_id IN (${teamPlaceholders}) AND bts.team_id IS NOT NULL)
      OR ${fusCond}
      OR (fts.team_id IN (${teamPlaceholders}) AND fts.team_id IS NOT NULL AND bf.folder_id IS NOT NULL))
      AND b.slug = ? AND b.forwarding_enabled = TRUE
  `;
  const params: any[] = [userId, userId];
  if (orgId) {
    params.push(userId, orgId, userId, orgId);
  } else {
    params.push(userId, userId);
  }
  if (teamIds.length > 0) {
    params.push(...teamIds);
    params.push(...teamIds);
  }
  params.push(slug);

  const [q, p] = runSql(sql, params);
  const rows = await query(q, p);
  const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
  return list.map((r: any) => ({
    id: r.id,
    title: r.title,
    url: r.url,
    slug: r.slug,
    user_id: r.user_id,
    workspace: r.workspace || 'Shared',
  }));
}
