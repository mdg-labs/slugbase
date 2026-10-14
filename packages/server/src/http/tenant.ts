import type { TenantResolver, TenantResolution, WorkspaceRole } from "@slugbase/core";
import type { Database, TenantTx } from "@slugbase/db";
import type { RequestStage } from "./chain.ts";
import { ProblemError, requestIdOf } from "./problem.ts";

// Stage 7 of the chain (doc 01 section 4, section 5.2): the principal's active
// workspace, member and role come from the `TenantResolver` port, once per
// request. The handler is given a `withTenant` bound to that workspace and the
// request's account, so it cannot name another workspace (doc 01 section 5.3).

/** The workspace a request acts in. It exists only when the resolver found one. */
export interface RequestTenant {
  readonly accountId: string;
  readonly workspaceId: string;
  readonly memberId: string;
  readonly role: WorkspaceRole;
  /** Runs `fn` in a tenant transaction for this account and workspace. */
  withTenant<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T>;
}

export interface TenantResolutionOptions {
  readonly resolver: TenantResolver;
  readonly withTenant: Database["withTenant"];
}

/**
 * Stage 7. A request without a principal has no tenant context, nor has a
 * session whose second factor is pending. A session whose resolver finds no
 * workspace proceeds without one (account-level operations need none; one that
 * needs a workspace is answered `404` by the authorization stage). An API token
 * acts in its bound workspace only: a resolver that finds none means the token
 * no longer grants access, and one that answers another workspace is an error,
 * never a context.
 */
export function createTenantResolution({ resolver, withTenant }: TenantResolutionOptions): RequestStage {
  return async (context, next) => {
    const principal = context.get("principal");
    if (principal === undefined) {
      return next();
    }

    // A session still waiting for its second factor acts in no workspace, and its use writes no activity.
    if (principal.kind === "session" && principal.mfaPending === true) {
      return next();
    }

    const requestId = requestIdOf(context);
    const resolution: TenantResolution | undefined = await resolver.resolve(principal, { requestId });
    if (principal.kind === "api-token") {
      if (resolution === undefined) {
        throw new ProblemError("unauthenticated", "The credential was not accepted.");
      }
      if (resolution.workspaceId.toLowerCase() !== principal.workspaceId.toLowerCase()) {
        throw new Error("the tenant resolver answered a workspace other than the one the token is bound to");
      }
    }
    if (resolution === undefined) {
      return next();
    }

    const { accountId } = principal;
    const { workspaceId, memberId, role } = resolution;
    context.set("tenant", {
      accountId,
      workspaceId,
      memberId,
      role,
      withTenant: (fn) => withTenant({ accountId, workspaceId, requestId }, fn),
    });
    context.set("workspaceId", workspaceId);
    return next();
  };
}
