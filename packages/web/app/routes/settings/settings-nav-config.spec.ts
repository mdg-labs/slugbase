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
  const selfHostedAdminUiConfig = {
    mailAdminUi: true,
    oidcAdminUi: true,
    billingEnabled: false,
  };

  const hostedConfig = {
    mailAdminUi: false,
    oidcAdminUi: false,
    billingEnabled: true,
  };

  const ceOperatorConfig = {
    mailAdminUi: false,
    oidcAdminUi: false,
    billingEnabled: false,
  };

  it("self-hosted with admin UI: shows all nav groups except billing", () => {
    const groups = filterNavGroups(ALL_NAV_GROUPS, selfHostedAdminUiConfig, "free");
    expect(groupLabelKeys(groups)).toEqual([
      "settings.nav.group.account",
      "settings.nav.group.workspace",
      "settings.nav.group.administration",
    ]);
    expect(itemIds(groups, "settings.nav.group.workspace")).toEqual([
      "general",
      "smtp",
      "ai",
      "oidc",
    ]);
  });

  it("self-hosted: members nav is always visible regardless of plan", () => {
    const groups = filterNavGroups(ALL_NAV_GROUPS, selfHostedAdminUiConfig, "free");
    expect(itemIds(groups, "settings.nav.group.administration")).toContain("members");
  });

  it("hosted Cloud: hides SMTP and OIDC nav items when operator-managed", () => {
    const groups = filterNavGroups(ALL_NAV_GROUPS, hostedConfig, "free");
    expect(itemIds(groups, "settings.nav.group.workspace")).toEqual(["general", "ai"]);
  });

  it("CE operator-managed: shows gate-only SMTP and OIDC nav items", () => {
    const groups = filterNavGroups(ALL_NAV_GROUPS, ceOperatorConfig, "free");
    expect(itemIds(groups, "settings.nav.group.workspace")).toEqual([
      "general",
      "smtp",
      "ai",
      "oidc",
    ]);
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

  it("CE operator-managed: billing hidden, members always visible", () => {
    const groups = filterNavGroups(ALL_NAV_GROUPS, ceOperatorConfig, "free");
    expect(groupLabelKeys(groups)).toEqual([
      "settings.nav.group.account",
      "settings.nav.group.workspace",
      "settings.nav.group.administration",
    ]);
    expect(itemIds(groups, "settings.nav.group.administration")).toContain("members");
  });
});
