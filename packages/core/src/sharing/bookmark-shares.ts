import type { AuditActor, AuditWriter } from "../audit/index.ts";
import type { BookmarkShareList, BookmarkShareRecord, BookmarkShareStore, ShareTarget } from "./store.ts";

// The shares of a bookmark (doc 02 section 8, doc 04 section 10.7, doc 10 T2 and T11). Only the owner of a bookmark lists, grants or revokes its
// shares, and a bookmark that is another member's, another workspace's, gone or unknown is the same answer, so a caller learns nothing about a
// bookmark that is not theirs. A grant refuses the owner as a target and a target that is no member or team of the workspace, and then writes
// nothing. A grant and a revocation are recorded (`share.granted`, `share.revoked`) in the transaction the stores are bound to, naming the bookmark,
// the kind and the identifier of the target and the name it had, and nothing else about the bookmark: the log is read by administrators, who have no
// implicit access to a member's bookmarks (doc 02 section 8.2).

export interface BookmarkShareReadDependencies {
  readonly store: Pick<BookmarkShareStore, "ownedBookmark" | "list">;
}

export interface BookmarkShareDependencies {
  readonly store: Pick<BookmarkShareStore, "ownedBookmark" | "grant" | "revoke">;
  readonly audit: AuditWriter;
  /** Generates the identifier of a new share: a UUIDv7. */
  readonly newId: () => string;
}

export interface BookmarkShareReadAsk {
  /** The caller, who must own the bookmark. */
  readonly accountId: string;
  readonly bookmarkId: string;
}

export interface BookmarkShareAsk {
  readonly workspaceId: string;
  /** The caller, who must own the bookmark. */
  readonly actor: AuditActor & { readonly type: "account" | "api_token" };
  readonly ipPrefix: string | null;
  readonly bookmarkId: string;
}

export interface BookmarkShareGrantAsk extends BookmarkShareAsk {
  readonly target: ShareTarget;
}

export interface BookmarkShareRevocationAsk extends BookmarkShareAsk {
  readonly shareId: string;
}

export type BookmarkShareListOutcome = { readonly kind: "listed"; readonly list: BookmarkShareList } | { readonly kind: "not_found" };

export type BookmarkShareGrantOutcome =
  | { readonly kind: "granted"; readonly share: BookmarkShareRecord }
  | { readonly kind: "existing"; readonly share: BookmarkShareRecord }
  | { readonly kind: "not_found" }
  /** The target is the owner. */
  | { readonly kind: "self" }
  | { readonly kind: "unknown_target"; readonly field: "accountId" | "teamId" };

export type BookmarkShareRevocationOutcome = { readonly kind: "revoked"; readonly share: BookmarkShareRecord } | { readonly kind: "not_found" };

export async function listBookmarkShares({ store }: BookmarkShareReadDependencies, ask: BookmarkShareReadAsk): Promise<BookmarkShareListOutcome> {
  if (!(await store.ownedBookmark({ bookmarkId: ask.bookmarkId, ownerId: ask.accountId, use: "read" }))) {
    return { kind: "not_found" };
  }
  return { kind: "listed", list: await store.list(ask.bookmarkId) };
}

export async function grantBookmarkShare({ store, audit, newId }: BookmarkShareDependencies, ask: BookmarkShareGrantAsk): Promise<BookmarkShareGrantOutcome> {
  if (!(await store.ownedBookmark({ bookmarkId: ask.bookmarkId, ownerId: ask.actor.accountId, use: "grant" }))) {
    return { kind: "not_found" };
  }
  if (ask.target.kind === "member" && ask.target.accountId === ask.actor.accountId) {
    return { kind: "self" };
  }
  const result = await store.grant({ id: newId(), bookmarkId: ask.bookmarkId, grantedBy: ask.actor.accountId, target: ask.target });
  if (result.kind === "unknown_target") {
    return { kind: "unknown_target", field: ask.target.kind === "member" ? "accountId" : "teamId" };
  }
  if (result.kind === "granted") {
    await audit.write({
      action: "share.granted",
      workspaceId: ask.workspaceId,
      actor: ask.actor,
      entity: { type: "bookmark", id: ask.bookmarkId },
      metadata: { targetKind: ask.target.kind, targetId: ask.target.kind === "member" ? ask.target.accountId : ask.target.teamId, targetName: result.share.name },
      ipPrefix: ask.ipPrefix,
    });
  }
  return result;
}

export async function revokeBookmarkShare({ store, audit }: Pick<BookmarkShareDependencies, "store" | "audit">, ask: BookmarkShareRevocationAsk): Promise<BookmarkShareRevocationOutcome> {
  if (!(await store.ownedBookmark({ bookmarkId: ask.bookmarkId, ownerId: ask.actor.accountId, use: "revoke" }))) {
    return { kind: "not_found" };
  }
  const share = await store.revoke({ bookmarkId: ask.bookmarkId, shareId: ask.shareId });
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
    entity: { type: "bookmark", id: ask.bookmarkId },
    metadata: { targetKind: share.accountId === null ? "team" : "member", targetId, targetName: share.name },
    ipPrefix: ask.ipPrefix,
  });
  return { kind: "revoked", share };
}
