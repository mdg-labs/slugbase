import type { FolderStore } from "./create.ts";

// Deleting a folder (doc 02 section 7.1, doc 04 sections 2.4 and 10.7). A delete is hard: the folder goes with the associations of its
// bookmarks, which stay. Only the owner deletes a folder, and the store keeps no tombstone, so a delete of a folder that is gone, that
// another member owns or that belongs to another workspace is the same `false`.

export interface FolderDeletionDependencies {
  readonly store: Pick<FolderStore, "remove">;
}

export interface FolderDeletionAsk {
  readonly folderId: string;
  /** The member who deletes the folder. */
  readonly accountId: string;
}

/** True when the folder was deleted; false when the account owns no such folder, which a caller must not tell apart from any other case. */
export function deleteFolder({ store }: FolderDeletionDependencies, ask: FolderDeletionAsk): Promise<boolean> {
  return store.remove({ folderId: ask.folderId, ownerId: ask.accountId.toLowerCase() });
}
