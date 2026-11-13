---
title: Remove a Bookmark as the Operator
description: Remove one bookmark of any workspace with SQL, whoever owns it, when a legal order or a moderation decision requires it.
edition: ce
---

Sometimes you must remove one bookmark: a court or authority order, or a moderation decision under your own terms. A member can delete only their own bookmarks. A bookmark whose owner has left the workspace has no owner, and the workspace's owners and admins can delete or reassign it on the **Members** page (see [Members](../user/workspace/members.mdx#see-reassign-and-delete-the-content-of-former-members)). This page is for every other removal: a bookmark a member still owns, or a workspace whose owners and admins cannot or will not act. It shows the SQL statement that removes one bookmark, whoever owns it, and records that you did.

The removal is final. SlugBase has no trash and no undo.

## Prerequisites

- Access to the SlugBase database with a SQL client such as `psql`.
- The migration login, the user in `DATABASE_MIGRATE_URL`. The application login cannot run this procedure.
- A recent backup, because the removal cannot be undone. See [Back up and restore](backup-restore.md).
- The identifier of the workspace and of the bookmark. Step 2 shows how to find them.
- A short reason for the removal, for example a reference number. Read [What the workspace sees](#what-the-workspace-sees) first.

## Remove a bookmark

1. Connect to the SlugBase database with the migration login. On a `compose.yml` installation the database publishes no port, so open `psql` inside the `postgres` service: `docker compose exec postgres psql -U slugbase_migrator -d slugbase`. If `psql` asks for a password, it is the value of `MIGRATOR_DB_PASSWORD` that you give `compose.yml`.
2. Find the bookmark. The statement below changes no data. Put the address or the slug of the bookmark in place of the two values.

```sql
BEGIN READ ONLY;
SET LOCAL ROLE slugbase_system;
SELECT w.id AS workspace_id,
       w.name AS workspace,
       b.id AS bookmark_id,
       b.title,
       b.url,
       b.slug,
       b.owner_id IS NULL AS ownerless
FROM bookmarks b
JOIN workspaces w ON w.id = b.workspace_id
WHERE b.url = 'https://example.com/page' OR b.slug = 'terms'
ORDER BY w.id, b.id;
COMMIT;
```

3. Make an identifier for the record of the removal. On the host, run `docker compose exec postgres cat /proc/sys/kernel/random/uuid`. Each removal needs a new one.
4. Run the removal. Put the identifiers from steps 2 and 3, and your reason, in place of the example values.

```sql
BEGIN;
SET LOCAL ROLE slugbase_system;
SELECT sys_bookmark_operator_delete(
  '0192f3a0-3480-7000-8000-00000000a001',
  '0192f3a0-3481-7000-8000-000000000001',
  '5b0e6a1c-0f58-4d6e-9a53-0b3c1d7f2e44',
  'Court order, ref. 2026-123'
);
COMMIT;
```

The statements run as one transaction, so the bookmark, the workspace counter and the record of the removal change together or not at all. If a statement fails, run `ROLLBACK;` and start again.

The four values of `sys_bookmark_operator_delete` are, in order:

| Value | Meaning |
| ----- | ------- |
| Workspace | The `workspace_id` from step 2. |
| Bookmark | The `bookmark_id` from step 2. |
| Record | The new identifier from step 3. |
| Reason | One to 100 characters, with no line break or other control character. |

## Read the result

The statement answers `t` or `f`.

| Answer | Meaning |
| ------ | ------- |
| `t` | The bookmark is removed, the workspace counter is lowered and the record is written. |
| `f` | Nothing changed. The bookmark is already gone, the identifiers do not belong together, or the workspace is being deleted. |

A bookmark in another workspace than the one you name is never removed. Check both identifiers against the result of step 2.

## What goes with the bookmark

The removal deletes the bookmark and everything that hangs on it:

- Its slug. `/go/<slug>` no longer finds it, for any member.
- Its shares to members and teams.
- Its place in every folder.
- Its tag links. The tags and the folders themselves stay.
- Each member's remembered choice for the slug.
- Its pin and its open count.

A bookmark that a plan limit archived is removed too. SlugBase does not count an archived bookmark towards the workspace counter, so the counter stays the same for it. After a removal, [check the bookmark counter](check-bookmark-counter.md) if you want to confirm that the counter matches.

## What the workspace sees

The removal writes one event to the audit log of that workspace: "Bookmark removed by the instance operator". The owners and admins of the workspace read it. It names the bookmark by its identifier and shows your reason and the database login you used. It does not show the title or the address of the bookmark.

Because the workspace's admins read the reason, do not put personal data in it. Write a reference number, not a name.

## Troubleshooting

**The statement fails with a permission error.** You are connected as the application login, or you did not run `SET LOCAL ROLE slugbase_system;` in the same transaction. Connect with the migration login and run all the lines together.

**The statement fails and names the reason.** The reason is empty, longer than 100 characters, or holds a line break or another control character. Shorten it and remove the control character.

**The statement fails because the record already exists.** You used the identifier from step 3 before. Make a new one and run the statement again.

**The statement answers `f` but the bookmark still exists.** The bookmark belongs to another workspace than the one you named, or its workspace is being deleted. Run step 2 again and copy both identifiers from the same row.

## Related pages

- [Check the bookmark counter](check-bookmark-counter.md)
- [Back up and restore](backup-restore.md)
