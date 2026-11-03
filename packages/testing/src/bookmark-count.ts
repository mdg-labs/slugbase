import type { TestDatabase } from "@slugbase/db/testing";

// The proof that `workspaces.bookmark_count` is the number of the workspace's bookmarks that are not plan-archived (doc 05 section
// 2.2, doc 02 section 5, doc 10 T11). The counter is what the limit check reads, never a count of rows (doc 01 section 7.5), so a path
// that creates, deletes, imports, archives or restores a bookmark without moving it in the same transaction shows up as a limit that
// is refused or granted wrongly, and nowhere else. A test that has changed bookmarks ends with `assertBookmarkCountMatches`, which turns
// that silent error into a failure naming the workspace.

/** A workspace whose counter differs from the number of its bookmarks that are not plan-archived. */
export interface BookmarkCountDrift {
  /** The workspace. */
  readonly workspaceId: string;
  /** `workspaces.bookmark_count`. */
  readonly counter: number;
  /** `count(*)` of the workspace's bookmarks whose `plan_archived_at` is NULL. */
  readonly rows: number;
}

/**
 * Every workspace of the database whose counter differs from its rows, oldest identifier first. The read is as `slugbase_system`, the
 * one role that sees every workspace, in a read-only transaction: the owner does not bypass row-level security (doc 05 section 3.1).
 */
export async function bookmarkCountDrift(database: Pick<TestDatabase, "owner">): Promise<BookmarkCountDrift[]> {
  const rows = await database.owner.begin("read only", async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ workspace_id: string; counter: number; rows: number }[]>`
      SELECT w.id AS workspace_id, w.bookmark_count AS counter,
        (SELECT count(*) FROM bookmarks b WHERE b.workspace_id = w.id AND b.plan_archived_at IS NULL)::int AS rows
      FROM workspaces w
      WHERE w.bookmark_count <> (SELECT count(*) FROM bookmarks b WHERE b.workspace_id = w.id AND b.plan_archived_at IS NULL)
      ORDER BY w.id`;
  });
  return rows.map((row) => ({ workspaceId: row.workspace_id, counter: row.counter, rows: row.rows }));
}

/** Fails, naming each workspace, when the counter of any workspace differs from the number of its bookmarks that are not plan-archived. */
export async function assertBookmarkCountMatches(database: Pick<TestDatabase, "owner">): Promise<void> {
  const drifted = await bookmarkCountDrift(database);
  if (drifted.length > 0) {
    const lines = drifted.map((item) => `workspace ${item.workspaceId}: bookmark_count is ${String(item.counter)}, the bookmarks that are not plan-archived number ${String(item.rows)}`);
    throw new Error(`workspaces.bookmark_count has parted from the bookmark rows:\n${lines.join("\n")}`);
  }
}
