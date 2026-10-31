import type { AuditActor, AuditWriter } from "../audit/index.ts";
import type { FolderStore } from "../folders/create.ts";
import type { FolderShareList, FolderShareRecord, FolderShareStore, ShareTarget } from "./store.ts";

// The shares of a folder (doc 02 section 8, doc 04 section 10.7, doc 10 T2 and T11). A share of a folder grants read access to every bookmark filed in it,
// now and later. Only the owner of a folder lists, grants or revokes its shares. A folder that is shared with the caller is one they can read and may not
// share further or see the shares of (doc 02 section 8.2), which is `forbidden`, as for a bookmark; a folder that is another member's and not shared with them,
// another workspace's, gone or unknown is the same `not_found`, so a caller learns nothing about a folder that `GET /folders/{id}` does not show them. A grant refuses the owner as a target and a target that is no
// member or team of the workspace, and then writes nothing. A grant and a revocation are recorded (`share.granted`, `share.revoked`, about the folder) in the
// transaction the stores are bound to, naming the kind and the identifier of the target and the name it had, and nothing else about the folder.

export interface FolderShareReadDependencies {
  readonly store: Pick<FolderShareStore, "ownedFolder" | "list">;
  readonly folders: Pick<FolderStore, "sharedWith">;
}

export interface FolderShareDependencies {
  readonly store: Pick<FolderShareStore, "ownedFolder" | "grant" | "revoke">;
  readonly folders: Pick<FolderStore, "sharedWith">;
  readonly audit: AuditWriter;
  /** Generates the identifier of a new share: a UUIDv7. */
  readonly newId: () => string;
}

export interface FolderShareReadAsk {
  /** The caller, who must own the folder. */
  readonly accountId: string;
  readonly folderId: string;
}

export interface FolderShareAsk {
  readonly workspaceId: string;
  /** The caller, who must own the folder. */
  readonly actor: AuditActor & { readonly type: "account" | "api_token" };
  readonly ipPrefix: string | null;
  readonly folderId: string;
}

export interface FolderShareGrantAsk extends FolderShareAsk {
  readonly target: ShareTarget;
}

export interface FolderShareRevocationAsk extends FolderShareAsk {
  readonly shareId: string;
}

export type FolderShareListOutcome = { readonly kind: "listed"; readonly list: FolderShareList } | { readonly kind: "forbidden" } | { readonly kind: "not_found" };

export type FolderShareGrantOutcome =
  | { readonly kind: "granted"; readonly share: FolderShareRecord }
  | { readonly kind: "existing"; readonly share: FolderShareRecord }
  /** The folder is shared with the caller, who may not share it further. */
  | { readonly kind: "forbidden" }
  | { readonly kind: "not_found" }
  /** The target is the owner. */
  | { readonly kind: "self" }
  | { readonly kind: "unknown_target"; readonly field: "accountId" | "teamId" };

export type FolderShareRevocationOutcome = { readonly kind: "revoked"; readonly share: FolderShareRecord } | { readonly kind: "forbidden" } | { readonly kind: "not_found" };

/** `forbidden` for a folder that is shared with the caller, `not_found` for any other folder the caller does not own. */
async function refusalFor(folders: Pick<FolderStore, "sharedWith">, folderId: string, accountId: string): Promise<{ readonly kind: "forbidden" } | { readonly kind: "not_found" }> {
  return (await folders.sharedWith({ folderId, accountId })) ? { kind: "forbidden" } : { kind: "not_found" };
}

export async function listFolderShares({ store, folders }: FolderShareReadDependencies, ask: FolderShareReadAsk): Promise<FolderShareListOutcome> {
  if (!(await store.ownedFolder({ folderId: ask.folderId, ownerId: ask.accountId, use: "read" }))) {
    return refusalFor(folders, ask.folderId, ask.accountId);
  }
  return { kind: "listed", list: await store.list(ask.folderId) };
}

export async function grantFolderShare({ store, folders, audit, newId }: FolderShareDependencies, ask: FolderShareGrantAsk): Promise<FolderShareGrantOutcome> {
  if (!(await store.ownedFolder({ folderId: ask.folderId, ownerId: ask.actor.accountId, use: "grant" }))) {
    return refusalFor(folders, ask.folderId, ask.actor.accountId);
  }
  if (ask.target.kind === "member" && ask.target.accountId.toLowerCase() === ask.actor.accountId.toLowerCase()) {
    return { kind: "self" };
  }
  const result = await store.grant({ id: newId(), folderId: ask.folderId, grantedBy: ask.actor.accountId, target: ask.target });
  if (result.kind === "unknown_target") {
    return { kind: "unknown_target", field: ask.target.kind === "member" ? "accountId" : "teamId" };
  }
  if (result.kind === "granted") {
    await audit.write({
      action: "share.granted",
      workspaceId: ask.workspaceId,
      actor: ask.actor,
      entity: { type: "folder", id: ask.folderId },
      metadata: { targetKind: ask.target.kind, targetId: ask.target.kind === "member" ? ask.target.accountId : ask.target.teamId, targetName: result.share.name },
      ipPrefix: ask.ipPrefix,
    });
  }
  return result;
}

export async function revokeFolderShare({ store, folders, audit }: Pick<FolderShareDependencies, "store" | "folders" | "audit">, ask: FolderShareRevocationAsk): Promise<FolderShareRevocationOutcome> {
  if (!(await store.ownedFolder({ folderId: ask.folderId, ownerId: ask.actor.accountId, use: "revoke" }))) {
    return refusalFor(folders, ask.folderId, ask.actor.accountId);
  }
  const share = await store.revoke({ folderId: ask.folderId, shareId: ask.shareId });
  if (share === undefined) {
    return { kind: "not_found" };
  }
  const targetId = share.accountId ?? share.teamId;
  if (targetId === null) {
    throw new Error("a share names neither a member nor a team");
  }
  await audit.write({
    action: "share.revoked",
    workspaceId: ask.workspaceId,
    actor: ask.actor,
    entity: { type: "folder", id: ask.folderId },
    metadata: { targetKind: share.accountId === null ? "team" : "member", targetId, targetName: share.name },
    ipPrefix: ask.ipPrefix,
  });
  return { kind: "revoked", share };
}
