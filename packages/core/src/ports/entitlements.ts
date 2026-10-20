import type { Port } from "./port.ts";

// The port of the entitlement catalog (doc 01 sections 6 and 7.5). The keys are written out here because a port
// imports nothing outside the ports; `entitlements/catalog.ts` gives each its scope and type, and holds the
// catalog to this list, so a key added to one without the other does not compile.

/** The keys that grant a feature or withhold it. */
export type FlagEntitlement = "ai.suggestions" | "sharing.members" | "sharing.teams" | "members.invite" | "teams.manage" | "audit.log";

/** The keys that cap a count of a workspace. */
export type WorkspaceLimitEntitlement = "bookmarks.max" | "seats.max";

/** The keys scoped to the acting account. */
export type AccountLimitEntitlement = "workspaces.ownMax";

export type WorkspaceEntitlement = FlagEntitlement | WorkspaceLimitEntitlement;
export type EntitlementKey = WorkspaceEntitlement | AccountLimitEntitlement;

/** A limit is a count the holder may reach, or no ceiling at all. */
export type EntitlementLimit = number | "unlimited";

/** The values of the workspace-scoped keys: the immutable payload of an `EntitlementSet`. */
export type WorkspaceEntitlementValues = { readonly [K in FlagEntitlement]: boolean } & {
  readonly [K in WorkspaceLimitEntitlement]: EntitlementLimit;
};

/** The values of the account-scoped keys. */
export type AccountEntitlementValues = { readonly [K in AccountLimitEntitlement]: EntitlementLimit };

/** What a source grants one workspace, and whether the plan behind it has a better one to offer. */
export interface WorkspaceEntitlementGrant {
  readonly values: WorkspaceEntitlementValues;
  /** Whether an upgrade path exists for the workspace: what `GET /entitlements` reports and the upgrade slot reads. */
  readonly upgradeAvailable: boolean;
}

/**
 * Where the values of the entitlement catalog come from. The catalog, the evaluation and the enforcement belong
 * to CE; a composition supplies only the values. A source answers from state it holds locally and never makes a
 * live call to a billing service from inside a request.
 */
export interface EntitlementSource extends Port {
  /** The workspace-scoped values of one workspace. */
  forWorkspace(workspaceId: string): Promise<WorkspaceEntitlementGrant>;
  /** The account-scoped values of one account, over every workspace it owns. */
  forAccount(accountId: string): Promise<AccountEntitlementValues>;
}
