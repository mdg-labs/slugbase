import { assertFolderStyle, normalizeFolderName, type FolderNameRefusal, type FolderRecord, type FolderStore } from "./create.ts";

// Changing a folder (doc 02 section 7.1, doc 04 sections 2.4 and 10.7, doc 10 T2). The service validates everything the caller sent
// before anything is written, then asks the store to apply it to the caller's own folder: the store finds the folder by identifier and
// owner, locks it, compares its version with the `If-Match` the caller sent and writes what differs. Only the owner changes a folder, so
// another member's folder of the workspace and another workspace's are the same `not_found`.

/** The fields of a JSON Merge Patch of a folder (doc 04 section 2.4): a field left out is left as it is. */
export interface FolderPatch {
  readonly name?: string;
  readonly icon?: string;
  readonly color?: number;
}

/** What the store writes: the values that are to change. */
export interface FolderChanges {
  readonly name?: string;
  readonly icon?: string;
  readonly color?: number;
}

export interface FolderUpdateRequest {
  readonly folderId: string;
  /** The member who changes the folder; the store finds only a folder that member owns. */
  readonly ownerId: string;
  readonly changes: FolderChanges;
  /** The versions the caller accepts (its `If-Match`); undefined when it makes no precondition. An empty list matches none. */
  readonly expectedVersions: readonly number[] | undefined;
}

export type FolderUpdateResult =
  /** The folder was changed; `folder` is the row after the change, its version moved by one. */
  | { readonly kind: "updated"; readonly folder: FolderRecord }
  /** The patch names the values the folder already has; nothing was written and the version stays. */
  | { readonly kind: "unchanged"; readonly folder: FolderRecord }
  /** The version of the folder, read under its lock, is none of the accepted ones; nothing was written. */
  | { readonly kind: "stale" }
  /** The owner has another folder of that name; nothing was written. */
  | { readonly kind: "name_taken" }
  /** The caller owns no such folder; nothing was written. */
  | { readonly kind: "not_found" };

export interface FolderUpdateDependencies {
  readonly store: Pick<FolderStore, "update">;
}

export interface FolderUpdateAsk {
  readonly folderId: string;
  /** The member who changes the folder. */
  readonly accountId: string;
  readonly patch: FolderPatch;
  readonly expectedVersions: readonly number[] | undefined;
}

export type FolderUpdateOutcome = FolderUpdateResult | { readonly kind: "invalid_name"; readonly reason: FolderNameRefusal };

export async function updateFolder({ store }: FolderUpdateDependencies, ask: FolderUpdateAsk): Promise<FolderUpdateOutcome> {
  const { patch } = ask;
  let name: string | undefined;
  if (patch.name !== undefined) {
    const normalized = normalizeFolderName(patch.name);
    if ("refusal" in normalized) {
      return { kind: "invalid_name", reason: normalized.refusal };
    }
    name = normalized.name;
  }
  assertFolderStyle(patch);
  return store.update({
    folderId: ask.folderId,
    ownerId: ask.accountId.toLowerCase(),
    changes: {
      ...(name === undefined ? {} : { name }),
      ...(patch.icon === undefined ? {} : { icon: patch.icon }),
      ...(patch.color === undefined ? {} : { color: patch.color }),
    },
    expectedVersions: ask.expectedVersions,
  });
}
