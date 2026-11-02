---
title: Check the Bookmark Counter
description: Find workspaces whose bookmark counter differs from the number of their bookmarks, without changing anything.
edition: ce
---

Each workspace keeps a counter of its bookmarks. SlugBase reads that counter, and not the bookmarks themselves, when it checks a bookmark limit. This page shows a read-only SQL statement that lists every workspace whose counter differs from the number of its bookmarks, except a workspace that is being deleted.

A healthy installation lists nothing. The statement changes no data.

## Prerequisites

- Access to the SlugBase database with a SQL client such as `psql`.
- The migration login, the user in `DATABASE_MIGRATE_URL`. The application login sees one workspace at a time, so it cannot run this check.

## Run the check

1. Connect to the SlugBase database with the migration login. On a `compose.yml` installation the database publishes no port, so open `psql` inside the `postgres` service: `docker compose exec postgres psql -U slugbase_migrator -d slugbase`. If `psql` asks for a password, it is the value of `MIGRATOR_DB_PASSWORD` that you give `compose.yml`.
2. Run the statement below.

```sql
BEGIN READ ONLY;
SET LOCAL ROLE slugbase_system;
SELECT w.id AS workspace_id,
       w.bookmark_count AS counter,
       count(b.id) AS bookmarks,
       w.bookmark_count - count(b.id) AS difference
FROM workspaces w
LEFT JOIN bookmarks b ON b.workspace_id = w.id AND b.plan_archived_at IS NULL
WHERE w.deleting_at IS NULL
GROUP BY w.id, w.bookmark_count
HAVING w.bookmark_count <> count(b.id)
ORDER BY w.id;
COMMIT;
```

The first line opens a read-only transaction, so the database refuses any change made inside it. The second line switches to the role that can read every workspace. The statement reads every bookmark once, so it takes longer on a large installation.

## Read the result

No rows means every counter matches. Each row is a workspace that does not match.

A workspace that is being deleted never appears. SlugBase removes its bookmarks in batches and leaves the counter alone until the workspace itself is gone, so the two differ for a while on purpose.

| Column | Meaning |
| ------ | ------- |
| `workspace_id` | The workspace. |
| `counter` | The number the workspace's counter holds. |
| `bookmarks` | The number of the workspace's bookmarks that count towards it. |
| `difference` | `counter` minus `bookmarks`. A positive number means the counter is too high. |

A bookmark that a plan limit has archived does not count towards the counter. A self-hosted installation does not archive bookmarks this way, so there `bookmarks` is the number of all the workspace's bookmarks.

## Troubleshooting

**The statement fails with a permission error on `slugbase_system`.** You are connected as the application login, or as a login that is not the migration login. Connect with the migration login and run it again.

**The statement lists a workspace.** Do not edit the counter by hand. Report the workspace's `counter` and `bookmarks` numbers, and what you did to the workspace before, in an issue at https://github.com/mdg-labs/slugbase/issues.
