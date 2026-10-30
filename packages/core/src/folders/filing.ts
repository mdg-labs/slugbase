import type { FolderRecord } from "./create.ts";

// Filing bookmarks in a folder and taking them out again (doc 02 sections 7.1 and 8.2, doc 04 section 10.7, doc 13 Q22, doc 10 T1 and T2). Only
// the owner of a bookmark files it, and only into a folder the owner owns: the store finds the folder and every bookmark by identifier and
// owner, so another member's folder or bookmark, one of another workspace and one that does not exist are the same `not_found`, and a request
// that names one of them files none of the others. A recipient of a share files nothing, since a share grants read access only (Q22): a request into a
// folder that is shared with the caller, or that names a bookmark shared with the caller, is `forbidden` (doc 04 section 2.4, the caller can see it) and writes nothing. Filing
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
  | { readonly kind: "not_found" }
  /** The folder, or a bookmark named, is shared with the caller, who can read it and may not file into it or file it; nothing was written. */
  | { readonly kind: "forbidden" };

/** What a store answers: it judges ownership only, so a bookmark the caller cannot file is `not_found`, and the caller tells a share from a bookmark it cannot see. */
export type FolderFilingStoreResult = Exclude<FolderFilingResult, { readonly kind: "forbidden" }>;

export interface FolderFilingStore {
  /** Files the bookmarks in the folder, all or none. A plan-archived bookmark is not one the product shows, so it is `not_found`. */
  file(request: FolderFilingRequest): Promise<FolderFilingStoreResult>;
  /** Takes the bookmarks out of the folder, all or none. A plan-archived bookmark may be taken out. */
  unfile(request: FolderFilingRequest): Promise<FolderFilingStoreResult>;
  /** Those of `bookmarkIds` that are shared with `accountId` (the account of the transaction): readable by it through a share, owned by someone else, not plan-archived. */
  sharedAmong(request: { readonly bookmarkIds: readonly string[]; readonly accountId: string }): Promise<readonly string[]>;
  /** Whether the folder `folderId` is another member's and shared with `accountId` (the account of the transaction). */
  sharedWith(request: { readonly folderId: string; readonly accountId: string }): Promise<boolean>;
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

async function judged(store: FolderFilingStore, request: FolderFilingRequest, answer: FolderFilingStoreResult): Promise<FolderFilingResult> {
  if (answer.kind !== "not_found") {
    return answer;
  }
  if (await store.sharedWith({ folderId: request.folderId, accountId: request.ownerId })) {
    return { kind: "forbidden" };
  }
  return (await store.sharedAmong({ bookmarkIds: request.bookmarkIds, accountId: request.ownerId })).length > 0 ? { kind: "forbidden" } : answer;
}

/** Files the bookmarks in the folder when `ask.accountId` owns the folder and every bookmark; `forbidden` when the folder or one of them is shared with it. */
export async function fileBookmarks({ store }: FolderFilingDependencies, ask: FolderFilingAsk): Promise<FolderFilingResult> {
  const request = requestOf(ask);
  return judged(store, request, await store.file(request));
}

/** Takes the bookmarks out of the folder when `ask.accountId` owns the folder and every bookmark; `forbidden` when the folder or one of them is shared with it. */
export async function unfileBookmarks({ store }: FolderFilingDependencies, ask: FolderFilingAsk): Promise<FolderFilingResult> {
  const request = requestOf(ask);
  return judged(store, request, await store.unfile(request));
}
