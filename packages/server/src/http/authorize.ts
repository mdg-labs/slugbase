import type { AuthPolicy, OperationDefinition } from "@slugbase/contracts";
import { reauthenticatedRecently, type EntitlementCheck, type WorkspaceRole } from "@slugbase/core";
import type { Principal } from "./authenticate.ts";
import type { RequestStage } from "./chain.ts";
import { ProblemError } from "./problem.ts";

// Stage 9 of the chain (doc 01 section 4, doc 10 T3): the policy the operation
// declares in its contract is checked before the handler runs. Every refusal
// is decided here from the principal and the tenant the earlier stages set;
// none depends on what the handler would do.

const ROLE_RANK: Readonly<Record<WorkspaceRole, number>> = { member: 1, admin: 2, owner: 3 };

const ROLE_REQUIRED: Readonly<Partial<Record<AuthPolicy, WorkspaceRole>>> = {
  member: "member",
  admin: "admin",
  owner: "owner",
};

export type { EntitlementCheck, EntitlementSubject } from "@slugbase/core";

/** No entitlement source is configured: an operation that declares one is refused. */
export const denyEntitlements: EntitlementCheck = () => false;

export interface AuthorizationOptions {
  /** Defaults to refusing every entitlement. */
  readonly entitlements?: EntitlementCheck;
  /** The instant, in milliseconds, a session's `reauth_at` is compared with; defaults to the system clock. */
  readonly now?: () => number;
}

const DETAILS = {
  unauthenticated: "Authentication is required.",
  mfa_required: "A second factor is required.",
  reauth_required: "Recent re-authentication is required.",
  forbidden: "You do not have access to this resource.",
  not_found: "No such resource.",
  token_scope: "This token's scope does not allow this operation.",
  entitlement_required: "This feature is not available.",
} as const;

/**
 * An operation that requires an account or member principal accepts an API token
 * only when it declares a scope, and not at all when it declares `reauth` (`403
 * forbidden`; doc 04 sections 1.2 and 4.2). An `anonymous` or `machine` operation
 * is outside the rule: this check does not apply to it and its handler does not
 * read the token principal. The request is still a bearer request for the
 * earlier stages, so it skips the cross-site check of stage 5. The answer
 * depends on the operation alone, so the validation stage asks it first: a token
 * request to an operation it may never call is refused whatever its body says.
 * Stage 9 asks it again as part of its own order.
 */
export function refuseUncallableToken(principal: Principal | undefined, operation: OperationDefinition): void {
  if (principal?.kind !== "api-token" || operation.auth === "anonymous" || operation.auth === "machine") {
    return;
  }
  if (operation.scope === undefined || operation.reauth === true) {
    throw new ProblemError("forbidden", DETAILS.forbidden);
  }
}

/**
 * Stage 9. In this order: a principal is required unless the operation is
 * `anonymous` or `machine` (`401 unauthenticated`); a session still waiting for
 * its second factor is accepted only by a `partial` operation (`401
 * mfa_required`); an API token is accepted only by an operation that requires
 * an account or member principal and declares a scope, and not at all by one
 * that declares `reauth` (`403 forbidden`), and a read-only token not by a
 * write (`403 token_scope`); `anonymous` and `machine` operations never reach
 * these checks; `member`, `admin` and
 * `owner` need the role of the resolved workspace or a higher one (`403
 * forbidden`), and a principal with no workspace is answered `404 not_found`
 * by all three; `instanceAdmin` needs an instance-admin session (`403
 * forbidden`); an operation that declares `reauth` needs a session
 * re-authenticated within the window of `reauthenticatedRecently` (`401 reauth_required`); a declared
 * entitlement must be held (`403 entitlement_required`).
 */
export function createAuthorization({ entitlements = denyEntitlements, now = Date.now }: AuthorizationOptions = {}): RequestStage {
  return async (context, next) => {
    const operation = context.get("route")?.operation;
    if (operation === undefined) {
      return next();
    }
    const { auth, scope, entitlement, reauth } = operation;
    const principal = context.get("principal");
    const tenant = context.get("tenant");

    if (auth === "anonymous" || auth === "machine") {
      if (entitlement !== undefined) {
        throw new ProblemError("entitlement_required", DETAILS.entitlement_required);
      }
      return next();
    }

    if (principal === undefined) {
      throw new ProblemError("unauthenticated", DETAILS.unauthenticated);
    }

    if (principal.kind === "session" && principal.mfaPending === true && auth !== "partial") {
      throw new ProblemError("mfa_required", DETAILS.mfa_required);
    }

    if (principal.kind === "api-token") {
      refuseUncallableToken(principal, operation);
      if (scope === "write" && principal.scope !== "read-write") {
        throw new ProblemError("token_scope", DETAILS.token_scope);
      }
    }

    const role = ROLE_REQUIRED[auth];
    if (role !== undefined) {
      // A principal with no workspace has nothing a workspace operation could name (doc 04 section 3.2).
      if (tenant === undefined) {
        throw new ProblemError("not_found", DETAILS.not_found);
      }
      // Written as "not at least" so a role outside the order is refused rather than passed.
      if (!(ROLE_RANK[tenant.role] >= ROLE_RANK[role])) {
        throw new ProblemError("forbidden", DETAILS.forbidden);
      }
    }
    if (auth === "instanceAdmin" && !(principal.kind === "session" && principal.instanceAdmin)) {
      throw new ProblemError("forbidden", DETAILS.forbidden);
    }

    if (reauth === true && !(principal.kind === "session" && reauthenticatedRecently(principal.reauthAt, now()))) {
      throw new ProblemError("reauth_required", DETAILS.reauth_required);
    }

    if (entitlement !== undefined) {
      const held = await entitlements(
        entitlement,
        {
          accountId: principal.accountId,
          ...(tenant === undefined ? {} : { workspaceId: tenant.workspaceId }),
        },
        context.req.raw,
      );
      if (!held) {
        throw new ProblemError("entitlement_required", DETAILS.entitlement_required);
      }
    }
    return next();
  };
}
