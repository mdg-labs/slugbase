import type { DemoInstance, SeedAccountKey } from "./instance.ts";
import type { SeedBookmark } from "./bookmarks.ts";

// The SQL of `pnpm db:seed`: one transaction that creates the accounts and workspaces through the system operations the
// product uses (`sys_create_account`, `sys_create_workspace`), adds the members and the bookmarks as `slugbase_system`,
// and sets each workspace's `bookmark_count` to the number of its rows (doc 05 section 2.2). A bookmark's usage can be
// written only by that role, which is why the seed does not go through the application role. Any failure, such as an
// email that is taken, rolls the whole script back.

const BATCH = 500;

export function text(value: string): string {
  if (value.includes("\0")) {
    throw new Error("a seeded value contains a NUL character");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

export function nullable(value: string | null): string {
  return value === null ? "NULL" : text(value);
}

export function time(value: Date | null): string {
  return value === null ? "NULL" : text(value.toISOString());
}

function row(workspaceId: string, bookmark: SeedBookmark): string {
  return `(${[
    text(bookmark.id),
    text(workspaceId),
    text(bookmark.ownerId),
    text(bookmark.url),
    text(bookmark.urlCanonical),
    text(bookmark.host),
    text(bookmark.title),
    nullable(bookmark.description),
    nullable(bookmark.slug ?? null),
    String(bookmark.forwarding ?? false),
    time(bookmark.pinnedAt),
    String(bookmark.openCount),
    time(bookmark.lastOpenedAt),
    time(bookmark.createdAt),
  ].join(", ")})`;
}

/** The script for `instance`; `passwordHashes` holds the argon2id PHC string of each account. */
export function seedScript(instance: DemoInstance, passwordHashes: Readonly<Record<SeedAccountKey, string>>): string {
  const accountId = (key: SeedAccountKey): string => {
    const account = instance.accounts.find((candidate) => candidate.key === key);
    if (account === undefined) {
      throw new Error(`the instance has no ${key} account`);
    }
    return account.id;
  };
  const lines: string[] = [
    "SET standard_conforming_strings = on;",
    "BEGIN;",
    "SET LOCAL ROLE slugbase_system;",
  ];
  for (const account of instance.accounts) {
    lines.push(
      `DO $seed$ BEGIN IF NOT public.sys_create_account(${text(account.id)}, ${text(account.email)}, ${text(account.displayName)}, ${text(passwordHashes[account.key])}, 'en', true) THEN RAISE EXCEPTION 'the database already has an account with the address %', ${text(account.email)} USING HINT = 'seed an empty development database'; END IF; END $seed$;`,
    );
    if (account.isInstanceAdmin) {
      lines.push(`UPDATE public.accounts SET is_instance_admin = true WHERE id = ${text(account.id)};`);
    }
  }
  for (const workspace of instance.workspaces) {
    lines.push(
      `DO $seed$ BEGIN IF NOT public.sys_create_workspace(${text(accountId(workspace.owner))}, ${text(workspace.id)}, ${text(workspace.name)}) THEN RAISE EXCEPTION 'the workspace % was not created', ${text(workspace.name)}; END IF; END $seed$;`,
    );
    for (const member of workspace.members) {
      lines.push(
        `INSERT INTO public.workspace_members (workspace_id, account_id, role) VALUES (${text(workspace.id)}, ${text(accountId(member.account))}, ${text(member.role)});`,
      );
    }
    for (let start = 0; start < workspace.bookmarks.length; start += BATCH) {
      const rows = workspace.bookmarks.slice(start, start + BATCH).map((bookmark) => row(workspace.id, bookmark));
      lines.push(
        `INSERT INTO public.bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, description, slug, forwarding, pinned_at, open_count, last_opened_at, created_at, updated_at) SELECT v.id::uuid, v.workspace_id::uuid, v.owner_id::uuid, v.url, v.url_canonical, v.host, v.title, v.description, v.slug, v.forwarding::boolean, v.pinned_at::timestamptz, v.open_count, v.last_opened_at::timestamptz, v.created_at::timestamptz, v.created_at::timestamptz FROM (VALUES ${rows.join(", ")}) AS v(id, workspace_id, owner_id, url, url_canonical, host, title, description, slug, forwarding, pinned_at, open_count, last_opened_at, created_at);`,
      );
    }
    for (const folder of workspace.folders) {
      lines.push(`INSERT INTO public.folders (id, workspace_id, owner_id, name) VALUES (${text(folder.id)}, ${text(workspace.id)}, ${text(accountId(folder.owner))}, ${text(folder.name)});`);
      for (const bookmarkId of folder.bookmarkIds) {
        lines.push(`INSERT INTO public.folder_bookmarks (workspace_id, folder_id, bookmark_id) VALUES (${text(workspace.id)}, ${text(folder.id)}, ${text(bookmarkId)});`);
      }
      for (const share of folder.shares) {
        lines.push(
          `INSERT INTO public.folder_shares (id, workspace_id, folder_id, target_account_id, granted_by) VALUES (${text(share.id)}, ${text(workspace.id)}, ${text(folder.id)}, ${text(accountId(share.target))}, ${text(accountId(folder.owner))});`,
        );
      }
    }
    for (const share of workspace.bookmarkShares) {
      lines.push(
        `INSERT INTO public.bookmark_shares (id, workspace_id, bookmark_id, target_account_id, granted_by) VALUES (${text(share.id)}, ${text(workspace.id)}, ${text(share.bookmarkId)}, ${text(accountId(share.target))}, ${text(accountId(share.granted))});`,
      );
    }
    lines.push(
      `UPDATE public.workspaces SET bookmark_count = (SELECT count(*) FROM public.bookmarks b WHERE b.workspace_id = ${text(workspace.id)} AND b.plan_archived_at IS NULL) WHERE id = ${text(workspace.id)};`,
    );
  }
  lines.push("COMMIT;");
  return `${lines.join("\n")}\n`;
}
