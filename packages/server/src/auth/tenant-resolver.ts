import type { TenantResolver } from "@slugbase/core";

/**
 * The tenant resolver of a deployment whose accounts have no workspaces yet: no
 * principal acts in a workspace, so every request is account-level and an
 * operation that needs a workspace is refused by the authorization stage (the
 * port allows `undefined` for a principal with nothing to act in, doc 01
 * section 5.2). It reports itself unavailable, as the log-only mail adapter
 * does: no membership model stands behind it. The membership-backed resolver
 * replaces it when the workspace tables arrive.
 */
export function createAccountOnlyTenantResolver(): TenantResolver {
  return { available: false, resolve: () => Promise.resolve(undefined) };
}
