import type { AccountEntitlementValues, EntitlementSource, WorkspaceEntitlementGrant } from "@slugbase/core";

// The Community Edition's entitlement source (doc 01 sections 6 and 7.5): every flag is granted and every limit
// is unlimited, for every workspace and every account. It reads no state, so nothing here varies by workspace,
// by account or by time, and no upgrade path exists.

const WORKSPACE_GRANT: WorkspaceEntitlementGrant = Object.freeze({
  values: Object.freeze({
    "bookmarks.max": "unlimited",
    "seats.max": "unlimited",
    "ai.suggestions": true,
    "sharing.members": true,
    "sharing.teams": true,
    "members.invite": true,
    "teams.manage": true,
    "audit.log": true,
  }),
  upgradeAvailable: false,
});

const ACCOUNT_VALUES: AccountEntitlementValues = Object.freeze({ "workspaces.ownMax": "unlimited" });

/** The full, unlimited source of the Community Edition. */
export function createFullEntitlementSource(): EntitlementSource {
  return {
    available: true,
    forWorkspace: () => Promise.resolve(WORKSPACE_GRANT),
    forAccount: () => Promise.resolve(ACCOUNT_VALUES),
  };
}
