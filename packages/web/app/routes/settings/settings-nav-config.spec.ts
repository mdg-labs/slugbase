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

  it("self-hosted: shows workspace nav with general and ai only", () => {
    const groups = filterNavGroups(ALL_NAV_GROUPS, selfHostedConfig, "free");
    expect(groupLabelKeys(groups)).toEqual([
      "settings.nav.group.account",
      "settings.nav.group.workspace",
      "settings.nav.group.administration",
    ]);
    expect(itemIds(groups, "settings.nav.group.workspace")).toEqual(["general", "ai"]);
  });

  it("self-hosted: members nav is always visible regardless of plan", () => {
    const groups = filterNavGroups(ALL_NAV_GROUPS, selfHostedConfig, "free");
    expect(itemIds(groups, "settings.nav.group.administration")).toContain("members");
  });

  it("hosted Cloud: workspace nav has general and ai only", () => {
    const groups = filterNavGroups(ALL_NAV_GROUPS, hostedConfig, "free");
    expect(itemIds(groups, "settings.nav.group.workspace")).toEqual(["general", "ai"]);
  });

  it("CE: workspace nav never shows SMTP or OIDC items", () => {
    const groups = filterNavGroups(ALL_NAV_GROUPS, selfHostedConfig, "free");
    const workspaceItems = itemIds(groups, "settings.nav.group.workspace");
    expect(workspaceItems).not.toContain("smtp");
    expect(workspaceItems).not.toContain("oidc");
  });

  it("hosted: shows entire billing group when billing is enabled", () => {
    const groups = filterNavGroups(ALL_NAV_GROUPS, hostedConfig, "free");
    expect(groupLabelKeys(groups)).toContain("settings.nav.group.billing");
    expect(itemIds(groups, "settings.nav.group.billing")).toEqual([
      "billing-plan",
      "billing-seats",
      "billing-history",
    ]);
  });

  it("hosted: hides Members nav on non-Team plans", () => {
    const groups = filterNavGroups(ALL_NAV_GROUPS, hostedConfig, "free");
    expect(itemIds(groups, "settings.nav.group.administration")).not.toContain("members");
  });

  it("hosted: shows Members nav on Team plan", () => {
    const groups = filterNavGroups(ALL_NAV_GROUPS, hostedConfig, "team");
    expect(itemIds(groups, "settings.nav.group.administration")).toContain("members");
  });

  it("hosted Team: shows audit alongside members", () => {
    const groups = filterNavGroups(ALL_NAV_GROUPS, hostedConfig, "team");
    expect(itemIds(groups, "settings.nav.group.administration")).toEqual(["members", "audit"]);
  });

  it("CE: billing hidden, members always visible", () => {
    const groups = filterNavGroups(ALL_NAV_GROUPS, selfHostedConfig, "free");
    expect(groupLabelKeys(groups)).toEqual([
      "settings.nav.group.account",
      "settings.nav.group.workspace",
      "settings.nav.group.administration",
    ]);
    expect(itemIds(groups, "settings.nav.group.administration")).toContain("members");
  });
});
