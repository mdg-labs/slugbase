# Grafana + SlugBase Stats Setup

This guide covers monitoring SlugBase with self-hosted Grafana, using either:

- **Option A**: PostgreSQL data source (Neon) — direct SQL for charts
- **Option B**: JSON API data source — consume `/api/admin/stats` for snapshot panels

---

## Prerequisites

- SlugBase deployed (Fly.io + Neon, or self-hosted)
- [Grafana](https://grafana.com/docs/grafana/latest/setup-grafana/installation/) installed

---

## Stats Endpoint Configuration

The stats endpoint is protected by a secret. Configure it before using Grafana.

### 1. Set the secret

Generate a secret:

```bash
openssl rand -hex 32
```

Add to your environment (e.g. Fly secrets, `.env`):

```bash
STATS_ENDPOINT_SECRET=your-generated-secret-here
```

### 2. Test the endpoint

```bash
curl -H "X-Stats-Secret: your-generated-secret-here" \
  https://your-slugbase-url/api/admin/stats
```

### 3. Example response

```json
{
  "core_counts": {
    "users_total": 42,
    "bookmarks_total": 1200,
    "folders_total": 85,
    "tags_total": 200,
    "shares_total": 15
  },
  "breakdowns": {
    "users_by_plan": { "free": 30, "personal": 8, "team": 4 },
    "bookmarks_by_plan": { "free": 400, "personal": 500, "team": 300 },
    "folders_by_plan": {},
    "tags_by_plan": {},
    "shares_by_type": { "team": 10, "user": 5 }
  },
  "activity": {
    "active_users_7d": 12,
    "active_users_30d": 28
  },
  "distributions": {
    "bookmarks_per_user": { "p50": 15, "p90": 80, "p95": 120, "max": 500 },
    "folders_per_user": { "p50": 3, "p90": 12, "p95": 18, "max": 50 },
    "tags_per_user": { "p50": 5, "p90": 25, "p95": 40, "max": 150 }
  },
  "timeseries": {
    "users_30d": [{ "day": "2025-02-01", "count": 2 }, ...],
    "users_90d": [],
    "bookmarks_30d": [],
    "bookmarks_90d": []
  },
  "payments": null
}
```

**Note**: In self-hosted mode, `breakdowns.users_by_plan` and plan breakdowns are empty; `payments` is `null` or `{ "status": "disabled" }`.

---

## Option A: PostgreSQL Data Source

Connect Grafana directly to Neon PostgreSQL for SQL-based panels.

### 1. Add PostgreSQL data source

1. Grafana → **Connections** → **Data sources** → **Add data source**
2. Choose **PostgreSQL**
3. Set:
   - **Host**: `ep-xxx.eu-central-1.aws.neon.tech` (from Neon connection string)
   - **Database**: `neondb`
   - **User / Password**: from Neon
   - **TLS/SSL Mode**: `require`
   - **Version**: 14+ (Neon default)

Connection string format:  
`postgresql://user:password@ep-xxx.eu-central-1.aws.neon.tech/neondb?sslmode=require`

### 2. Read-only role (recommended)

Create a read-only role in Neon for Grafana:

```sql
CREATE ROLE grafana_readonly WITH LOGIN PASSWORD 'secure-password';
GRANT CONNECT ON DATABASE neondb TO grafana_readonly;
GRANT USAGE ON SCHEMA public TO grafana_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO grafana_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO grafana_readonly;
```

Use `grafana_readonly` in the Grafana data source.

### 3. Recommended panels and SQL

| Panel | Type | Query |
|-------|------|-------|
| Total users | Stat | `SELECT COUNT(*) AS value FROM users` |
| Total bookmarks | Stat | `SELECT COUNT(*) AS value FROM bookmarks` |
| Total folders | Stat | `SELECT COUNT(*) AS value FROM folders` |
| Total tags | Stat | `SELECT COUNT(*) AS value FROM tags` |
| Users by plan (cloud) | Pie / Bar | `SELECT o.plan AS metric, COUNT(om.user_id) AS value FROM org_members om INNER JOIN organizations o ON o.id = om.org_id GROUP BY o.plan` |
| Bookmarks by plan (cloud) | Pie / Bar | `SELECT o.plan AS metric, COUNT(b.id) AS value FROM bookmarks b INNER JOIN org_members om ON om.user_id = b.user_id INNER JOIN organizations o ON o.id = om.org_id GROUP BY o.plan` |
| Active users 30d | Stat | `SELECT COUNT(DISTINCT user_id) AS value FROM bookmarks WHERE last_accessed_at >= now() - interval '30 days'` |
| Bookmarks per user p50 | Stat | `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY cnt)::int AS value FROM (SELECT user_id, COUNT(*) AS cnt FROM bookmarks GROUP BY user_id) t` |
| Bookmarks per user p90 | Stat | `SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY cnt)::int AS value FROM (SELECT user_id, COUNT(*) AS cnt FROM bookmarks GROUP BY user_id) t` |
| New users per day | Time series | `SELECT date_trunc('day', created_at)::date AS time, COUNT(*) AS value FROM users WHERE created_at >= now() - interval '30 days' GROUP BY 1 ORDER BY 1` |
| New bookmarks per day | Time series | `SELECT date_trunc('day', created_at)::date AS time, COUNT(*) AS value FROM bookmarks WHERE created_at >= now() - interval '30 days' GROUP BY 1 ORDER BY 1` |
| Shares by type | Bar | `SELECT 'team' AS metric, (SELECT COUNT(*) FROM bookmark_team_shares) + (SELECT COUNT(*) FROM folder_team_shares) AS value UNION ALL SELECT 'user', (SELECT COUNT(*) FROM bookmark_user_shares) + (SELECT COUNT(*) FROM folder_user_shares)` |

### 4. Refresh interval

Set dashboard refresh to **1m** or **5m** for near real-time stats.

---

## Option B: JSON API Data Source

Use the stats endpoint for table/stat panels without direct DB access.

### 1. Install JSON API plugin

1. Grafana → **Administration** → **Plugins**
2. Search for **JSON API** (marcusolsson-json-datasource)
3. Install

### 2. Add JSON API data source

1. **Connections** → **Data sources** → **Add data source**
2. Choose **JSON API**
3. **URL**: `https://your-slugbase-url/api/admin/stats`
4. **Headers**: Add `X-Stats-Secret` with your secret value

### 3. Configure requests

For a stat panel:

- **Path**: `core_counts.users_total` (or any nested path)
- **Method**: GET

For a table showing all core counts:

- **Path**: `core_counts`
- Format as table with columns: `users_total`, `bookmarks_total`, etc.

### 4. No-plugin alternative

If you prefer not to install a plugin:

- Use **PostgreSQL** for time series and aggregated metrics (Option A), or
- Use **Infinity** data source (built-in in newer Grafana) to fetch JSON from a URL with custom headers

---

## Dashboard Refresh

- **PostgreSQL panels**: 1–5 minutes
- **JSON API panels**: 1–5 minutes (aligned with endpoint cache of 60s)

---

## Implementation Summary

### Already present (before implementation)

- DB schema: users, bookmarks, folders, tags, organizations, org_members, shares tables
- Mode config: `SLUGBASE_MODE` (selfhosted/cloud)
- Stripe: billing routes, webhook, org.plan
- Admin routes: users, teams, settings (JWT + admin)
- Dashboard stats: per-user only
- Rate limiting, security middleware

### Added

- **Migration 014**: Indexes for `created_at` on bookmarks, users, folders, tags
- **Stats service** (`backend/src/services/stats.ts`): core_counts, breakdowns, activity, distributions, timeseries, Stripe (cloud only)
- **Stats endpoint**: `GET /api/admin/stats` with `X-Stats-Secret` header, 60s cache
- **Stats auth middleware**: `statsSecretAuth` using `crypto.timingSafeEqual`
- **Env**: `STATS_ENDPOINT_SECRET` (optional)
- **Tests**: `test/stats.test.ts` (unit tests for stats service)
- **Docs**: This Grafana + Stats guide

---

## Related

- [Fly.io + Neon deployment](fly-neon.md)
- [SlugBase documentation](https://docs.slugbase.app)
