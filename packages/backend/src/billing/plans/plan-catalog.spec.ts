import { describe, expect, it } from "vitest";

import type { EntitlementCapability, PlanId } from "@slugbase/shared-types";

import {
  FREE_BOOKMARK_CAP,
  FREE_ENTITLEMENTS,
  FREE_WORKSPACES_PER_ACCOUNT,
  PERSONAL_ENTITLEMENTS,
  TEAM_ENTITLEMENTS,
} from "./entitlement-sets.js";
import { PLAN_CATALOG, getPlanDefinition, listPlanDefinitions } from "./plan-catalog.js";
import {
  resolveEntitlementsForPlan,
  resolveEntitlementsFromBillingState,
} from "./resolve-plan-entitlements.js";

const personalCapabilities: EntitlementCapability[] = [
  "unlimited-bookmarks",
  "ai-suggestions",
  "multiple-workspaces",
  "custom-slug-rules",
];

const teamOnlyCapabilities: EntitlementCapability[] = [
  "team-sharing",
  "team-admin",
  "workspace-members",
  "audit-log",
];

const teamCapabilities: EntitlementCapability[] = [
  ...personalCapabilities,
  ...teamOnlyCapabilities,
];

describe("plan catalog", () => {
  it("defines Free, Personal, and Team plans", () => {
    expect(listPlanDefinitions()).toHaveLength(3);
    expect(Object.keys(PLAN_CATALOG).sort()).toEqual(["free", "personal", "team"]);
  });

  it('names the paid individual tier "Personal" (never Pro)', () => {
    expect(getPlanDefinition("personal").displayName).toBe("Personal");
    expect(getPlanDefinition("personal").displayName).not.toBe("Pro");
  });

  describe.each<PlanId>(["free", "personal", "team"])("plan %s", (planId) => {
    it("maps to a stable entitlement set via resolveEntitlementsForPlan", () => {
      expect(resolveEntitlementsForPlan(planId)).toBe(PLAN_CATALOG[planId].entitlements);
    });
  });

  describe("free entitlements", () => {
    it("caps bookmarks at 50 and limits workspaces per account to 1", () => {
      expect(FREE_ENTITLEMENTS.bookmarkCap).toBe(FREE_BOOKMARK_CAP);
      expect(FREE_BOOKMARK_CAP).toBe(50);
      expect(FREE_ENTITLEMENTS.workspacesPerAccount).toBe(FREE_WORKSPACES_PER_ACCOUNT);
      expect(FREE_ENTITLEMENTS.capabilities.size).toBe(0);
    });

    it.each(teamCapabilities)("denies capability %s", (capability) => {
      expect(FREE_ENTITLEMENTS.capabilities.has(capability)).toBe(false);
    });
  });

  describe("personal entitlements", () => {
    it.each(personalCapabilities)("grants capability %s", (capability) => {
      expect(PERSONAL_ENTITLEMENTS.capabilities.has(capability)).toBe(true);
    });

    it.each(teamOnlyCapabilities)("denies team-only capability %s", (capability) => {
      expect(PERSONAL_ENTITLEMENTS.capabilities.has(capability)).toBe(false);
    });

    it("has unlimited bookmarks and workspaces", () => {
      expect(PERSONAL_ENTITLEMENTS.bookmarkCap).toBeNull();
      expect(PERSONAL_ENTITLEMENTS.workspacesPerAccount).toBeNull();
    });
  });

  describe("team entitlements", () => {
    it.each(teamCapabilities)("grants capability %s", (capability) => {
      expect(TEAM_ENTITLEMENTS.capabilities.has(capability)).toBe(true);
    });

    it("has unlimited bookmarks and workspaces", () => {
      expect(TEAM_ENTITLEMENTS.bookmarkCap).toBeNull();
      expect(TEAM_ENTITLEMENTS.workspacesPerAccount).toBeNull();
    });
  });

  describe("supporter = Personal permanent (spec §12.1)", () => {
    it("uses the Personal entitlement set when permanentPersonal is true", () => {
      const supporter = resolveEntitlementsFromBillingState({
        plan: "personal",
        permanentPersonal: true,
      });
      expect(supporter).toBe(PERSONAL_ENTITLEMENTS);
    });

    it("matches personal entitlements capability-for-capability", () => {
      const supporter = resolveEntitlementsFromBillingState({
        plan: "personal",
        permanentPersonal: true,
      });
      expect([...supporter.capabilities].sort()).toEqual([...PERSONAL_ENTITLEMENTS.capabilities].sort());
    });

    it("does not introduce a separate supporter plan id", () => {
      expect(Object.keys(PLAN_CATALOG)).not.toContain("supporter");
    });
  });
});
