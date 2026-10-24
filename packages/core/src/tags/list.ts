import type { TagPosition, TagRecord, TagSort, TagStore } from "./create.ts";

// Listing a member's tags (doc 02 section 7.2, doc 04 sections 6.1 and 10.7, Q42): the tags the account owns in the workspace, each with
// the number of its bookmarks, by name or by that number. Another member's tags are not in the answer, whatever the store is asked for.
// A page is a slice of one ordering, resumed by an opaque cursor that carries the last tag's sort key and identifier (a keyset, never an
// offset). The cursor is signed for the account, the workspace and the sort it was issued for, so it opens nothing else. The total is
// the number of the member's tags, exact up to `TAG_LIST_TOTAL_CAP` and not counted beyond it.

/** Where `GET /tags` stops counting (Q42): above it the total is not given, only that it is at least this many. */
export const TAG_LIST_TOTAL_CAP = 10_000;

/** Signs and opens cursors; a cursor opens only for the `scope` it was sealed with. */
export interface TagCursors {
  seal(position: TagPosition, scope: string): string;
  /** Undefined when the cursor was not sealed by this server for this scope. */
  open(cursor: string, scope: string): TagPosition | undefined;
}

export interface TagListDependencies {
  readonly store: Pick<TagStore, "list" | "count">;
  readonly cursors: TagCursors;
}

export interface TagListAsk {
  readonly workspaceId: string;
  /** The member whose tags are listed. */
  readonly accountId: string;
  readonly sort: TagSort;
  /** 1 to 100. */
  readonly limit: number;
  readonly cursor: string | undefined;
}

export type TagListOutcome =
  | {
      readonly kind: "listed";
      readonly items: readonly TagRecord[];
      readonly nextCursor: string | null;
      /** The number of the member's tags; null when there are more than `TAG_LIST_TOTAL_CAP`. */
      readonly total: number | null;
    }
  /** The cursor was not issued by this server for this account, workspace and sort; nothing was read. */
  | { readonly kind: "bad_cursor" };

/** What a cursor is bound to: the list it was issued for, written so that no two different lists share a scope. */
function cursorScope(ask: TagListAsk): string {
  return JSON.stringify([ask.workspaceId.toLowerCase(), ask.accountId.toLowerCase(), ask.sort]);
}

/** One page of `ask.accountId`'s tags in the workspace of the transaction, with the cursor of the next and the capped total. */
export async function listTags({ store, cursors }: TagListDependencies, ask: TagListAsk): Promise<TagListOutcome> {
  const scope = cursorScope(ask);
  let after: TagPosition | undefined;
  if (ask.cursor !== undefined) {
    after = cursors.open(ask.cursor, scope);
    // The sort by count resumes from the count of the last tag, so a position without one cannot be followed.
    if (after === undefined || (ask.sort === "count") !== (after.count !== undefined)) {
      return { kind: "bad_cursor" };
    }
  }
  const ownerId = ask.accountId.toLowerCase();
  // One more than the page, to know whether another page follows.
  const fetched = await store.list({ ownerId, sort: ask.sort, after, limit: ask.limit + 1 });
  const items = fetched.slice(0, ask.limit);
  const last = items.at(-1);
  const counted = await store.count(ownerId, TAG_LIST_TOTAL_CAP + 1);
  return {
    kind: "listed",
    items,
    nextCursor:
      fetched.length > ask.limit && last !== undefined
        ? cursors.seal({ count: ask.sort === "count" ? last.bookmarkCount : undefined, name: last.name, id: last.id }, scope)
        : null,
    total: counted > TAG_LIST_TOTAL_CAP ? null : counted,
  };
}
