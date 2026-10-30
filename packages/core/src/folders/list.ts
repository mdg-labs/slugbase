import type { FolderListRow, FolderPosition, FolderScope, FolderSort, FolderStore } from "./create.ts";

// Listing a member's folders (doc 02 section 7.1, doc 04 sections 6.1 and 10.7, Q42): the folders the account owns in the workspace (`mine`),
// those of other members that are shared with it (`shared`) or both (`all`), each with the number of its bookmarks, by name, by that number or by
// the time they last changed, optionally only those whose name contains a text. A folder of another member that is not shared with the account is
// not in the answer, whatever the store is asked for. A page is a slice of one ordering, resumed by an
// opaque cursor that carries the last folder's sort key and identifier (a keyset, never an offset). The cursor is signed for the account,
// the workspace, the scope, the search and the sort it was issued for, so it opens nothing else. The total is the number of matching
// folders, exact up to `FOLDER_LIST_TOTAL_CAP` and not counted beyond it.

/** Where `GET /folders` stops counting (Q42): above it the total is not given, only that it is at least this many. */
export const FOLDER_LIST_TOTAL_CAP = 10_000;

/** Signs and opens cursors; a cursor opens only for the `scope` it was sealed with. */
export interface FolderCursors {
  seal(position: FolderPosition, scope: string): string;
  /** Undefined when the cursor was not sealed by this server for this scope. */
  open(cursor: string, scope: string): FolderPosition | undefined;
}

export interface FolderListDependencies {
  readonly store: Pick<FolderStore, "list" | "count">;
  readonly cursors: FolderCursors;
}

export interface FolderListAsk {
  readonly workspaceId: string;
  /** The member whose folders are listed. */
  readonly accountId: string;
  /** Whose folders: the account's own, those shared with it, or both. */
  readonly scope: FolderScope;
  readonly search: string | undefined;
  readonly sort: FolderSort;
  /** 1 to 100. */
  readonly limit: number;
  readonly cursor: string | undefined;
}

export type FolderListOutcome =
  | {
      readonly kind: "listed";
      readonly items: readonly FolderListRow[];
      readonly nextCursor: string | null;
      /** The number of matching folders; null when there are more than `FOLDER_LIST_TOTAL_CAP`. */
      readonly total: number | null;
    }
  /** The cursor was not issued by this server for this account, workspace, scope, search and sort; nothing was read. */
  | { readonly kind: "bad_cursor" };

/** What a cursor is bound to: the list it was issued for, written so that no two different lists share a scope. */
function cursorScope(ask: FolderListAsk): string {
  return JSON.stringify([ask.workspaceId.toLowerCase(), ask.accountId.toLowerCase(), ask.scope, ask.search ?? null, ask.sort]);
}

/** Whether the position carries the key the sort resumes from, and no other. */
function fitsSort(position: FolderPosition, sort: FolderSort): boolean {
  return (sort === "count") === (position.count !== undefined) && (sort === "updated") === (position.updated !== undefined);
}

/** One page of the folders of `ask.scope` for `ask.accountId` in the workspace of the transaction, with the cursor of the next and the capped total. */
export async function listFolders({ store, cursors }: FolderListDependencies, ask: FolderListAsk): Promise<FolderListOutcome> {
  const scope = cursorScope(ask);
  let after: FolderPosition | undefined;
  if (ask.cursor !== undefined) {
    after = cursors.open(ask.cursor, scope);
    if (after === undefined || !fitsSort(after, ask.sort)) {
      return { kind: "bad_cursor" };
    }
  }
  const viewerId = ask.accountId.toLowerCase();
  // One more than the page, to know whether another page follows.
  const fetched = await store.list({ viewerId, scope: ask.scope, search: ask.search, sort: ask.sort, after, limit: ask.limit + 1 });
  const items = fetched.slice(0, ask.limit);
  const last = items.at(-1);
  const counted = await store.count({ viewerId, scope: ask.scope, search: ask.search, limit: FOLDER_LIST_TOTAL_CAP + 1 });
  return {
    kind: "listed",
    items,
    nextCursor:
      fetched.length > ask.limit && last !== undefined
        ? cursors.seal(
            {
              count: ask.sort === "count" ? last.bookmarkCount : undefined,
              updated: ask.sort === "updated" ? last.updatedKey : undefined,
              name: last.name,
              id: last.id,
            },
            scope,
          )
        : null,
    total: counted > FOLDER_LIST_TOTAL_CAP ? null : counted,
  };
}
