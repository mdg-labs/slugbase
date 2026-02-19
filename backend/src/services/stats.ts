/**
 * Stats aggregation service for admin metrics (selfhost-core).
 * All metrics are tenant-scoped to the default tenant.
 */

import { query, queryOne } from '../db/index.js';
import { DEFAULT_TENANT_ID } from '../utils/tenant.js';

const DB_TYPE = process.env.DB_TYPE || 'sqlite';

function parseIntOrZero(val: unknown): number {
  if (val === null || val === undefined) return 0;
  const n = parseInt(String(val), 10);
  return isNaN(n) ? 0 : n;
}

/** Core counts: users, bookmarks, folders, tags, shares */
export async function getCoreCounts(): Promise<{
  users_total: number;
  bookmarks_total: number;
  folders_total: number;
  tags_total: number;
  shares_total: number;
}> {
  const [usersRes, bookmarksRes, foldersRes, tagsRes, teamSharesRes, userSharesRes] = await Promise.all([
    queryOne('SELECT COUNT(*) as c FROM users', []),
    queryOne('SELECT COUNT(*) as c FROM bookmarks WHERE tenant_id = ?', [DEFAULT_TENANT_ID]),
    queryOne('SELECT COUNT(*) as c FROM folders WHERE tenant_id = ?', [DEFAULT_TENANT_ID]),
    queryOne('SELECT COUNT(*) as c FROM tags WHERE tenant_id = ?', [DEFAULT_TENANT_ID]),
    queryOne(
      'SELECT (SELECT COUNT(*) FROM bookmark_team_shares WHERE tenant_id = ?) + (SELECT COUNT(*) FROM folder_team_shares WHERE tenant_id = ?) as c',
      [DEFAULT_TENANT_ID, DEFAULT_TENANT_ID]
    ),
    queryOne(
      'SELECT (SELECT COUNT(*) FROM bookmark_user_shares WHERE tenant_id = ?) + (SELECT COUNT(*) FROM folder_user_shares WHERE tenant_id = ?) as c',
      [DEFAULT_TENANT_ID, DEFAULT_TENANT_ID]
    ),
  ]);

  const teamShares = parseIntOrZero((teamSharesRes as any)?.c);
  const userShares = parseIntOrZero((userSharesRes as any)?.c);

  return {
    users_total: parseIntOrZero((usersRes as any)?.c),
    bookmarks_total: parseIntOrZero((bookmarksRes as any)?.c),
    folders_total: parseIntOrZero((foldersRes as any)?.c),
    tags_total: parseIntOrZero((tagsRes as any)?.c),
    shares_total: teamShares + userShares,
  };
}

/** Selfhost breakdowns */
export async function getBreakdowns(): Promise<{
  shares_by_type: { team: number; user: number };
}> {
  const sharesByType = await getSharesByType();
  return {
    shares_by_type: sharesByType,
  };
}

async function getSharesByType(): Promise<{ team: number; user: number }> {
  const [teamRes, userRes] = await Promise.all([
    queryOne(
      'SELECT (SELECT COUNT(*) FROM bookmark_team_shares WHERE tenant_id = ?) + (SELECT COUNT(*) FROM folder_team_shares WHERE tenant_id = ?) as c',
      [DEFAULT_TENANT_ID, DEFAULT_TENANT_ID]
    ),
    queryOne(
      'SELECT (SELECT COUNT(*) FROM bookmark_user_shares WHERE tenant_id = ?) + (SELECT COUNT(*) FROM folder_user_shares WHERE tenant_id = ?) as c',
      [DEFAULT_TENANT_ID, DEFAULT_TENANT_ID]
    ),
  ]);
  return {
    team: parseIntOrZero((teamRes as any)?.c),
    user: parseIntOrZero((userRes as any)?.c),
  };
}

/** Active users: distinct users with bookmark last_accessed_at in window */
export async function getActivity(): Promise<{ active_users_7d: number; active_users_30d: number }> {
  const isPg = DB_TYPE === 'postgresql';

  const since7d = isPg ? "now() - interval '7 days'" : "datetime('now', '-7 days')";
  const since30d = isPg ? "now() - interval '30 days'" : "datetime('now', '-30 days')";

  const [res7d, res30d] = await Promise.all([
    queryOne(
      `SELECT COUNT(DISTINCT user_id) as c FROM bookmarks WHERE tenant_id = ? AND last_accessed_at >= ${since7d}`,
      [DEFAULT_TENANT_ID]
    ),
    queryOne(
      `SELECT COUNT(DISTINCT user_id) as c FROM bookmarks WHERE tenant_id = ? AND last_accessed_at >= ${since30d}`,
      [DEFAULT_TENANT_ID]
    ),
  ]);

  return {
    active_users_7d: parseIntOrZero((res7d as any)?.c),
    active_users_30d: parseIntOrZero((res30d as any)?.c),
  };
}

/** Percentile from sorted array */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo]);
}

/** Distributions: bookmarks/folders/tags per user (p50, p90, p95, max) */
export async function getDistributions(): Promise<{
  bookmarks_per_user: { p50: number; p90: number; p95: number; max: number };
  folders_per_user: { p50: number; p90: number; p95: number; max: number };
  tags_per_user: { p50: number; p90: number; p95: number; max: number };
}> {
  const [bookmarkCounts, folderCounts, tagCounts] = await Promise.all([
    query(
      'SELECT user_id, COUNT(*) as cnt FROM bookmarks WHERE tenant_id = ? GROUP BY user_id',
      [DEFAULT_TENANT_ID]
    ),
    query(
      'SELECT user_id, COUNT(*) as cnt FROM folders WHERE tenant_id = ? GROUP BY user_id',
      [DEFAULT_TENANT_ID]
    ),
    query(
      'SELECT user_id, COUNT(*) as cnt FROM tags WHERE tenant_id = ? GROUP BY user_id',
      [DEFAULT_TENANT_ID]
    ),
  ]);

  const toPercentiles = (rows: any[]): { p50: number; p90: number; p95: number; max: number } => {
    const counts = rows.map((r) => parseIntOrZero(r.cnt)).sort((a, b) => a - b);
    return {
      p50: percentile(counts, 50),
      p90: percentile(counts, 90),
      p95: percentile(counts, 95),
      max: counts.length > 0 ? Math.max(...counts) : 0,
    };
  };

  const bList = Array.isArray(bookmarkCounts) ? bookmarkCounts : [];
  const fList = Array.isArray(folderCounts) ? folderCounts : [];
  const tList = Array.isArray(tagCounts) ? tagCounts : [];

  return {
    bookmarks_per_user: toPercentiles(bList),
    folders_per_user: toPercentiles(fList),
    tags_per_user: toPercentiles(tList),
  };
}

/** Timeseries: users and bookmarks per day for last 30d and 90d */
export async function getTimeseries(): Promise<{
  users_30d: Array<{ day: string; count: number }>;
  users_90d: Array<{ day: string; count: number }>;
  bookmarks_30d: Array<{ day: string; count: number }>;
  bookmarks_90d: Array<{ day: string; count: number }>;
}> {
  const isPg = DB_TYPE === 'postgresql';

  const dayExpr = isPg ? "date_trunc('day', created_at)::date" : "date(created_at)";
  const since30d = isPg ? "now() - interval '30 days'" : "datetime('now', '-30 days')";
  const since90d = isPg ? "now() - interval '90 days'" : "datetime('now', '-90 days')";

  const users30Sql = `SELECT ${dayExpr} as day, COUNT(*) as count FROM users WHERE created_at >= ${since30d} GROUP BY 1 ORDER BY 1`;
  const users90Sql = `SELECT ${dayExpr} as day, COUNT(*) as count FROM users WHERE created_at >= ${since90d} GROUP BY 1 ORDER BY 1`;
  const bookmarks30Sql = `SELECT ${dayExpr} as day, COUNT(*) as count FROM bookmarks WHERE tenant_id = ? AND created_at >= ${since30d} GROUP BY 1 ORDER BY 1`;
  const bookmarks90Sql = `SELECT ${dayExpr} as day, COUNT(*) as count FROM bookmarks WHERE tenant_id = ? AND created_at >= ${since90d} GROUP BY 1 ORDER BY 1`;

  const [users30, users90, bookmarks30, bookmarks90] = await Promise.all([
    query(users30Sql, []),
    query(users90Sql, []),
    query(bookmarks30Sql, [DEFAULT_TENANT_ID]),
    query(bookmarks90Sql, [DEFAULT_TENANT_ID]),
  ]);

  const toSeries = (rows: any[]): Array<{ day: string; count: number }> =>
    (Array.isArray(rows) ? rows : []).map((r: any) => ({
      day: r.day ? String(r.day).split('T')[0] : '',
      count: parseIntOrZero(r.count),
    }));

  return {
    users_30d: toSeries(users30),
    users_90d: toSeries(users90),
    bookmarks_30d: toSeries(bookmarks30),
    bookmarks_90d: toSeries(bookmarks90),
  };
}

/** Aggregate all stats */
export async function aggregateStats(): Promise<{
  core_counts: Awaited<ReturnType<typeof getCoreCounts>>;
  breakdowns: Awaited<ReturnType<typeof getBreakdowns>>;
  activity: Awaited<ReturnType<typeof getActivity>>;
  distributions: Awaited<ReturnType<typeof getDistributions>>;
  timeseries: Awaited<ReturnType<typeof getTimeseries>>;
}> {
  const [core_counts, breakdowns, activity, distributions, timeseries] = await Promise.all([
    getCoreCounts(),
    getBreakdowns(),
    getActivity(),
    getDistributions(),
    getTimeseries(),
  ]);

  return {
    core_counts,
    breakdowns,
    activity,
    distributions,
    timeseries,
  };
}
