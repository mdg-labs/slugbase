import type { LargeInstance, LargeWorkspace } from "./large.ts";
import { nullable, text, time } from "./script.ts";

// The SQL that fills a freshly migrated database with the large instance (doc 08 section 5.3), in one transaction as
// `slugbase_system`, the way `seedScript` does for the development instance: the accounts and workspaces through the system
// operations the product uses, then the rows the application role may not write itself (a bookmark's usage, its slug in bulk).

const BATCH = 500;

function batches<T>(items: readonly T[]): T[][] {
  const groups: T[][] = [];
  for (let start = 0; start < items.length; start += BATCH) {
    groups.push(items.slice(start, start + BATCH));
  }
  return groups;
}

function workspaceLines(workspace: LargeWorkspace): string[] {
  const id = text(workspace.id);
  const lines = [
    `DO $seed$ BEGIN IF NOT public.sys_create_workspace(${text(workspace.ownerId)}, ${id}, ${text(workspace.name)}) THEN RAISE EXCEPTION 'the workspace % was not created', ${text(workspace.name)}; END IF; END $seed$;`,
  ];
  for (const member of workspace.members) {
    lines.push(`INSERT INTO public.workspace_members (workspace_id, account_id, role) VALUES (${id}, ${text(member.accountId)}, ${text(member.role)});`);
  }
  for (const group of batches(workspace.bookmarks)) {
    const rows = group.map(
      (bookmark) =>
        `(${[
          text(bookmark.id),
          text(bookmark.ownerId),
          text(bookmark.url),
          text(bookmark.urlCanonical),
          text(bookmark.host),
          text(bookmark.title),
          nullable(bookmark.description),
          nullable(bookmark.slug),
          String(bookmark.forwarding),
          time(bookmark.pinnedAt),
          String(bookmark.openCount),
          time(bookmark.lastOpenedAt),
          time(bookmark.createdAt),
        ].join(", ")})`,
    );
    lines.push(
      `INSERT INTO public.bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, description, slug, forwarding, pinned_at, open_count, last_opened_at, created_at, updated_at) SELECT v.id::uuid, ${id}::uuid, v.owner_id::uuid, v.url, v.url_canonical, v.host, v.title, v.description, v.slug, v.forwarding, v.pinned_at::timestamptz, v.open_count, v.last_opened_at::timestamptz, v.created_at::timestamptz, v.created_at::timestamptz FROM (VALUES ${rows.join(", ")}) AS v(id, owner_id, url, url_canonical, host, title, description, slug, forwarding, pinned_at, open_count, last_opened_at, created_at);`,
    );
  }
  for (const group of batches(workspace.tags)) {
    lines.push(`INSERT INTO public.tags (id, workspace_id, owner_id, name) VALUES ${group.map((tag) => `(${text(tag.id)}, ${id}, ${text(tag.ownerId)}, ${text(tag.name)})`).join(", ")};`);
  }
  for (const group of batches(workspace.folders)) {
    lines.push(`INSERT INTO public.folders (id, workspace_id, owner_id, name) VALUES ${group.map((folder) => `(${text(folder.id)}, ${id}, ${text(folder.ownerId)}, ${text(folder.name)})`).join(", ")};`);
  }
  for (const group of batches(workspace.bookmarkTags)) {
    lines.push(`INSERT INTO public.bookmark_tags (workspace_id, bookmark_id, tag_id) VALUES ${group.map((link) => `(${id}, ${text(link.bookmarkId)}, ${text(link.tagId)})`).join(", ")};`);
  }
  for (const group of batches(workspace.folderBookmarks)) {
    lines.push(`INSERT INTO public.folder_bookmarks (workspace_id, folder_id, bookmark_id) VALUES ${group.map((link) => `(${id}, ${text(link.folderId)}, ${text(link.bookmarkId)})`).join(", ")};`);
  }
  for (const team of workspace.teams) {
    lines.push(`INSERT INTO public.teams (id, workspace_id, name) VALUES (${text(team.id)}, ${id}, ${text(team.name)});`);
    lines.push(`INSERT INTO public.team_members (workspace_id, team_id, account_id) VALUES ${team.memberIds.map((accountId) => `(${id}, ${text(team.id)}, ${text(accountId)})`).join(", ")};`);
  }
  for (const [table, column, shares] of [
    ["bookmark_shares", "bookmark_id", workspace.bookmarkShares],
    ["folder_shares", "folder_id", workspace.folderShares],
  ] as const) {
    for (const group of batches(shares)) {
      lines.push(
        `INSERT INTO public.${table} (id, workspace_id, ${column}, target_account_id, target_team_id, granted_by) VALUES ${group.map((share) => `(${text(share.id)}, ${id}, ${text(share.subjectId)}, ${nullable(share.accountId)}, ${nullable(share.teamId)}, ${text(share.grantedBy)})`).join(", ")};`,
      );
    }
  }
  lines.push(`UPDATE public.workspaces SET bookmark_count = (SELECT count(*) FROM public.bookmarks b WHERE b.workspace_id = ${id} AND b.plan_archived_at IS NULL) WHERE id = ${id};`);
  return lines;
}

/** The script for `instance`; every account has the password whose argon2id PHC string is `passwordHash`. */
export function largeSeedScript(instance: LargeInstance, passwordHash: string): string {
  const lines = ["SET standard_conforming_strings = on;", "BEGIN;", "SET LOCAL ROLE slugbase_system;"];
  for (const account of instance.accounts) {
    lines.push(
      `DO $seed$ BEGIN IF NOT public.sys_create_account(${text(account.id)}, ${text(account.email)}, ${text(account.displayName)}, ${text(passwordHash)}, 'en', true) THEN RAISE EXCEPTION 'the database already has an account with the address %', ${text(account.email)} USING HINT = 'seed an empty database'; END IF; END $seed$;`,
    );
    if (account.isInstanceAdmin) {
      lines.push(`UPDATE public.accounts SET is_instance_admin = true WHERE id = ${text(account.id)};`);
    }
  }
  for (const workspace of instance.workspaces) {
    lines.push(...workspaceLines(workspace));
  }
  lines.push("COMMIT;");
  return `${lines.join("\n")}\n`;
}
