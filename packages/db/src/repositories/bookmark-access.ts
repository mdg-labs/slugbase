import { sql, type SQL } from "drizzle-orm";
import { bookmarks } from "../schema/bookmarks.ts";

// The access predicate of doc 05 section 4: which bookmarks of the workspace an account can read. It is one fragment, written once, so every query that
// asks whether an account can read a bookmark (the candidates of `/go`, and the lists and lookups that sharing adds after them) asks it the same way and a change to the
// rules of reading is made in one place. The fragment is a condition over one row of a bookmark, which a statement names by the columns the rules read (today the owner; sharing adds the identifier). It is always used beside the workspace predicate, which the policy of the table adds as well.
//
// Today a bookmark is readable by its owner. Sharing (doc 02 section 8) extends this function, when it is built, with the shares to the account, to its teams and to the folders it can
// read, and every caller picks that up.

/** The columns of the bookmark row a statement applies the predicate to: those of `bookmarks`, or of a subquery that selects them. */
export interface BookmarkRow {
  readonly ownerId: SQL;
}

/** The rows of `bookmarks` itself, for a statement that selects from the table unaliased. */
export const BOOKMARKS_TABLE: BookmarkRow = { ownerId: sql`${bookmarks.ownerId}` };

/** The condition that `accountId` can read `row`. `accountId` is a UUID, bound as a parameter. */
export function bookmarkReadableBy(accountId: string, row: BookmarkRow = BOOKMARKS_TABLE): SQL {
  return sql`${row.ownerId} = ${accountId}::uuid`;
}
