import type { AuthPolicy } from "@slugbase/contracts";
import type { WorkspaceRole } from "@slugbase/core";
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

/** Who an entitlement is evaluated for. */
export interface EntitlementSubject {
  readonly accountId: string;
  readonly workspaceId?: string;
}

/** Whether the subject holds an entitlement of the catalog (doc 01 section 7.5). */
export type EntitlementCheck = (entitlement: string, subject: EntitlementSubject) => boolean | Promise<boolean>;

/** No entitlement source is configured: an operation that declares one is refused. */
export const denyEntitlements: EntitlementCheck = () => false;

export interface AuthorizationOptions {
  /** Defaults to refusing every entitlement. */
  readonly entitlements?: EntitlementCheck;
}

const DETAILS = {
  unauthenticated: "Authentication is required.",
  forbidden: "You do not have access to this resource.",
  token_scope: "This token's scope does not allow this operation.",
  entitlement_required: "This feature is not available.",
} as const;

/**
 * Stage 9. In this order: a principal is required unless the operation is
 * `anonymous` or `machine` (`401 unauthenticated`); an API token is accepted
 * only by an operation that declares a scope (`403 forbidden`), and a read-only
 * token not by a write (`403 token_scope`); `member`, `admin` and `owner` need
 * the role of the resolved workspace or a higher one, `instanceAdmin` an
 * instance-admin session (`403 forbidden`); a declared entitlement must be
 * held (`403 entitlement_required`).
 */
export function createAuthorization({ entitlements = denyEntitlements }: AuthorizationOptions = {}): RequestStage {
  return async (context, next) => {
    const operation = context.get("route")?.operation;
    if (operation === undefined) {
      return next();
    }
    const { auth, scope, entitlement } = operation;
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

    if (principal.kind === "api-token") {
      if (scope === undefined) {
        throw new ProblemError("forbidden", DETAILS.forbidden);
      }
      if (scope === "write" && principal.scope !== "read-write") {
        throw new ProblemError("token_scope", DETAILS.token_scope);
      }
    }

    const role = ROLE_REQUIRED[auth];
    // Written as "not at least" so a role outside the order is refused rather than passed.
    if (role !== undefined && (tenant === undefined || !(ROLE_RANK[tenant.role] >= ROLE_RANK[role]))) {
      throw new ProblemError("forbidden", DETAILS.forbidden);
    }
    if (auth === "instanceAdmin" && !(principal.kind === "session" && principal.instanceAdmin)) {
      throw new ProblemError("forbidden", DETAILS.forbidden);
    }

    if (entitlement !== undefined) {
      const held = await entitlements(entitlement, {
        accountId: principal.accountId,
        ...(tenant === undefined ? {} : { workspaceId: tenant.workspaceId }),
      });
      if (!held) {
        throw new ProblemError("entitlement_required", DETAILS.entitlement_required);
      }
    }
    return next();
  };
}
