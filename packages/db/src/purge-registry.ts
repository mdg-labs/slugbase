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
  // The shares of bookmarks reference the bookmark and the membership or the team they name, so they go first.
  "bookmark_shares",
  // The shares of folders reference the folder and the membership or the team they name, so they go first.
  "folder_shares",
  // The links of bookmarks and tags reference both, so they go first.
  "bookmark_tags",
  // The links of bookmarks and folders reference both, so they go first.
  "folder_bookmarks",
  // The preferences of members reference both the bookmark and the membership, so they go first.
  "slug_preferences",
  // bookmarks reference the membership of their owner, so they go before the members.
  "bookmarks",
  // folders reference the membership of their owner, so they go before the members.
  "folders",
  // The memberships of teams reference both the team and the membership of the member, so they go first.
  "team_members",
  // tags reference the membership of their owner, so they go before the members.
  "tags",
  "teams",
  "url_metadata",
  "workspace_invitations",
  "workspace_settings",
  "workspace_members",
];

/** How many rows of one table a batch of the deletion job deletes at most. */
export const WORKSPACE_PURGE_BATCH_SIZE = 1000;
