import {
  createWorkspace as createWorkspaceOperation,
  deleteWorkspace,
  getWorkspace,
  getWorkspaceSettings,
  leaveWorkspace,
  type WorkspaceSchema,
  listWorkspaces,
  renameWorkspace as renameWorkspaceOperation,
  setActiveWorkspace,
  transferWorkspaceOwnership,
  updateWorkspaceSettings,
} from "@slugbase/contracts";
import {
  canCreateWorkspace,
  changeWorkspaceSettings,
  createAuditWriter,
  createWorkspace,
  renameWorkspace,
  requestWorkspaceDeletion,
  transferOwnership,
  type AuditActor,
  type MailPort,
  type SessionCookieSpec,
  type WorkspaceStore,
} from "@slugbase/core";
import {
  accountProfileRepository,
  auditEventRepository,
  isLastOwnerViolation,
  memberRepository,
  workspaceRepository,
  type Database,
  type TenantTx,
  type WorkspaceDetail,
} from "@slugbase/db";
import type { z } from "zod";
import { setSessionCookie } from "../../auth/cookie.ts";
import { newSessionToken } from "../../auth/session-token.ts";
import { uuidv7 } from "../../auth/uuidv7.ts";
import { queueDomainEvent } from "../../events/publish.ts";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError, requestIdOf } from "../../http/problem.ts";
import type { RequestTenant } from "../../http/tenant.ts";
import { networkPrefixOf } from "../../http/trusted-proxy.ts";
import { endMembershipOf } from "../members/departure.ts";
import { memberBody } from "../members/index.ts";
import { route } from "../register.ts";
import { queueOwnershipTransferredMail } from "../../worker/jobs/mail-send.ts";
import { WORKSPACE_DELETE_JOB } from "../../worker/jobs/workspace-delete.ts";
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
//
// DELETE /api/v1/workspace marks the workspace the request acts in as being deleted and answers 202 (doc 04 section 10.4,
// doc 02 section 3.7, doc 05 section 7.2, doc 01 section 13.2). It is an owner's, needs a session that re-authenticated
// within ten minutes (the authorization stage judges both before the handler runs), and declares no token scope. Before
// anything changes the deletion guard of the composition is asked: a refusal is its code (409 billing_active) and a guard
// that throws or times out is 503 from the dispatcher, both with nothing written. The mark, the revocation of the
// workspace's tokens, the sessions pointed at none, the `workspace.delete` job and the audit event are one transaction;
// the job removes the rows afterwards. A workspace that is being deleted is not one the request can act in, so a repeated
// request is 404.
//
// POST /api/v1/workspace/transfer-ownership makes another member of the workspace the request acts in an owner and,
// when asked, steps the caller down to admin (doc 04 section 10.4, doc 02 section 3.3, doc 10 T1, T2 and T18). It is
// an owner's, needs a session that re-authenticated within ten minutes (the authorization stage judges both before the
// handler runs) and declares no token scope. The member service judges the roles again under the lock of the workspace's
// row; the promotion, the demotion, the audit event, the rotation of the caller's session token when the caller stepped
// down and the recipient's email are one transaction, and the database refuses the commit of one that would leave the
// workspace without an owner (409 last_owner). The new token travels in Set-Cookie only when the caller stepped down.
// An account that is no member of the workspace is 404 whichever workspace it belongs to. The email is queued only for
// a recipient the request made an owner, and only when the composition can send mail.
//
// POST /api/v1/workspace/leave ends the caller's own membership of the workspace the request acts in with the
// content choice of doc 02 section 3.6, as the removal of a member does (routes/members/departure.ts); it is a
// member's, and declares no token scope.

const UNAUTHENTICATED = "Authentication is required.";
const NOT_ALLOWED = "This deployment does not let accounts create workspaces.";
const NO_SUCH_WORKSPACE = "There is no such workspace.";
const UNVERIFIED = "Verify your email address before you create a workspace.";

const NO_WORKSPACE = "No such resource.";
const DELETION_REFUSED = "The workspace cannot be deleted while its subscription is active; cancel the subscription first.";
const NOT_AN_OWNER = "Only an owner can transfer the ownership of the workspace.";
const NO_SUCH_MEMBER = "There is no such member.";
const OWN_ACCOUNT = "Ownership cannot be transferred to yourself.";
const LAST_OWNER = "A workspace always has an owner; make another member an owner first.";
const STALE_VERSION = "The workspace has changed since it was read; read it again and retry.";

export interface WorkspaceRoutesOptions {
  readonly withTenant: Database["withTenant"];
  /**
   * Whether the deployment lets ordinary accounts create workspaces: the default the composition root supplies
   * (the Community Edition's is off). It is a plain value so that no edition decides it (D4).
   */
  readonly creationAllowed: boolean;
  readonly cookie: SessionCookieSpec;
  /** The mail port of the composition; the recipient of an ownership transfer is mailed only when it can send. */
  readonly mail: Pick<MailPort, "available">;
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
function actorOf(context: ChainContext, displayName: string): Extract<AuditActor, { type: "account" }> {
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

export function workspaceRoutes({ withTenant, creationAllowed, cookie, mail }: WorkspaceRoutesOptions): RouteBinding[] {
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

    route(deleteWorkspace).handle(async (_request, context) => {
      const tenant = tenantOf(context);
      const hooks = context.get("hooks");
      if (hooks === undefined) {
        throw new Error("the workspace deletion route was reached without the hook dispatcher");
      }
      const ipPrefix = networkPrefixOf(context.get("clientIp")) ?? null;
      const outcome = await tenant.withTenant(async (tx) => {
        const profile = await accountProfileRepository(tx).profile();
        if (profile === undefined) {
          return { kind: "unavailable" } as const;
        }
        const repository = workspaceRepository(tx);
        return requestWorkspaceDeletion(
          {
            store: { markDeleting: () => repository.markDeleting([{ id: uuidv7(), queue: WORKSPACE_DELETE_JOB, data: { workspaceId: tenant.workspaceId } }]) },
            audit: createAuditWriter({ store: auditEventRepository(tx), newId: uuidv7 }),
            guard: ({ workspaceId, accountId }) => hooks.deletionGuard({ kind: "workspace", workspaceId, accountId, requestedBy: "member" }),
          },
          { workspaceId: tenant.workspaceId, actor: actorOf(context, profile.displayName), ipPrefix },
        );
      });
      switch (outcome.kind) {
        case "requested":
          return { status: 202 };
        case "refused":
          throw new ProblemError(outcome.code, DELETION_REFUSED);
        case "unavailable":
          throw new ProblemError("not_found", NO_WORKSPACE);
      }
    }),

    route(transferWorkspaceOwnership).handle(async ({ body }, context) => {
      const { sessionId, accountId } = sessionOf(context);
      const tenant = tenantOf(context);
      const targetAccountId = body.accountId.toLowerCase();
      const ipPrefix = networkPrefixOf(context.get("clientIp")) ?? null;
      const token = newSessionToken();
      let result;
      try {
        result = await tenant.withTenant(async (tx) => {
          const profile = await accountProfileRepository(tx).profile();
          if (profile === undefined) {
            return { kind: "not_found" } as const;
          }
          const repository = memberRepository(tx);
          const outcome = await transferOwnership(
            { store: repository, audit: createAuditWriter({ store: auditEventRepository(tx), newId: uuidv7 }) },
            { workspaceId: tenant.workspaceId, actor: actorOf(context, profile.displayName), actorAccountId: accountId, targetAccountId, demoteSelf: body.demoteSelf, ipPrefix },
          );
          if (outcome.kind === "forbidden" || outcome.kind === "not_found" || outcome.kind === "invalid_recipient") {
            return outcome;
          }
          const rotated = outcome.kind === "transferred" && outcome.demoted;
          if (rotated && !(await repository.rotateSession(sessionId, token.hash))) {
            throw new ProblemError("unauthenticated", UNAUTHENTICATED);
          }
          if (outcome.kind === "transferred" && outcome.promoted && mail.available) {
            await repository.enqueue([queueOwnershipTransferredMail(uuidv7(), targetAccountId, { workspaceId: tenant.workspaceId, fromAccountId: accountId })]);
          }
          const member = await repository.member(targetAccountId);
          if (member === undefined) {
            throw new Error("the recipient of an ownership transfer is not a member after the transfer");
          }
          return { kind: "done", member, rotated } as const;
        });
      } catch (error) {
        // The database refuses the commit of a transaction that leaves the workspace without an owner: the roles, the audit event, the email and the new token are not written.
        if (isLastOwnerViolation(error)) {
          throw new ProblemError("last_owner", LAST_OWNER);
        }
        throw error;
      }
      switch (result.kind) {
        case "forbidden":
          throw new ProblemError("forbidden", NOT_AN_OWNER);
        case "not_found":
          throw new ProblemError("not_found", NO_SUCH_MEMBER);
        case "invalid_recipient":
          throw new ProblemError("validation_failed", OWN_ACCOUNT, { errors: [{ path: "accountId", code: "invalid_recipient" }] });
        case "done":
          return { status: 200, body: memberBody(result.member), ...(result.rotated ? { headers: { "Set-Cookie": setSessionCookie(cookie, token.value) } } : {}) };
      }
    }),

    route(leaveWorkspace).handle(async ({ body }, context) => ({
      status: 200,
      body: await endMembershipOf(context, { targetAccountId: accountOf(context), content: body.content, transferTo: body.transferTo }),
    })),
  ];
}
