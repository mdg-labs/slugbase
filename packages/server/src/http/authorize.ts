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

/** How recently a session must have re-authenticated for an operation that declares `reauth` (doc 04 section 4.4, doc 02 section 16). */
export const REAUTH_WINDOW_MS = 10 * 60 * 1000;

const DETAILS = {
  unauthenticated: "Authentication is required.",
  mfa_required: "A second factor is required.",
  reauth_required: "Recent re-authentication is required.",
  forbidden: "You do not have access to this resource.",
  not_found: "No such resource.",
  token_scope: "This token's scope does not allow this operation.",
  entitlement_required: "This feature is not available.",
} as const;

/** Written as "within the window" so a missing, invalid or future timestamp is stale rather than fresh. */
function reauthenticatedRecently(reauthAt: Date | undefined): boolean {
  if (reauthAt === undefined) {
    return false;
  }
  const age = Date.now() - reauthAt.getTime();
  return age >= 0 && age <= REAUTH_WINDOW_MS;
}

/**
 * Stage 9. In this order: a principal is required unless the operation is
 * `anonymous` or `machine` (`401 unauthenticated`); a session still waiting for
 * its second factor is accepted only by a `partial` operation (`401
 * mfa_required`); an API token is accepted only by an operation that declares a
 * scope and not at all by one that declares `reauth` (`403 forbidden`), and a
 * read-only token not by a write (`403 token_scope`); `member`, `admin` and
 * `owner` need the role of the resolved workspace or a higher one (`403
 * forbidden`), and a principal with no workspace is answered `404 not_found`
 * by all three; `instanceAdmin` needs an instance-admin session (`403
 * forbidden`); an operation that declares `reauth` needs a session
 * re-authenticated within `REAUTH_WINDOW_MS` (`401 reauth_required`); a declared
 * entitlement must be held (`403 entitlement_required`).
 */
export function createAuthorization({ entitlements = denyEntitlements }: AuthorizationOptions = {}): RequestStage {
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
      if (scope === undefined || reauth === true) {
        throw new ProblemError("forbidden", DETAILS.forbidden);
      }
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

    if (reauth === true && !(principal.kind === "session" && reauthenticatedRecently(principal.reauthAt))) {
      throw new ProblemError("reauth_required", DETAILS.reauth_required);
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
