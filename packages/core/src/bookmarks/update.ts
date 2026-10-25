import type { BookmarkRecord, BookmarkStore } from "./create.ts";
import { BOOKMARK_DESCRIPTION_MAX_LENGTH, BOOKMARK_TITLE_MAX_LENGTH } from "./create.ts";
import { normalizeBookmarkUrl, type BookmarkUrl, type BookmarkUrlRefusal } from "./url.ts";

// Changing a bookmark (doc 02 section 5.2, doc 04 section 2.4, doc 10 T1 and T2). The service validates and normalises
// everything the caller sent before anything is written, then asks the store to apply it to the caller's own bookmark: the
// store finds the bookmark by identifier and owner, locks it, compares its version with the `If-Match` the caller sent and
// writes what differs. Filing moves no version: the folders of a bookmark are rows of their own, so a patch that changes only `folderIds` keeps
// the `ETag`. Only the owner changes a bookmark, so another member's bookmark of the workspace, another workspace's
// and a plan-archived one (which nobody edits, doc 02 section 5.6) are the same `not_found`.

/** The fields of a JSON Merge Patch of a bookmark (doc 04 section 2.4): a field left out is left as it is, and a description of `null` clears it. */
export interface BookmarkPatch {
  readonly url?: string;
  readonly title?: string;
  readonly description?: string | null;
  readonly pinned?: boolean;
  /** The folders the bookmark is filed in afterwards: they replace the ones it is in, and an empty list takes it out of all of them. */
  readonly folderIds?: readonly string[];
}

/** What the store writes: the normalised destination with the columns derived from it, and the values that are to change. */
export interface BookmarkChanges {
  readonly url?: BookmarkUrl;
  readonly title?: string;
  readonly description?: string | null;
  readonly pinned?: boolean;
  /** The owner's folders the bookmark is filed in afterwards, without repeats. */
  readonly folderIds?: readonly string[];
}

export interface BookmarkUpdateRequest {
  readonly bookmarkId: string;
  /** The member who changes the bookmark; the store finds only a bookmark that member owns. */
  readonly ownerId: string;
  readonly changes: BookmarkChanges;
  /** The versions the caller accepts (its `If-Match`); undefined when it makes no precondition. An empty list matches none. */
  readonly expectedVersions: readonly number[] | undefined;
}

export type BookmarkUpdateResult =
  /** The bookmark was changed; `bookmark` is the row after the change, its version moved by one unless only its folders changed. */
  | { readonly kind: "updated"; readonly bookmark: BookmarkRecord }
  /** The patch names the values the bookmark already has, in the folders it is already in; nothing was written and the version stays. */
  | { readonly kind: "unchanged"; readonly bookmark: BookmarkRecord }
  /** A folder of `folderIds` is not one the owner has in this workspace; nothing was written. */
  | { readonly kind: "folder_not_found" }
  /** The version of the bookmark, read under its lock, is none of the accepted ones; nothing was written. */
  | { readonly kind: "stale" }
  /** The caller owns no such bookmark; nothing was written. */
  | { readonly kind: "not_found" };

export interface BookmarkUpdateDependencies {
  readonly store: Pick<BookmarkStore, "update">;
}

export interface BookmarkUpdateAsk {
  readonly bookmarkId: string;
  /** The member who changes the bookmark. */
  readonly accountId: string;
  readonly patch: BookmarkPatch;
  readonly expectedVersions: readonly number[] | undefined;
}

export type BookmarkUpdateOutcome =
  | BookmarkUpdateResult
  /** The new URL is refused; nothing was written. */
  | { readonly kind: "url_refused"; readonly reason: BookmarkUrlRefusal };

function checkLength(field: string, value: string, min: number, max: number): void {
  const length = Array.from(value).length;
  if (length < min || length > max) {
    throw new RangeError(`a bookmark ${field} has ${String(min)} to ${String(max)} characters`);
  }
}

/**
 * Applies the patch to the bookmark `ask.bookmarkId` when `ask.accountId` owns it. The URL is normalised as a creation does and
 * its canonical form and host are derived again; the title and the description are the trimmed values the contract passes on, and
 * an empty description is stored as none.
 */
export async function updateBookmark({ store }: BookmarkUpdateDependencies, ask: BookmarkUpdateAsk): Promise<BookmarkUpdateOutcome> {
  const { patch } = ask;
  let url: BookmarkUrl | undefined;
  if (patch.url !== undefined) {
    const normalized = normalizeBookmarkUrl(patch.url);
    if (!normalized.ok) {
      return { kind: "url_refused", reason: normalized.reason };
    }
    url = normalized.value;
  }
  if (patch.title !== undefined) {
    checkLength("title", patch.title, 1, BOOKMARK_TITLE_MAX_LENGTH);
  }
  let description: string | null | undefined;
  if (patch.description !== undefined) {
    description = patch.description === null || patch.description === "" ? null : patch.description;
    if (description !== null) {
      checkLength("description", description, 1, BOOKMARK_DESCRIPTION_MAX_LENGTH);
    }
  }
  return store.update({
    bookmarkId: ask.bookmarkId,
    ownerId: ask.accountId.toLowerCase(),
    changes: {
      ...(url === undefined ? {} : { url }),
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(description === undefined ? {} : { description }),
      ...(patch.pinned === undefined ? {} : { pinned: patch.pinned }),
      ...(patch.folderIds === undefined ? {} : { folderIds: [...new Set(patch.folderIds.map((id) => id.toLowerCase()))] }),
    },
    expectedVersions: ask.expectedVersions,
  });
}
