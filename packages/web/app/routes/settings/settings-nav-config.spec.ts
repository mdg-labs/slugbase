import { describe, expect, it } from "vitest";

import { ALL_NAV_GROUPS, filterNavGroups } from "./settings-nav-config.js";

function groupLabelKeys(groups: ReturnType<typeof filterNavGroups>): string[] {
  return groups.map((g) => g.labelKey);
}

function itemIds(groups: ReturnType<typeof filterNavGroups>, groupLabel: string): string[] {
  return groups
    .find((g) => g.labelKey === groupLabel)
    ?.items.map((i) => i.id) ?? [];
}

describe("settings-nav-config", () => {
  const selfHostedConfig = {
    billingEnabled: false,
  };

  const hostedConfig = {
    billingEnabled: true,
  };

  it("self-hosted: shows workspace nav with general and ai only for admins", () => {
    const groups = filterNavGroups(ALL_NAV_GROUPS, selfHostedConfig, "free", "ADMIN");
    expect(groupLabelKeys(groups)).toEqual([
      "settings.nav.group.account",
      "settings.nav.group.workspace",
      "settings.nav.group.administration",
    ]);
    expect(itemIds(groups, "settings.nav.group.workspace")).toEqual(["general", "ai"]);
  });

  it("self-hosted: members nav is always visible for admins regardless of plan", () => {
    const groups = filterNavGroups(ALL_NAV_GROUPS, selfHostedConfig, "free", "ADMIN");
    expect(itemIds(groups, "settings.nav.group.administration")).toContain("members");
  });

  it("hosted Cloud: workspace nav has general and ai only for admins", () => {
    const groups = filterNavGroups(ALL_NAV_GROUPS, hostedConfig, "free", "OWNER");
    expect(itemIds(groups, "settings.nav.group.workspace")).toEqual(["general", "ai"]);
  });

  it("CE: workspace nav never shows SMTP or OIDC items", () => {
    const groups = filterNavGroups(ALL_NAV_GROUPS, selfHostedConfig, "free", "ADMIN");
    const workspaceItems = itemIds(groups, "settings.nav.group.workspace");
    expect(workspaceItems).not.toContain("smtp");
    expect(workspaceItems).not.toContain("oidc");
  });

  it("hosted: shows entire billing group when billing is enabled for owners", () => {
    const groups = filterNavGroups(ALL_NAV_GROUPS, hostedConfig, "free", "OWNER");
    expect(groupLabelKeys(groups)).toContain("settings.nav.group.billing");
    expect(itemIds(groups, "settings.nav.group.billing")).toEqual([
      "billing-plan",
      "billing-seats",
      "billing-history",
    ]);
  });

  it("hosted: hides Members nav on non-Team plans for admins", () => {
    const groups = filterNavGroups(ALL_NAV_GROUPS, hostedConfig, "free", "ADMIN");
    expect(itemIds(groups, "settings.nav.group.administration")).not.toContain("members");
  });

  it("hosted: shows Members nav on Team plan for admins", () => {
    const groups = filterNavGroups(ALL_NAV_GROUPS, hostedConfig, "team", "ADMIN");
    expect(itemIds(groups, "settings.nav.group.administration")).toContain("members");
  });

  it("hosted Team: shows audit alongside members for admins", () => {
    const groups = filterNavGroups(ALL_NAV_GROUPS, hostedConfig, "team", "OWNER");
    expect(itemIds(groups, "settings.nav.group.administration")).toEqual(["members", "audit"]);
  });

  it("CE: billing hidden, members always visible for admins", () => {
    const groups = filterNavGroups(ALL_NAV_GROUPS, selfHostedConfig, "free", "OWNER");
    expect(groupLabelKeys(groups)).toEqual([
      "settings.nav.group.account",
      "settings.nav.group.workspace",
      "settings.nav.group.administration",
    ]);
    expect(itemIds(groups, "settings.nav.group.administration")).toContain("members");
  });

  it("MEMBER: only account group is visible", () => {
    const groups = filterNavGroups(ALL_NAV_GROUPS, hostedConfig, "team", "MEMBER");
    expect(groupLabelKeys(groups)).toEqual(["settings.nav.group.account"]);
  });

  it("MEMBER on CE: only account group is visible", () => {
    const groups = filterNavGroups(ALL_NAV_GROUPS, selfHostedConfig, "free", "MEMBER");
    expect(groupLabelKeys(groups)).toEqual(["settings.nav.group.account"]);
  });

  it("ADMIN on hosted: billing group hidden", () => {
    const groups = filterNavGroups(ALL_NAV_GROUPS, hostedConfig, "team", "ADMIN");
    expect(groupLabelKeys(groups)).not.toContain("settings.nav.group.billing");
  });
});
