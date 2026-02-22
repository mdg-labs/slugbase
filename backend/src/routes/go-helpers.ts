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
 * @param orgId - Legacy arg kept for compatibility.
 */
export async function getAccessibleBookmarksBySlug(
  userId: string,
  slug: string,
  orgId?: string | null,
  tenantId: string = 'default'
): Promise<BookmarkCandidate[]> {
  const teamIds = orgId
    ? await getTeamIdsForUserInOrg(userId, orgId, tenantId)
    : await getTeamIdsForUser(userId, tenantId);
  const teamPlaceholders = teamIds.length > 0 ? teamIds.map(() => '?').join(',') : 'NULL';
  const busCond = 'bus.user_id = ?';
  const fusCond = 'fus.user_id = ?';

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
    WHERE b.tenant_id = ?
      AND (b.user_id = ?
      OR ${busCond}
      OR (bts.team_id IN (${teamPlaceholders}) AND bts.team_id IS NOT NULL)
      OR ${fusCond}
      OR (fts.team_id IN (${teamPlaceholders}) AND fts.team_id IS NOT NULL AND bf.folder_id IS NOT NULL))
      AND b.slug = ? AND b.forwarding_enabled = TRUE
  `;
  const params: any[] = [userId, tenantId, userId];
  params.push(userId, userId);
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
