/**
 * Stats aggregation service for admin metrics.
 * Supports both PostgreSQL and SQLite; cloud mode adds plan breakdowns and optional Stripe metrics.
 */

import { query, queryOne } from '../db/index.js';
import { isCloud } from '../config/mode.js';

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
    queryOne('SELECT COUNT(*) as c FROM bookmarks', []),
    queryOne('SELECT COUNT(*) as c FROM folders', []),
    queryOne('SELECT COUNT(*) as c FROM tags', []),
    queryOne(
      'SELECT (SELECT COUNT(*) FROM bookmark_team_shares) + (SELECT COUNT(*) FROM folder_team_shares) as c',
      []
    ),
    queryOne(
      'SELECT (SELECT COUNT(*) FROM bookmark_user_shares) + (SELECT COUNT(*) FROM folder_user_shares) as c',
      []
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

/** Plan breakdowns (cloud only); selfhosted returns empty objects */
export async function getBreakdowns(): Promise<{
  users_by_plan: Record<string, number>;
  bookmarks_by_plan: Record<string, number>;
  folders_by_plan: Record<string, number>;
  tags_by_plan: Record<string, number>;
  shares_by_type: { team: number; user: number };
}> {
  const sharesByType = await getSharesByType();

  if (!isCloud) {
    return {
      users_by_plan: {},
      bookmarks_by_plan: {},
      folders_by_plan: {},
      tags_by_plan: {},
      shares_by_type: sharesByType,
    };
  }

  const [usersByPlan, bookmarksByPlan, foldersByPlan, tagsByPlan] = await Promise.all([
    getUsersByPlan(),
    getBookmarksByPlan(),
    getFoldersByPlan(),
    getTagsByPlan(),
  ]);

  return {
    users_by_plan: usersByPlan,
    bookmarks_by_plan: bookmarksByPlan,
    folders_by_plan: foldersByPlan,
    tags_by_plan: tagsByPlan,
    shares_by_type: sharesByType,
  };
}

async function getSharesByType(): Promise<{ team: number; user: number }> {
  const [teamRes, userRes] = await Promise.all([
    queryOne(
      'SELECT (SELECT COUNT(*) FROM bookmark_team_shares) + (SELECT COUNT(*) FROM folder_team_shares) as c',
      []
    ),
    queryOne(
      'SELECT (SELECT COUNT(*) FROM bookmark_user_shares) + (SELECT COUNT(*) FROM folder_user_shares) as c',
      []
    ),
  ]);
  return {
    team: parseIntOrZero((teamRes as any)?.c),
    user: parseIntOrZero((userRes as any)?.c),
  };
}

async function getUsersByPlan(): Promise<Record<string, number>> {
  const rows = await query(
    `SELECT o.plan, COUNT(om.user_id) as cnt
     FROM org_members om
     INNER JOIN organizations o ON o.id = om.org_id
     GROUP BY o.plan`,
    []
  );
  const result: Record<string, number> = {};
  (Array.isArray(rows) ? rows : []).forEach((r: any) => {
    result[r.plan || 'unknown'] = parseIntOrZero(r.cnt);
  });
  return result;
}

async function getBookmarksByPlan(): Promise<Record<string, number>> {
  const rows = await query(
    `SELECT o.plan, COUNT(b.id) as cnt
     FROM bookmarks b
     INNER JOIN org_members om ON om.user_id = b.user_id
     INNER JOIN organizations o ON o.id = om.org_id
     GROUP BY o.plan`,
    []
  );
  const result: Record<string, number> = {};
  (Array.isArray(rows) ? rows : []).forEach((r: any) => {
    result[r.plan || 'unknown'] = parseIntOrZero(r.cnt);
  });
  return result;
}

async function getFoldersByPlan(): Promise<Record<string, number>> {
  const rows = await query(
    `SELECT o.plan, COUNT(f.id) as cnt
     FROM folders f
     INNER JOIN org_members om ON om.user_id = f.user_id
     INNER JOIN organizations o ON o.id = om.org_id
     GROUP BY o.plan`,
    []
  );
  const result: Record<string, number> = {};
  (Array.isArray(rows) ? rows : []).forEach((r: any) => {
    result[r.plan || 'unknown'] = parseIntOrZero(r.cnt);
  });
  return result;
}

async function getTagsByPlan(): Promise<Record<string, number>> {
  const rows = await query(
    `SELECT o.plan, COUNT(t.id) as cnt
     FROM tags t
     INNER JOIN org_members om ON om.user_id = t.user_id
     INNER JOIN organizations o ON o.id = om.org_id
     GROUP BY o.plan`,
    []
  );
  const result: Record<string, number> = {};
  (Array.isArray(rows) ? rows : []).forEach((r: any) => {
    result[r.plan || 'unknown'] = parseIntOrZero(r.cnt);
  });
  return result;
}

/** Active users: distinct users with bookmark last_accessed_at in window */
export async function getActivity(): Promise<{ active_users_7d: number; active_users_30d: number }> {
  const isPg = DB_TYPE === 'postgresql';

  const since7d = isPg ? "now() - interval '7 days'" : "datetime('now', '-7 days')";
  const since30d = isPg ? "now() - interval '30 days'" : "datetime('now', '-30 days')";

  const [res7d, res30d] = await Promise.all([
    queryOne(
      `SELECT COUNT(DISTINCT user_id) as c FROM bookmarks WHERE last_accessed_at >= ${since7d}`,
      []
    ),
    queryOne(
      `SELECT COUNT(DISTINCT user_id) as c FROM bookmarks WHERE last_accessed_at >= ${since30d}`,
      []
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
      'SELECT user_id, COUNT(*) as cnt FROM bookmarks GROUP BY user_id',
      []
    ),
    query(
      'SELECT user_id, COUNT(*) as cnt FROM folders GROUP BY user_id',
      []
    ),
    query(
      'SELECT user_id, COUNT(*) as cnt FROM tags GROUP BY user_id',
      []
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
  const bookmarks30Sql = `SELECT ${dayExpr} as day, COUNT(*) as count FROM bookmarks WHERE created_at >= ${since30d} GROUP BY 1 ORDER BY 1`;
  const bookmarks90Sql = `SELECT ${dayExpr} as day, COUNT(*) as count FROM bookmarks WHERE created_at >= ${since90d} GROUP BY 1 ORDER BY 1`;

  const [users30, users90, bookmarks30, bookmarks90] = await Promise.all([
    query(users30Sql, []),
    query(users90Sql, []),
    query(bookmarks30Sql, []),
    query(bookmarks90Sql, []),
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

/** Stripe payment metrics (cloud only, when Stripe configured). Returns null or { status: 'disabled' } on skip. */
export async function getStripeStats(): Promise<{
  mrr_cents: number;
  charges_30d: number;
  refunds_30d: number;
  status: 'ok';
} | { status: 'disabled' } | null> {
  if (!isCloud) return { status: 'disabled' };
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) return { status: 'disabled' };

  try {
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(key);

    const now = Math.floor(Date.now() / 1000);
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60;

    const [subscriptions, charges, refunds] = await Promise.all([
      stripe.subscriptions.list({ status: 'active', expand: ['data.items.data.price'] }),
      stripe.balanceTransactions.list({
        type: 'charge',
        created: { gte: thirtyDaysAgo },
        limit: 100,
      }),
      stripe.balanceTransactions.list({
        type: 'refund',
        created: { gte: thirtyDaysAgo },
        limit: 100,
      }),
    ]);

    let mrrCents = 0;
    for (const sub of subscriptions.data) {
      for (const item of sub.items.data) {
        const price = item.price;
        if (!price || !price.recurring) continue;
        const amount = (price.unit_amount || 0) * (item.quantity || 1);
        if (price.recurring.interval === 'month') {
          mrrCents += amount;
        } else if (price.recurring.interval === 'year') {
          mrrCents += Math.round(amount / 12);
        }
      }
    }

    const chargesCount = charges.data.filter((t) => t.status === 'available' || t.status === 'pending').length;
    const refundsCount = refunds.data.length;

    return {
      mrr_cents: mrrCents,
      charges_30d: chargesCount,
      refunds_30d: refundsCount,
      status: 'ok',
    };
  } catch {
    return { status: 'disabled' };
  }
}

/** Aggregate all stats */
export async function aggregateStats(): Promise<{
  core_counts: Awaited<ReturnType<typeof getCoreCounts>>;
  breakdowns: Awaited<ReturnType<typeof getBreakdowns>>;
  activity: Awaited<ReturnType<typeof getActivity>>;
  distributions: Awaited<ReturnType<typeof getDistributions>>;
  timeseries: Awaited<ReturnType<typeof getTimeseries>>;
  payments: Awaited<ReturnType<typeof getStripeStats>>;
}> {
  const [core_counts, breakdowns, activity, distributions, timeseries, payments] = await Promise.all([
    getCoreCounts(),
    getBreakdowns(),
    getActivity(),
    getDistributions(),
    getTimeseries(),
    getStripeStats(),
  ]);

  return {
    core_counts,
    breakdowns,
    activity,
    distributions,
    timeseries,
    payments,
  };
}
