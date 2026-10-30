import {
  createBookmarkShare as createBookmarkShareOperation,
  createFolderShare as createFolderShareOperation,
  deleteBookmarkShare as deleteBookmarkShareOperation,
  deleteFolderShare as deleteFolderShareOperation,
  listBookmarkShares as listBookmarkSharesOperation,
  listFolderShares as listFolderSharesOperation,
  listShareTargets as listShareTargetsOperation,
  type BookmarkShareSchema,
  type FolderShareSchema,
} from "@slugbase/contracts";
import {
  createAuditWriter,
  findShareTargets,
  grantBookmarkShare,
  grantFolderShare,
  listBookmarkShares,
  listFolderShares,
  revokeBookmarkShare,
  revokeFolderShare,
  SHARE_ENTITLEMENTS,
  type AuditActor,
  type BookmarkShareRecord,
  type FolderShareRecord,
  type EntitlementCheck,
  type EntitlementUpgradeCheck,
  type ShareTargetKind,
} from "@slugbase/core";
import { accountProfileRepository, auditEventRepository, bookmarkShareRepository, folderRepository, folderShareRepository, shareTargetRepository } from "@slugbase/db";
import type { z } from "zod";
import { uuidv7 } from "../../auth/uuidv7.ts";
import { entitlementRequired } from "../../http/authorize.ts";
import type { Principal } from "../../http/authenticate.ts";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError } from "../../http/problem.ts";
import type { RequestTenant } from "../../http/tenant.ts";
import { networkPrefixOf } from "../../http/trusted-proxy.ts";
import { route } from "../register.ts";

// GET /api/v1/share-targets, GET, POST /api/v1/bookmarks/{id}/shares and DELETE /api/v1/bookmarks/{id}/shares/{shareId}, and the same three operations on
// /api/v1/folders/{id}/shares (doc 04 section 10.7, doc 02 section 8, doc 05 section 2.5, doc 10 T1, T2 and T11). All act in the workspace the request is
// bound to and name none. A folder is the owner's to share exactly as a bookmark is: one that is shared with the caller is `403 forbidden` and another member's
// that is not, another workspace's and an unknown one are the same `404 not_found`, the rules of the entitlements, of the refusals of a grant and of the audit
// events are those of the bookmark's, and the events are about the folder.
//
// Sharing needs `sharing.members` for a member and `sharing.teams` for a team. The kind is in the request, so the handlers decide the entitlement with
// the check stage 9 uses, before they touch the database: a grant needs the entitlement of its target, a search offers the kinds the workspace holds
// (and is refused when it holds neither), and the list and the revocation need either. A refusal is `403 entitlement_required` carrying the entitlement
// and whether the plan has a better one to offer. An error of the entitlement source ends the request with an error, never with a grant.
//
// Only the owner of a bookmark lists, grants or revokes its shares: a bookmark of another member, of another workspace or that does not exist is the same
// `404 not_found`, whatever the entitlement. A grant to the caller is `422 validation_failed` (`cannot_share_with_self`), and one to an account that is
// no member of the workspace or a team that is none of its teams is `422 validation_failed` (`unknown_member`, `unknown_team`), with nothing written. A
// repeated grant answers `200` with the share that exists; the first answers `201`. Each grant and revocation and its audit event (`share.granted`,
// `share.revoked`, naming the bookmark, the kind and the identifier of the target and its name) are one transaction. A bookmark that is shared with the caller is
// theirs to read and not to share further or see the shares of: the list, the grant and the revocation answer `403 forbidden` for it, and `404` for a bookmark
// that is another member's and not shared with them.

const UNAUTHENTICATED = "Authentication is required.";
const NO_WORKSPACE = "No such resource.";
const NO_SUCH_BOOKMARK = "No such resource.";
const NO_SUCH_FOLDER = "No such resource.";
const SHARED_READ_ONLY = "This bookmark is shared with you, and a share gives read access only.";
const SHARED_FOLDER_READ_ONLY = "This folder is shared with you, and a share gives read access only.";
const SELF_SHARE = "A bookmark is not shared with its owner.";
const SELF_SHARE_FOLDER = "A folder is not shared with its owner.";
const NOT_A_MEMBER = "The account must be a current member of the workspace.";
const NOT_A_TEAM = "The team must be a team of the workspace.";

function folderShareBody(share: FolderShareRecord): z.input<typeof FolderShareSchema> {
  return {
    id: share.id,
    kind: share.accountId === null ? "team" : "member",
    accountId: share.accountId,
    teamId: share.teamId,
    name: share.name,
    email: share.email,
    createdAt: share.createdAt.toISOString(),
  };
}

export interface SharingRoutesOptions {
  /** Decides an entitlement of the workspace the request acts in, as stage 9 does. */
  readonly entitlements: EntitlementCheck;
  /** Says whether a refused entitlement has a better plan to offer. */
  readonly upgradeAvailable: EntitlementUpgradeCheck;
}

function tenantOf(context: ChainContext): RequestTenant {
  const tenant = context.get("tenant");
  if (tenant === undefined) {
    throw new ProblemError("not_found", NO_WORKSPACE);
  }
  return tenant;
}

/** Who the audit log names for a change: the token when a bearer token made the request, the account otherwise. */
function auditActorOf(principal: Principal | undefined, accountId: string, label: string): AuditActor & { readonly type: "account" | "api_token" } {
  return principal?.kind === "api-token" ? { type: "api_token", accountId, tokenId: principal.tokenId, label } : { type: "account", accountId, label };
}

function shareBody(share: BookmarkShareRecord): z.input<typeof BookmarkShareSchema> {
  return {
    id: share.id,
    kind: share.accountId === null ? "team" : "member",
    accountId: share.accountId,
    teamId: share.teamId,
    name: share.name,
    email: share.email,
    createdAt: share.createdAt.toISOString(),
  };
}

export function sharingRoutes({ entitlements, upgradeAvailable }: SharingRoutesOptions): RouteBinding[] {
  const subjectOf = (tenant: RequestTenant) => ({ accountId: tenant.accountId, workspaceId: tenant.workspaceId });

  /** The kinds of target the workspace holds the entitlement for, asked one after the other so that a failing source ends the request. */
  async function heldKinds(context: ChainContext, tenant: RequestTenant): Promise<ShareTargetKind[]> {
    const held: ShareTargetKind[] = [];
    for (const kind of ["member", "team"] as const) {
      if (await entitlements(SHARE_ENTITLEMENTS[kind], subjectOf(tenant), context.req.raw)) {
        held.push(kind);
      }
    }
    return held;
  }

  /** Refuses with `403 entitlement_required` unless the workspace may share with at least one kind of target; answers the kinds it may. */
  async function requireSharing(context: ChainContext, tenant: RequestTenant): Promise<ShareTargetKind[]> {
    const held = await heldKinds(context, tenant);
    if (held.length === 0) {
      const missing = SHARE_ENTITLEMENTS.member;
      throw entitlementRequired(missing, await upgradeAvailable(missing, subjectOf(tenant), context.req.raw));
    }
    return held;
  }

  /** Refuses with `403 entitlement_required` unless the workspace may share with the kind of target. */
  async function requireSharingWith(context: ChainContext, tenant: RequestTenant, kind: ShareTargetKind): Promise<void> {
    const entitlement = SHARE_ENTITLEMENTS[kind];
    if (!(await entitlements(entitlement, subjectOf(tenant), context.req.raw))) {
      throw entitlementRequired(entitlement, await upgradeAvailable(entitlement, subjectOf(tenant), context.req.raw));
    }
  }

  /**
   * Runs `work` in the request's transaction with the stores of the shares and the audit log bound to it and the actor of the audit event. An account
   * whose profile cannot be read is no member of the workspace any more, so the bookmark or the folder is a resource it cannot see.
   */
  async function acting<T>(
    context: ChainContext,
    tenant: RequestTenant,
    work: (stores: { readonly store: ReturnType<typeof bookmarkShareRepository>; readonly folderStore: ReturnType<typeof folderShareRepository>; readonly folders: ReturnType<typeof folderRepository>; readonly audit: ReturnType<typeof createAuditWriter> }, request: { readonly workspaceId: string; readonly actor: ReturnType<typeof auditActorOf>; readonly ipPrefix: string | null }) => Promise<T>,
  ): Promise<T> {
    const principal = context.get("principal");
    if (principal === undefined) {
      throw new ProblemError("unauthenticated", UNAUTHENTICATED);
    }
    const ipPrefix = networkPrefixOf(context.get("clientIp")) ?? null;
    const outcome = await tenant.withTenant(async (tx) => {
      const profile = await accountProfileRepository(tx).profile();
      if (profile === undefined) {
        return undefined;
      }
      const actor = auditActorOf(principal, tenant.accountId, profile.displayName);
      return {
        value: await work({ store: bookmarkShareRepository(tx), folderStore: folderShareRepository(tx), folders: folderRepository(tx), audit: createAuditWriter({ store: auditEventRepository(tx), newId: uuidv7 }) }, { workspaceId: tenant.workspaceId, actor, ipPrefix }),
      };
    });
    if (outcome === undefined) {
      throw new ProblemError("not_found", NO_SUCH_BOOKMARK);
    }
    return outcome.value;
  }

  return [
    route(listShareTargetsOperation).handle(async ({ query }, context) => {
      const tenant = tenantOf(context);
      const kinds = await requireSharing(context, tenant);
      const items = await tenant.withTenant((tx) =>
        findShareTargets({ store: shareTargetRepository(tx) }, { q: query.q, excludeAccountId: tenant.accountId, kinds, limit: query.limit }),
      );
      return { status: 200, body: { items: items.map(({ kind, id, name, email }) => ({ kind, id, name, email })) } };
    }),

    route(listBookmarkSharesOperation).handle(async ({ params }, context) => {
      const tenant = tenantOf(context);
      await requireSharing(context, tenant);
      const outcome = await tenant.withTenant((tx) => listBookmarkShares({ store: bookmarkShareRepository(tx) }, { accountId: tenant.accountId, bookmarkId: params.id }));
      if (outcome.kind === "forbidden") {
        throw new ProblemError("forbidden", SHARED_READ_ONLY);
      }
      if (outcome.kind === "not_found") {
        throw new ProblemError("not_found", NO_SUCH_BOOKMARK);
      }
      return { status: 200, body: { items: outcome.list.shares.map(shareBody), audienceSize: outcome.list.audienceSize } };
    }),

    route(createBookmarkShareOperation).handle(async ({ params, body }, context) => {
      const tenant = tenantOf(context);
      const target = "accountId" in body ? ({ kind: "member", accountId: body.accountId } as const) : ({ kind: "team", teamId: body.teamId } as const);
      await requireSharingWith(context, tenant, target.kind);
      const outcome = await acting(context, tenant, ({ store, audit }, request) => grantBookmarkShare({ store, audit, newId: uuidv7 }, { ...request, bookmarkId: params.id, target }));
      switch (outcome.kind) {
        case "granted":
          return { status: 201, body: shareBody(outcome.share) };
        case "existing":
          return { status: 200, body: shareBody(outcome.share) };
        case "forbidden":
          throw new ProblemError("forbidden", SHARED_READ_ONLY);
        case "not_found":
          throw new ProblemError("not_found", NO_SUCH_BOOKMARK);
        case "self":
          throw new ProblemError("validation_failed", SELF_SHARE, { errors: [{ path: "accountId", code: "cannot_share_with_self" }] });
        case "unknown_target":
          throw new ProblemError("validation_failed", outcome.field === "accountId" ? NOT_A_MEMBER : NOT_A_TEAM, {
            errors: [{ path: outcome.field, code: outcome.field === "accountId" ? "unknown_member" : "unknown_team" }],
          });
      }
    }),

    route(deleteBookmarkShareOperation).handle(async ({ params }, context) => {
      const tenant = tenantOf(context);
      await requireSharing(context, tenant);
      const outcome = await acting(context, tenant, ({ store, audit }, request) => revokeBookmarkShare({ store, audit }, { ...request, bookmarkId: params.id, shareId: params.shareId }));
      if (outcome.kind === "forbidden") {
        throw new ProblemError("forbidden", SHARED_READ_ONLY);
      }
      if (outcome.kind === "not_found") {
        throw new ProblemError("not_found", NO_SUCH_BOOKMARK);
      }
      return { status: 204 };
    }),

    route(listFolderSharesOperation).handle(async ({ params }, context) => {
      const tenant = tenantOf(context);
      await requireSharing(context, tenant);
      const outcome = await tenant.withTenant((tx) => listFolderShares({ store: folderShareRepository(tx), folders: folderRepository(tx) }, { accountId: tenant.accountId, folderId: params.id }));
      if (outcome.kind === "forbidden") {
        throw new ProblemError("forbidden", SHARED_FOLDER_READ_ONLY);
      }
      if (outcome.kind === "not_found") {
        throw new ProblemError("not_found", NO_SUCH_FOLDER);
      }
      return { status: 200, body: { items: outcome.list.shares.map(folderShareBody), audienceSize: outcome.list.audienceSize } };
    }),

    route(createFolderShareOperation).handle(async ({ params, body }, context) => {
      const tenant = tenantOf(context);
      const target = "accountId" in body ? ({ kind: "member", accountId: body.accountId } as const) : ({ kind: "team", teamId: body.teamId } as const);
      await requireSharingWith(context, tenant, target.kind);
      const outcome = await acting(context, tenant, ({ folderStore, folders, audit }, request) => grantFolderShare({ store: folderStore, folders, audit, newId: uuidv7 }, { ...request, folderId: params.id, target }));
      switch (outcome.kind) {
        case "granted":
          return { status: 201, body: folderShareBody(outcome.share) };
        case "existing":
          return { status: 200, body: folderShareBody(outcome.share) };
        case "forbidden":
          throw new ProblemError("forbidden", SHARED_FOLDER_READ_ONLY);
        case "not_found":
          throw new ProblemError("not_found", NO_SUCH_FOLDER);
        case "self":
          throw new ProblemError("validation_failed", SELF_SHARE_FOLDER, { errors: [{ path: "accountId", code: "cannot_share_with_self" }] });
        case "unknown_target":
          throw new ProblemError("validation_failed", outcome.field === "accountId" ? NOT_A_MEMBER : NOT_A_TEAM, {
            errors: [{ path: outcome.field, code: outcome.field === "accountId" ? "unknown_member" : "unknown_team" }],
          });
      }
    }),

    route(deleteFolderShareOperation).handle(async ({ params }, context) => {
      const tenant = tenantOf(context);
      await requireSharing(context, tenant);
      const outcome = await acting(context, tenant, ({ folderStore, folders, audit }, request) => revokeFolderShare({ store: folderStore, folders, audit }, { ...request, folderId: params.id, shareId: params.shareId }));
      if (outcome.kind === "forbidden") {
        throw new ProblemError("forbidden", SHARED_FOLDER_READ_ONLY);
      }
      if (outcome.kind === "not_found") {
        throw new ProblemError("not_found", NO_SUCH_FOLDER);
      }
      return { status: 204 };
    }),
  ];
}
