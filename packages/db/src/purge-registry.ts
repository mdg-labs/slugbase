/**
 * The tenant tables the workspace deletion job empties, in the order it empties them (doc 05 section 7.2):
 * a table before the tables its rows depend on, so no batch is refused by a foreign key. Every table with a
 * `workspace_id` column is named here, and `pnpm db:check` fails for one that is not and for an entry that is no
 * such table. The `workspaces` row is not an entry: it goes last, in its own step, and cascades whatever rows
 * are left. A table added here also needs its statement in `sys_workspace_purge_batch`
 * (src/sql/280-workspace-deletion.sql), which the same check holds to this list.
 */
export const workspacePurgeOrder: readonly string[] = [
  // api_tokens references the membership of its account, so the tokens go before the members.
  "api_tokens",
  "audit_events",
  // The links of bookmarks and tags reference both, so they go first.
  "bookmark_tags",
  // bookmarks reference the membership of their owner, so they go before the members.
  "bookmarks",
  // tags reference the membership of their owner, so they go before the members.
  "tags",
  "workspace_invitations",
  "workspace_settings",
  "workspace_members",
];

/** How many rows of one table a batch of the deletion job deletes at most. */
export const WORKSPACE_PURGE_BATCH_SIZE = 1000;
