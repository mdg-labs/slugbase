import type { FolderRecord, FolderStore } from "./create.ts";

// Reading one folder (doc 02 sections 7.1 and 8.2, doc 04 section 10.7, doc 10 T2). The owner reads a folder, and so does a member it is shared with
// (directly or through a team): the store names the viewer in the statement, so another member's folder that is not shared with the viewer and one of
// another workspace are a folder it does not find, which the caller must not tell apart from one that does not exist.

export interface FolderReadDependencies {
  readonly store: Pick<FolderStore, "find">;
}

export interface FolderReadAsk {
  readonly folderId: string;
  /** The member who reads the folder. */
  readonly accountId: string;
}

/** The folder, or undefined when the account neither owns it nor has it shared with it. */
export function readFolder({ store }: FolderReadDependencies, ask: FolderReadAsk): Promise<FolderRecord | undefined> {
  return store.find({ folderId: ask.folderId, viewerId: ask.accountId.toLowerCase() });
}
