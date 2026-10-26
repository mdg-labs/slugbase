import type { FolderRecord } from "./create.ts";

// Filing bookmarks in a folder and taking them out again (doc 02 sections 7.1 and 8.2, doc 04 section 10.7, doc 13 Q22, doc 10 T1 and T2). Only
// the owner of a bookmark files it, and only into a folder the owner owns: the store finds the folder and every bookmark by identifier and
// owner, so another member's folder or bookmark, one of another workspace and one that does not exist are the same `not_found`, and a request
// that names one of them files none of the others. A recipient of a share files nothing, since a share grants read access only (Q22). Filing
// a bookmark that is filed already, and unfiling one that is not, change nothing.

export interface FolderFilingRequest {
  readonly folderId: string;
  /** The member who files; the account of the transaction. */
  readonly ownerId: string;
  /** The bookmarks to file or unfile, without repeats. */
  readonly bookmarkIds: readonly string[];
}

export type FolderFilingResult =
  /** Every bookmark was found and is now filed (or unfiled); `changed` of them were not before. `folder` is the folder after the change, with its count. */
  | { readonly kind: "done"; readonly folder: FolderRecord; readonly changed: number }
  /** The owner has no such folder, or owns no such bookmark among those named; nothing was written. */
  | { readonly kind: "not_found" };

export interface FolderFilingStore {
  /** Files the bookmarks in the folder, all or none. A plan-archived bookmark is not one the product shows, so it is `not_found`. */
  file(request: FolderFilingRequest): Promise<FolderFilingResult>;
  /** Takes the bookmarks out of the folder, all or none. A plan-archived bookmark may be taken out. */
  unfile(request: FolderFilingRequest): Promise<FolderFilingResult>;
}

export interface FolderFilingDependencies {
  readonly store: FolderFilingStore;
}

export interface FolderFilingAsk {
  readonly folderId: string;
  /** The member who files. */
  readonly accountId: string;
  readonly bookmarkIds: readonly string[];
}

function requestOf(ask: FolderFilingAsk): FolderFilingRequest {
  return {
    folderId: ask.folderId.toLowerCase(),
    ownerId: ask.accountId.toLowerCase(),
    bookmarkIds: [...new Set(ask.bookmarkIds.map((id) => id.toLowerCase()))],
  };
}

/** Files the bookmarks in the folder when `ask.accountId` owns the folder and every bookmark. */
export function fileBookmarks({ store }: FolderFilingDependencies, ask: FolderFilingAsk): Promise<FolderFilingResult> {
  return store.file(requestOf(ask));
}

/** Takes the bookmarks out of the folder when `ask.accountId` owns the folder and every bookmark. */
export function unfileBookmarks({ store }: FolderFilingDependencies, ask: FolderFilingAsk): Promise<FolderFilingResult> {
  return store.unfile(requestOf(ask));
}
