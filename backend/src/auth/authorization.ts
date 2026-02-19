/**
 * Centralized authorization: can user access or modify a resource?
 * Used by bookmarks, folders, and tags routes to avoid duplicated checks and IDOR.
 */

import { queryOne, query } from '../db/index.js';

const DB_TYPE = process.env.DB_TYPE || 'sqlite';

/** Convert ? placeholders to $1, $2 for PostgreSQL */
function toPg(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

function runSql(sql: string, params: any[]): [string, any[]] {
  return DB_TYPE === 'postgresql' ? [toPg(sql), params] : [sql, params];
}

/** Get team IDs the user is a member of (for share checks). */
export async function getTeamIdsForUser(userId: string, tenantId: string = 'default'): Promise<string[]> {
  const [q, p] = runSql('SELECT team_id FROM team_members WHERE user_id = ? AND tenant_id = ?', [userId, tenantId]);
  const rows = await query(q, p);
  const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
  return list.map((r: any) => r.team_id);
}

/** Legacy compatibility helper; org scoping is removed in selfhost-core. */
export async function getTeamIdsForUserInOrg(userId: string, _orgId: string, tenantId: string = 'default'): Promise<string[]> {
  return getTeamIdsForUser(userId, tenantId);
}

/**
 * Can the user read this bookmark? (owner, or shared via user/team/folder)
 * @param _orgId - Legacy arg kept for compatibility.
 */
export async function canAccessBookmark(userId: string, bookmarkId: string, _orgId?: string | null, tenantId: string = 'default'): Promise<boolean> {
  const teamIds = await getTeamIdsForUser(userId, tenantId);
  const teamPlaceholders = teamIds.length > 0 ? teamIds.map(() => '?').join(',') : 'NULL';
  const busCondition = 'bus.user_id = ?';
  const fusCondition = 'fus.user_id = ?';
  const sql = `
    SELECT 1 FROM bookmarks b
    LEFT JOIN bookmark_user_shares bus ON b.id = bus.bookmark_id
    LEFT JOIN bookmark_team_shares bts ON b.id = bts.bookmark_id
    LEFT JOIN bookmark_folders bf ON b.id = bf.bookmark_id
    LEFT JOIN folder_user_shares fus ON bf.folder_id = fus.folder_id
    LEFT JOIN folder_team_shares fts ON bf.folder_id = fts.folder_id
    WHERE b.id = ? AND b.tenant_id = ? AND (b.user_id = ?
      OR ${busCondition}
      OR (bts.team_id IN (${teamPlaceholders}) AND bts.team_id IS NOT NULL)
      OR ${fusCondition}
      OR (fts.team_id IN (${teamPlaceholders}) AND fts.team_id IS NOT NULL AND bf.folder_id IS NOT NULL))
  `;
  const params: any[] = [bookmarkId, tenantId, userId];
  params.push(userId, userId);
  if (teamIds.length > 0) {
    params.push(...teamIds);
    params.push(...teamIds);
  }
  const [q, p] = runSql(sql, params);
  const row = await queryOne(q, p);
  return !!row;
}

/** Can the user update/delete this bookmark? (owner only) */
export async function canModifyBookmark(userId: string, bookmarkId: string, tenantId: string = 'default'): Promise<boolean> {
  const [q, p] = runSql('SELECT 1 FROM bookmarks WHERE id = ? AND user_id = ? AND tenant_id = ?', [bookmarkId, userId, tenantId]);
  const row = await queryOne(q, p);
  return !!row;
}

/**
 * Can the user read this folder? (owner or shared via user/team)
 * @param _orgId - Legacy arg kept for compatibility.
 */
export async function canAccessFolder(userId: string, folderId: string, _orgId?: string | null, tenantId: string = 'default'): Promise<boolean> {
  const teamIds = await getTeamIdsForUser(userId, tenantId);
  const teamPlaceholders = teamIds.length > 0 ? teamIds.map(() => '?').join(',') : 'NULL';
  const fusCondition = 'fus.user_id = ?';
  const sql = `
    SELECT 1 FROM folders f
    LEFT JOIN folder_user_shares fus ON f.id = fus.folder_id
    LEFT JOIN folder_team_shares fts ON f.id = fts.folder_id
    WHERE f.id = ? AND f.tenant_id = ? AND (f.user_id = ?
      OR ${fusCondition}
      OR (fts.team_id IN (${teamPlaceholders}) AND fts.team_id IS NOT NULL))
  `;
  const params: any[] = [folderId, tenantId, userId];
  params.push(userId);
  if (teamIds.length > 0) params.push(...teamIds);
  const [q, p] = runSql(sql, params);
  const row = await queryOne(q, p);
  return !!row;
}

/** Can the user update/delete this folder? (owner only) */
export async function canModifyFolder(userId: string, folderId: string, tenantId: string = 'default'): Promise<boolean> {
  const [q, p] = runSql('SELECT 1 FROM folders WHERE id = ? AND user_id = ? AND tenant_id = ?', [folderId, userId, tenantId]);
  const row = await queryOne(q, p);
  return !!row;
}

/** Can the user read this tag? (owner only; tags are not shared) */
export async function canAccessTag(userId: string, tagId: string, tenantId: string = 'default'): Promise<boolean> {
  const [q, p] = runSql('SELECT 1 FROM tags WHERE id = ? AND user_id = ? AND tenant_id = ?', [tagId, userId, tenantId]);
  const row = await queryOne(q, p);
  return !!row;
}
