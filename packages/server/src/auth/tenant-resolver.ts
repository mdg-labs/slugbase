import type { TenantPrincipal, TenantResolver } from "@slugbase/core";
import { membershipRepository, type Database, type Membership } from "@slugbase/db";

// The tenant resolvers of stage 7 (doc 01 section 4, section 5.2).

// What a membership's `last_active_at` must lag by before the resolver writes it again; the write is
// conditioned on the same interval in the database, so the interval holds across processes.
const ACTIVITY_INTERVAL_MS = 60_000;

const DEFERS_TO_MEMBERSHIPS: unique symbol = Symbol("slugbase.tenantResolver.defersToMemberships");

/**
 * The tenant resolver of a deployment that has not chosen one: it reports itself unavailable, as
 * the log-only mail adapter does, and `createServer` resolves the request's workspace from the
 * principal's memberships in its place (`createMembershipTenantResolver`). Used as a resolver
 * of its own it puts every request at account level.
 */
export function createAccountOnlyTenantResolver(): TenantResolver {
  return Object.assign({ available: false as const, resolve: () => Promise.resolve(undefined) }, { [DEFERS_TO_MEMBERSHIPS]: true as const });
}

/** Whether the resolver stands for "no choice made", so that the server resolves from memberships instead. */
export function defersToMembershipResolver(resolver: TenantResolver): boolean {
  return (resolver as { [DEFERS_TO_MEMBERSHIPS]?: unknown })[DEFERS_TO_MEMBERSHIPS] === true;
}

export interface MembershipTenantResolverOptions {
  /** The tenant transaction the memberships are read in; account level, so the account's own rows are all it sees. */
  readonly withTenant: Database["withTenant"];
  /** The clock `last_active_at` is compared with; defaults to the system clock. */
  readonly now?: () => number;
}

function chosenMembership(principal: TenantPrincipal, memberships: readonly Membership[]): Membership | undefined {
  if (principal.kind === "api-token") {
    // A token acts in the workspace it is bound to and nowhere else, even when that membership is gone.
    const bound = principal.workspaceId.toLowerCase();
    return memberships.find((membership) => membership.workspaceId === bound);
  }
  const active = principal.activeWorkspaceId?.toLowerCase();
  // Empty or no longer a membership: the member's most recently active one, which the list puts first.
  return memberships.find((membership) => membership.workspaceId === active) ?? memberships[0];
}

/**
 * The resolver of the sessions and tokens of `createServer`. It reads the account's memberships
 * once, in an account-level transaction on row-level security alone, so a workspace named by a
 * forged `active_workspace_id` that the account is not a member of is not among them and is never
 * made the transaction's workspace (T1). A session's active workspace is used while the account is
 * a member of it; otherwise the account's most recently active membership is, or none.
 * `last_active_at` of the chosen membership is moved forward, at most once a minute, for a session.
 */
export function createMembershipTenantResolver({ withTenant, now = Date.now }: MembershipTenantResolverOptions): TenantResolver {
  return {
    available: true,
    async resolve(principal, { requestId }) {
      const { accountId } = principal;
      const memberships = await withTenant({ accountId, requestId }, (tx) => membershipRepository(tx).list());
      const chosen = chosenMembership(principal, memberships);
      if (chosen === undefined) {
        return undefined;
      }
      const dueAt = chosen.lastActiveAt === null ? undefined : chosen.lastActiveAt.getTime() + ACTIVITY_INTERVAL_MS;
      if (principal.kind === "session" && (dueAt === undefined || now() >= dueAt)) {
        await withTenant({ accountId, workspaceId: chosen.workspaceId, requestId }, (tx) => membershipRepository(tx).touch());
      }
      return { workspaceId: chosen.workspaceId, memberId: accountId, role: chosen.role };
    },
  };
}
