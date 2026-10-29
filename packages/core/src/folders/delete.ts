import type { FolderStore } from "./create.ts";

// Deleting a folder (doc 02 section 7.1, doc 04 sections 2.4 and 10.7). A delete is hard: the folder goes with the associations of its
// bookmarks, which stay. Only the owner deletes a folder, and the store keeps no tombstone, so a delete of a folder that is gone, that
// another member owns without sharing it with the caller or that belongs to another workspace is the same `not_found`. A folder that is
// another member's and shared with the caller, who can read it, is `forbidden`: a share gives read access only (Q22).

export interface FolderDeletionDependencies {
  readonly store: Pick<FolderStore, "remove" | "sharedWith">;
}

export interface FolderDeletionAsk {
  readonly folderId: string;
  /** The member who deletes the folder. */
  readonly accountId: string;
}

export type FolderDeletionResult =
  | { readonly kind: "deleted" }
  /** The account owns no such folder and none is shared with it, which a caller must not tell apart from any other case. */
  | { readonly kind: "not_found" }
  /** The folder is shared with the account, which can read it and may not delete it; nothing was deleted. */
  | { readonly kind: "forbidden" };

export async function deleteFolder({ store }: FolderDeletionDependencies, ask: FolderDeletionAsk): Promise<FolderDeletionResult> {
  const accountId = ask.accountId.toLowerCase();
  if (await store.remove({ folderId: ask.folderId, ownerId: accountId })) {
    return { kind: "deleted" };
  }
  return (await store.sharedWith({ folderId: ask.folderId, accountId })) ? { kind: "forbidden" } : { kind: "not_found" };
}
