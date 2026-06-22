export type NavItem = {
  id: string;
  labelKey: string;
  path: string;
  section?: string;
  tab?: string;
};

export type NavGroup = {
  labelKey: string;
  items: NavItem[];
};

export type SettingsInterfaceConfig = {
  mailAdminUi: boolean;
  oidcAdminUi: boolean;
  billingEnabled: boolean;
};

export const ALL_NAV_GROUPS: NavGroup[] = [
  {
    labelKey: "settings.nav.group.account",
    items: [
      { id: "profile", labelKey: "settings.nav.item.profile", path: "/settings/account" },
      { id: "password", labelKey: "settings.nav.item.password", path: "/settings/account", section: "password" },
      { id: "mfa", labelKey: "settings.nav.item.mfa", path: "/settings/account", section: "mfa" },
      { id: "tokens", labelKey: "settings.nav.item.tokens", path: "/settings/account", section: "tokens" },
      { id: "preferences", labelKey: "settings.nav.item.preferences", path: "/settings/account", section: "preferences" },
    ],
  },
  {
    labelKey: "settings.nav.group.workspace",
    items: [
      { id: "general", labelKey: "settings.nav.item.general", path: "/settings/workspace" },
      { id: "smtp", labelKey: "settings.nav.item.smtp", path: "/settings/workspace", section: "smtp" },
      { id: "ai", labelKey: "settings.nav.item.ai", path: "/settings/workspace", section: "ai" },
      { id: "oidc", labelKey: "settings.nav.item.oidc", path: "/settings/workspace", section: "oidc" },
    ],
  },
  {
    labelKey: "settings.nav.group.billing",
    items: [
      { id: "billing-plan", labelKey: "settings.nav.item.plan", path: "/settings/billing" },
      { id: "billing-seats", labelKey: "settings.nav.item.seats", path: "/settings/billing", tab: "seats" },
      { id: "billing-history", labelKey: "settings.nav.item.billing_history", path: "/settings/billing", tab: "history" },
    ],
  },
  {
    labelKey: "settings.nav.group.administration",
    items: [
      { id: "members", labelKey: "settings.nav.item.members", path: "/settings/members" },
      { id: "audit", labelKey: "settings.nav.item.audit", path: "/settings/audit" },
    ],
  },
];

export function isNavItemVisible(
  item: NavItem,
  interfaceConfig: SettingsInterfaceConfig,
  workspacePlan: string,
): boolean {
  // Self-hosted CE: gate-only SMTP/OIDC nav when operator-managed; hosted Cloud hides them.
  if (item.id === "smtp") {
    return interfaceConfig.mailAdminUi || !interfaceConfig.billingEnabled;
  }
  if (item.id === "oidc") {
    return interfaceConfig.oidcAdminUi || !interfaceConfig.billingEnabled;
  }
  // Members are plan-gated only on hosted (spec §12.4): hide when billing
  // is enabled and the workspace plan is not Team. On self-hosted
  // (billingEnabled === false), members are always accessible.
  if (item.id === "members" && interfaceConfig.billingEnabled) {
    return workspacePlan === "team";
  }
  return true;
}

export function filterNavGroups(
  groups: NavGroup[],
  interfaceConfig: SettingsInterfaceConfig,
  workspacePlan: string,
): NavGroup[] {
  return groups
    .map((group) => {
      // Entire billing group is hidden when billing is disabled (self-hosted)
      if (group.labelKey === "settings.nav.group.billing" && !interfaceConfig.billingEnabled) {
        return null;
      }
      const filteredItems = group.items.filter((item) =>
        isNavItemVisible(item, interfaceConfig, workspacePlan),
      );
      if (filteredItems.length === 0) return null;
      return { ...group, items: filteredItems };
    })
    .filter((group): group is NavGroup => group !== null);
}
