import {
  createWorkspace as createWorkspaceOperation,
  getWorkspace,
  getWorkspaceSettings,
  type WorkspaceSchema,
  listWorkspaces,
  renameWorkspace as renameWorkspaceOperation,
  setActiveWorkspace,
  updateWorkspaceSettings,
} from "@slugbase/contracts";
import {
  canCreateWorkspace,
  changeWorkspaceSettings,
  createAuditWriter,
  createWorkspace,
  renameWorkspace,
  type AuditActor,
  type WorkspaceStore,
} from "@slugbase/core";
import { accountProfileRepository, auditEventRepository, workspaceRepository, type Database, type TenantTx, type WorkspaceDetail } from "@slugbase/db";
import type { z } from "zod";
import { uuidv7 } from "../../auth/uuidv7.ts";
import { queueDomainEvent } from "../../events/publish.ts";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError, requestIdOf } from "../../http/problem.ts";
import type { RequestTenant } from "../../http/tenant.ts";
import { networkPrefixOf } from "../../http/trusted-proxy.ts";
import { route } from "../register.ts";
import { acceptedVersions, entityTagOf } from "./if-match.ts";

// GET /api/v1/workspaces and POST /api/v1/workspaces (doc 04 section 10.4, doc 02 section 3.2, doc 05
// sections 2.2, 2.9 and 3.3, doc 10 T1). Both act on the signed-in session's own account in an account-level
// transaction: the list reads its memberships on row-level security, and the creation makes the workspace
// for the account of that transaction through `sys_create_workspace`, never for one the request names (the
// body is a closed object with a name and nothing else). The workspace, its owner membership and settings,
// the `workspace.created` event job and the audit event are one transaction, so a failure of any of them
// leaves none. The operations declare no token scope, so an API token is refused before the handler runs,
// and neither changes the session's active workspace.
//
// PUT /api/v1/session/active-workspace moves the session to a workspace the account is a member of through
// `sys_session_set_active_workspace`, which judges the membership in the statement that writes the session;
// a workspace the account does not belong to, does not exist or is being deleted is one and the same
// `404 not_found`, and the session keeps the workspace it had (doc 10 T1). It needs a session (the operation
// declares no token scope, so an API token is refused before the handler runs). The resolver of stage 7
// re-derives a workspace the account can no longer reach on the next request, so nothing here repairs it.
//
// GET and PATCH /api/v1/workspace and GET and PATCH /api/v1/workspace/settings act in the workspace the request
// is bound to, which the tenant stage resolved from the session or the token, and name none (doc 04 sections
// 2.4 and 10.4, doc 02 sections 3.1 and 10, doc 10 T1 and T3). The reading is open to a member and a read-scope
// token; the rename and both settings operations are an admin's, and none of them declares a token scope, so a
// token never reaches them. The role is judged by the authorization stage before any handler runs. A rename
// takes `If-Match` and compares it with the version under the row lock, so a stale tab cannot overwrite a newer
// name; the change and its audit event are one transaction, and a change that changes nothing writes no event.

const UNAUTHENTICATED = "Authentication is required.";
const NOT_ALLOWED = "This deployment does not let accounts create workspaces.";
const NO_SUCH_WORKSPACE = "There is no such workspace.";
const UNVERIFIED = "Verify your email address before you create a workspace.";

const NO_WORKSPACE = "No such resource.";
const STALE_VERSION = "The workspace has changed since it was read; read it again and retry.";

export interface WorkspaceRoutesOptions {
  readonly withTenant: Database["withTenant"];
  /**
   * Whether the deployment lets ordinary accounts create workspaces: the default the composition root supplies
   * (the Community Edition's is off). It is a plain value so that no edition decides it (D4).
   */
  readonly creationAllowed: boolean;
}

function sessionOf(context: ChainContext): { readonly sessionId: string; readonly accountId: string } {
  const principal = context.get("principal");
  if (principal?.kind !== "session") {
    throw new ProblemError("unauthenticated", UNAUTHENTICATED);
  }
  return principal;
}

function accountOf(context: ChainContext): string {
  return sessionOf(context).accountId;
}

/** The workspace the request acts in; the authorization stage has already answered 404 for a request that acts in none. */
function tenantOf(context: ChainContext): RequestTenant {
  const tenant = context.get("tenant");
  if (tenant === undefined) {
    throw new ProblemError("not_found", NO_WORKSPACE);
  }
  return tenant;
}

/** The account that asked, as the audit log names it. Only a session reaches the operations that write. */
function actorOf(context: ChainContext, displayName: string): AuditActor {
  return { type: "account", accountId: sessionOf(context).accountId, label: displayName };
}

/** The core store over the repository of the open transaction; the workspace is always made for the transaction's own account. */
function storeOf(tx: TenantTx): WorkspaceStore {
  const repository = workspaceRepository(tx);
  return {
    create({ accountId, workspaceId, name, events }) {
      if (accountId.toLowerCase() !== tx.accountId) {
        throw new Error("a workspace is created for the account of the transaction only");
      }
      return repository.create({ id: workspaceId, name, jobs: events.map((event) => queueDomainEvent(event.eventId, event.name, event.payload)) });
    },
  };
}

function workspaceBody(workspace: WorkspaceDetail): z.input<typeof WorkspaceSchema> {
  const { id, name, role, memberCount, createdAt, version } = workspace;
  return { id, name, role, memberCount, createdAt: createdAt.toISOString(), version };
}

export function workspaceRoutes({ withTenant, creationAllowed }: WorkspaceRoutesOptions): RouteBinding[] {
  return [
    route(listWorkspaces).handle(async (_request, context) => {
      const accountId = accountOf(context);
      const { workspaces, profile } = await withTenant({ accountId, requestId: requestIdOf(context) }, async (tx) => ({
        workspaces: await workspaceRepository(tx).list(),
        profile: await accountProfileRepository(tx).profile(),
      }));
      if (profile === undefined) {
        throw new ProblemError("unauthenticated", UNAUTHENTICATED);
      }
      return {
        status: 200,
        body: {
          items: workspaces.map(({ id, name, role, memberCount }) => ({ id, name, role, memberCount })),
          canCreate: canCreateWorkspace({ creationAllowed, emailVerified: profile.emailVerified }),
        },
      };
    }),

    route(createWorkspaceOperation).handle(async ({ body }, context) => {
      const accountId = accountOf(context);
      const ipPrefix = networkPrefixOf(context.get("clientIp")) ?? null;
      const outcome = await withTenant({ accountId, requestId: requestIdOf(context) }, async (tx) => {
        const profile = await accountProfileRepository(tx).profile();
        if (profile === undefined) {
          return { kind: "unavailable" } as const;
        }
        return createWorkspace(
          { store: storeOf(tx), audit: createAuditWriter({ store: auditEventRepository(tx), newId: uuidv7 }), newId: uuidv7 },
          { accountId, displayName: profile.displayName, emailVerified: profile.emailVerified, creationAllowed, ipPrefix, name: body.name },
        );
      });
      switch (outcome.kind) {
        case "created":
          return { status: 201, body: { id: outcome.workspaceId, name: body.name, role: "owner", memberCount: 1 } };
        case "not_allowed":
          throw new ProblemError("forbidden", NOT_ALLOWED);
        case "unverified":
          throw new ProblemError("email_unverified", UNVERIFIED);
        case "unavailable":
          throw new ProblemError("unauthenticated", UNAUTHENTICATED);
      }
    }),

    route(setActiveWorkspace).handle(async ({ body }, context) => {
      const { sessionId, accountId } = sessionOf(context);
      const switched = await withTenant({ accountId, requestId: requestIdOf(context) }, (tx) => workspaceRepository(tx).setActive(sessionId, body.workspaceId));
      if (!switched) {
        throw new ProblemError("not_found", NO_SUCH_WORKSPACE);
      }
      return { status: 204 };
    }),

    route(getWorkspace).handle(async (_request, context) => {
      const workspace = await tenantOf(context).withTenant((tx) => workspaceRepository(tx).current());
      if (workspace === undefined) {
        throw new ProblemError("not_found", NO_WORKSPACE);
      }
      return { status: 200, body: workspaceBody(workspace), headers: { ETag: entityTagOf(workspace.version) } };
    }),

    route(renameWorkspaceOperation).handle(async ({ body }, context) => {
      const tenant = tenantOf(context);
      const ipPrefix = networkPrefixOf(context.get("clientIp")) ?? null;
      const expectedVersions = acceptedVersions(context.req.header("if-match"));
      const result = await tenant.withTenant(async (tx) => {
        const profile = await accountProfileRepository(tx).profile();
        if (profile === undefined) {
          return { kind: "unavailable" } as const;
        }
        const repository = workspaceRepository(tx);
        const outcome = await renameWorkspace(
          { store: repository, audit: createAuditWriter({ store: auditEventRepository(tx), newId: uuidv7 }) },
          { workspaceId: tenant.workspaceId, actor: actorOf(context, profile.displayName), ipPrefix, name: body.name, expectedVersions },
        );
        if (outcome.kind === "stale" || outcome.kind === "unavailable") {
          return outcome;
        }
        const workspace = await repository.current();
        return workspace === undefined ? ({ kind: "unavailable" } as const) : ({ kind: "done", workspace } as const);
      });
      switch (result.kind) {
        case "stale":
          throw new ProblemError("precondition_failed", STALE_VERSION);
        case "unavailable":
          throw new ProblemError("not_found", NO_WORKSPACE);
        case "done":
          return { status: 200, body: workspaceBody(result.workspace), headers: { ETag: entityTagOf(result.workspace.version) } };
      }
    }),

    route(getWorkspaceSettings).handle(async (_request, context) => {
      const settings = await tenantOf(context).withTenant((tx) => workspaceRepository(tx).settings());
      if (settings === undefined) {
        throw new ProblemError("not_found", NO_WORKSPACE);
      }
      return { status: 200, body: { aiEnabled: settings.aiEnabled } };
    }),

    route(updateWorkspaceSettings).handle(async ({ body }, context) => {
      const tenant = tenantOf(context);
      const ipPrefix = networkPrefixOf(context.get("clientIp")) ?? null;
      const outcome = await tenant.withTenant(async (tx) => {
        const profile = await accountProfileRepository(tx).profile();
        if (profile === undefined) {
          return { kind: "unavailable" } as const;
        }
        return changeWorkspaceSettings(
          { store: workspaceRepository(tx), audit: createAuditWriter({ store: auditEventRepository(tx), newId: uuidv7 }) },
          { workspaceId: tenant.workspaceId, actor: actorOf(context, profile.displayName), ipPrefix, patch: body },
        );
      });
      if (outcome.kind === "unavailable") {
        throw new ProblemError("not_found", NO_WORKSPACE);
      }
      return { status: 200, body: { aiEnabled: outcome.settings.aiEnabled } };
    }),
  ];
}
