import type {
  AccountLimitEntitlement,
  EntitlementKey,
  FlagEntitlement,
  WorkspaceLimitEntitlement,
} from "../ports/entitlements.ts";

// The entitlement catalog of doc 01 section 7.5: a closed, typed list of the keys a composition may limit.
// Adding a key is a contract change (doc 01 section 7.4). Personal API tokens, folders, tags, slugs, `/go`, the
// command palette, import and export, MFA and OIDC sign-in are not entitlements on any edition and have no key.

export type {
  AccountEntitlementValues,
  AccountLimitEntitlement,
  EntitlementKey,
  EntitlementLimit,
  FlagEntitlement,
  WorkspaceEntitlement,
  WorkspaceEntitlementValues,
  WorkspaceLimitEntitlement,
} from "../ports/entitlements.ts";

export type EntitlementScope = "workspace" | "account";
export type EntitlementType = "flag" | "limit";

export interface EntitlementDefinition {
  readonly scope: EntitlementScope;
  readonly type: EntitlementType;
}

/** Every key with its scope and type, in the order of the table in doc 01 section 7.5. The type admits no key outside `EntitlementKey` and none missing. */
export const ENTITLEMENT_CATALOG: Readonly<Record<EntitlementKey, EntitlementDefinition>> = Object.freeze({
  "bookmarks.max": { scope: "workspace", type: "limit" },
  "ai.suggestions": { scope: "workspace", type: "flag" },
  "sharing.members": { scope: "workspace", type: "flag" },
  "sharing.teams": { scope: "workspace", type: "flag" },
  "members.invite": { scope: "workspace", type: "flag" },
  "teams.manage": { scope: "workspace", type: "flag" },
  "audit.log": { scope: "workspace", type: "flag" },
  "seats.max": { scope: "workspace", type: "limit" },
  "workspaces.ownMax": { scope: "account", type: "limit" },
});

function keysOf(scope: EntitlementScope, type: EntitlementType): readonly string[] {
  return Object.entries(ENTITLEMENT_CATALOG)
    .filter(([, definition]) => definition.scope === scope && definition.type === type)
    .map(([key]) => key);
}

/** The workspace flags. */
export const FLAG_ENTITLEMENTS: readonly FlagEntitlement[] = Object.freeze(keysOf("workspace", "flag") as readonly FlagEntitlement[]);

/** The limits of a workspace. */
export const WORKSPACE_LIMIT_ENTITLEMENTS: readonly WorkspaceLimitEntitlement[] = Object.freeze(keysOf("workspace", "limit") as readonly WorkspaceLimitEntitlement[]);

/** The keys scoped to the acting account: they never enter the per-workspace set or its cache. */
export const ACCOUNT_LIMIT_ENTITLEMENTS: readonly AccountLimitEntitlement[] = Object.freeze(keysOf("account", "limit") as readonly AccountLimitEntitlement[]);

/** Whether `key` is a key of the catalog; a key outside it is never an entitlement. */
export function isEntitlementKey(key: string): key is EntitlementKey {
  return Object.hasOwn(ENTITLEMENT_CATALOG, key);
}
