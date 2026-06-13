import type { EntitlementCapability, EntitlementSet } from "@slugbase/shared-types";

const PERSONAL_CAPABILITIES: EntitlementCapability[] = [
  "unlimited-bookmarks",
  "ai-suggestions",
  "multiple-workspaces",
  "custom-slug-rules",
];

const TEAM_CAPABILITIES: EntitlementCapability[] = [
  ...PERSONAL_CAPABILITIES,
  "team-sharing",
  "team-admin",
  "workspace-members",
  "audit-log",
];

/** Free workspace bookmark cap (spec §23.4, def §2). */
export const FREE_BOOKMARK_CAP = 50;

/** Minimum Team seats at checkout and while subscribed (spec §12.2, def §5). */
export const TEAM_MIN_SEATS = 2;

/** Free accounts may own exactly one workspace on hosted (spec §12.2, def §5). */
export const FREE_WORKSPACES_PER_ACCOUNT = 1;

export const FREE_ENTITLEMENTS: EntitlementSet = {
  capabilities: new Set<EntitlementCapability>(),
  bookmarkCap: FREE_BOOKMARK_CAP,
  workspacesPerAccount: FREE_WORKSPACES_PER_ACCOUNT,
};

export const PERSONAL_ENTITLEMENTS: EntitlementSet = {
  capabilities: new Set(PERSONAL_CAPABILITIES),
  bookmarkCap: null,
  workspacesPerAccount: null,
};

export const TEAM_ENTITLEMENTS: EntitlementSet = {
  capabilities: new Set(TEAM_CAPABILITIES),
  bookmarkCap: null,
  workspacesPerAccount: null,
};

/** Capabilities that require Team plan on hosted. */
export const TEAM_ONLY_CAPABILITIES = new Set<EntitlementCapability>([
  "team-sharing",
  "team-admin",
  "workspace-members",
  "audit-log",
]);
