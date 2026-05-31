import { z } from "zod";

import { WorkspacePlanSchema } from "./workspace.contract.js";

/**
 * Capability flags checked by the entitlements engine (spec §12.2).
 * Application logic checks entitlements, never billing provider state directly.
 */
export const EntitlementCapabilitySchema = z.enum([
  "unlimited-bookmarks",
  "ai-suggestions",
  "multiple-workspaces",
  "custom-slug-rules",
  "team-sharing",
  "team-admin",
  "workspace-members",
  "audit-log",
]);

export type EntitlementCapability = z.infer<typeof EntitlementCapabilitySchema>;

/** Internal entitlement set derived from a workspace plan (spec §12.2). */
export interface EntitlementSet {
  capabilities: ReadonlySet<EntitlementCapability>;
  /** Active bookmark cap; null means unlimited. */
  bookmarkCap: number | null;
  /** Max workspaces an account may own; null means unlimited. */
  workspacesPerAccount: number | null;
}

export type PlanId = z.infer<typeof WorkspacePlanSchema>;

/** Hosted plan catalog entry — display metadata + entitlement mapping (spec §12.1). */
export interface PlanDefinition {
  id: PlanId;
  /** User-facing plan name — paid individual tier is "Personal", never "Pro" (§23.4). */
  displayName: string;
  entitlements: EntitlementSet;
}
