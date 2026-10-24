import type { FolderRecord, FolderStore } from "./create.ts";

// Reading one folder (doc 02 section 7.1, doc 04 section 10.7, doc 10 T2). Only the owner reads a folder here: the store names the owner
// in the statement, so another member's folder and one of another workspace are a folder it does not find, which the caller must not
// tell apart from one that does not exist.

export interface FolderReadDependencies {
  readonly store: Pick<FolderStore, "find">;
}

export interface FolderReadAsk {
  readonly folderId: string;
  /** The member who reads the folder. */
  readonly accountId: string;
}

/** The folder, or undefined when the account owns no such folder. */
export function readFolder({ store }: FolderReadDependencies, ask: FolderReadAsk): Promise<FolderRecord | undefined> {
  return store.find({ folderId: ask.folderId, ownerId: ask.accountId.toLowerCase() });
}
