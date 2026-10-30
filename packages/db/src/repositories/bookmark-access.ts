import { sql, type SQL } from "drizzle-orm";
import { bookmarks } from "../schema/bookmarks.ts";
import { folderBookmarks } from "../schema/folders.ts";
import { bookmarkShares, folderShares } from "../schema/shares.ts";
import { teamMembers } from "../schema/teams.ts";
import { uuidArray } from "./folder-links.ts";

// The access predicate of doc 05 section 4: which bookmarks of the workspace an account can read. It is written once, here, so every query that asks whether an account
// can read a bookmark (the lookup, the open and the lists of `bookmarks.ts`, the favicon host check, and the candidates of `/go`) asks it the
// same way and a change to the rules of reading is made in one place. A bookmark is readable by its owner, and by an account it is shared with: directly, through a
// team the account is in, or through a folder it is filed in that is shared with the account or with such a team (doc 02 section 8.2). A grant is read in every case
// from the same four statements (`grantsTo`), whether a statement asks about one bookmark (`bookmarkReadableBy`, a correlated `EXISTS`) or lists everything an account
// is granted (`sharedBookmarks`, the set a list is driven from), so a row is readable through a route exactly when the list shows it. A route that two grants give counts
// once. The fragment never reads a plan-archived bookmark out: that is the statement's own condition, as it is for the owner's bookmarks. The system operations
// `sys_search`, `sys_go_suggest` and `sys_go_other_workspaces` run as `slugbase_system` and state the same rule in SQL (src/sql/580, 590 and 600), and so does
// `slug_preference_bookmark_readable` (src/sql/670), which the triggers that forget the remembered choices of a member who lost access judge by; a change to the rules
// of reading is made there too.
//
// A row is named by the columns the rules read: its owner, its identifier and its workspace.

/** The columns of the bookmark row a statement applies the predicate to: those of `bookmarks`, or of a subquery that selects them. */
export interface SharableBookmarkRow {
  readonly ownerId: SQL;
  readonly id: SQL;
  readonly workspaceId: SQL;
}

/** The rows of `bookmarks` itself, for a statement that selects from the table unaliased. */
export const BOOKMARKS_TABLE: SharableBookmarkRow = { ownerId: sql`${bookmarks.ownerId}`, id: sql`${bookmarks.id}`, workspaceId: sql`${bookmarks.workspaceId}` };

/** How a bookmark is shared with an account: with it, with a team it is in, or through a shared folder the bookmark is filed in. */
export type SharedVia = "direct" | "team" | "folder";

/**
 * Every grant of read access to `accountId` in the workspace `workspaceId` (an expression: a bound parameter, or a column of the outer row), as rows of
 * `(bookmark_id, via)`. A bookmark appears once for each route that gives it.
 */
function grantsTo(accountId: string, workspaceId: SQL): SQL {
  const account = sql`${accountId}::uuid`;
  const teamsOfAccount = sql`SELECT m.team_id FROM ${teamMembers} m WHERE m.workspace_id = ${workspaceId} AND m.account_id = ${account}`;
  return sql`
    SELECT s.bookmark_id, 'direct'::text AS via FROM ${bookmarkShares} s
    WHERE s.workspace_id = ${workspaceId} AND s.target_account_id = ${account}
    UNION ALL
    SELECT s.bookmark_id, 'team'::text AS via FROM ${bookmarkShares} s
    WHERE s.workspace_id = ${workspaceId} AND s.target_team_id IN (${teamsOfAccount})
    UNION ALL
    SELECT fb.bookmark_id, 'folder'::text AS via FROM ${folderShares} fs
    JOIN ${folderBookmarks} fb ON fb.workspace_id = fs.workspace_id AND fb.folder_id = fs.folder_id
    WHERE fs.workspace_id = ${workspaceId} AND fs.target_account_id = ${account}
    UNION ALL
    SELECT fb.bookmark_id, 'folder'::text AS via FROM ${folderShares} fs
    JOIN ${folderBookmarks} fb ON fb.workspace_id = fs.workspace_id AND fb.folder_id = fs.folder_id
    WHERE fs.workspace_id = ${workspaceId} AND fs.target_team_id IN (${teamsOfAccount})`;
}

/** The condition that `accountId` can read `row`: it owns it, or it is shared with the account. `accountId` is a UUID, bound as a parameter. */
export function bookmarkReadableBy(accountId: string, row: SharableBookmarkRow = BOOKMARKS_TABLE): SQL {
  return sql`(${row.ownerId} = ${accountId}::uuid OR EXISTS (SELECT 1 FROM (${grantsTo(accountId, row.workspaceId)}) g WHERE g.bookmark_id = ${row.id}))`;
}

/**
 * How `accountId` reads `row`, as a scalar: `owner` for its own bookmark, otherwise the route of a share that gives it, the direct share before the team's before the folder's
 * (the order of `sharedViaOf`); NULL when no route does. For the few rows a statement has already narrowed to (the candidates of a slug), not for a list.
 */
export function bookmarkAccessOf(accountId: string, row: SharableBookmarkRow): SQL {
  return sql`(CASE WHEN ${row.ownerId} = ${accountId}::uuid THEN 'owner'
    ELSE (SELECT g.via FROM (${grantsTo(accountId, row.workspaceId)}) g WHERE g.bookmark_id = ${row.id}
          ORDER BY CASE g.via WHEN 'direct' THEN 0 WHEN 'team' THEN 1 ELSE 2 END LIMIT 1) END)`;
}

/**
 * A set of identifiers, as `SELECT bookmark_id`: the bookmarks of the workspace `workspaceId` that are shared with `accountId`, each once, whoever owns them. A list is driven from
 * this set (probing `bookmarks` by primary key for each member of it) and not from a scan of the bookmarks, which is what keeps the shared lists off a sequential scan.
 */
export function sharedBookmarks(accountId: string, workspaceId: string): SQL {
  return sql`SELECT DISTINCT g.bookmark_id FROM (${grantsTo(accountId, sql`${workspaceId}::uuid`)}) g`;
}

/** For each of `bookmarkIds` that is shared with `accountId` in `workspaceId`, one row `(bookmark_id, via)`: the direct share before the team's before the folder's. */
export function sharedViaOf(accountId: string, workspaceId: string, bookmarkIds: readonly string[]): SQL {
  return sql`
    SELECT DISTINCT ON (g.bookmark_id) g.bookmark_id, g.via
    FROM (${grantsTo(accountId, sql`${workspaceId}::uuid`)}) g
    WHERE g.bookmark_id = ANY (${uuidArray(bookmarkIds)}::uuid[])
    ORDER BY g.bookmark_id, CASE g.via WHEN 'direct' THEN 0 WHEN 'team' THEN 1 ELSE 2 END`;
}

/** The columns of the folder row a statement applies `folderSharedWith` to: its workspace and its identifier, as column references or bound parameters. */
export interface SharableFolderRow {
  readonly workspaceId: SQL;
  readonly id: SQL;
}

/**
 * The condition that the folder `folder` is shared with `accountId`: with the account directly, or with a team it is in. It says nothing of who owns the folder, so a statement that wants
 * the folders of other members adds that itself. The grants of a folder are the two folder legs of `grantsTo`, asked about one folder; the bookmarks they reach are read through that.
 */
export function folderSharedWith(accountId: string, folder: SharableFolderRow): SQL {
  const account = sql`${accountId}::uuid`;
  return sql`EXISTS (
    SELECT 1 FROM ${folderShares} fs
    WHERE fs.workspace_id = ${folder.workspaceId} AND fs.folder_id = ${folder.id}
      AND (fs.target_account_id = ${account}
           OR fs.target_team_id IN (SELECT m.team_id FROM ${teamMembers} m WHERE m.workspace_id = ${folder.workspaceId} AND m.account_id = ${account})))`;
}

/** The condition that `row`, a bookmark of the account that asks, is shared with someone: directly, or through a folder it is filed in. */
export function bookmarkSharedByOwner(row: SharableBookmarkRow = BOOKMARKS_TABLE): SQL {
  return sql`(EXISTS (SELECT 1 FROM ${bookmarkShares} s WHERE s.workspace_id = ${row.workspaceId} AND s.bookmark_id = ${row.id})
    OR EXISTS (SELECT 1 FROM ${folderBookmarks} fb JOIN ${folderShares} fs ON fs.workspace_id = fb.workspace_id AND fs.folder_id = fb.folder_id
               WHERE fb.workspace_id = ${row.workspaceId} AND fb.bookmark_id = ${row.id}))`;
}
