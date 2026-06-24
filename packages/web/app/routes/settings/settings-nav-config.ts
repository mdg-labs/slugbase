import { canManageBilling } from "./billing/billing-entitlements.js";
import { canManageWorkspaceSettings } from "./workspace/workspace-entitlements.js";
import type { WorkspaceMemberRole } from "./workspace/workspace.types.js";

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
      { id: "ai", labelKey: "settings.nav.item.ai", path: "/settings/workspace", section: "ai" },
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
  currentUserRole: WorkspaceMemberRole,
): NavGroup[] {
  const isWorkspaceAdmin = canManageWorkspaceSettings(currentUserRole);
  const canSeeBilling = canManageBilling(currentUserRole);

  return groups
    .map((group) => {
      if (group.labelKey === "settings.nav.group.account") {
        return group;
      }
      if (group.labelKey === "settings.nav.group.workspace" && !isWorkspaceAdmin) {
        return null;
      }
      if (group.labelKey === "settings.nav.group.administration" && !isWorkspaceAdmin) {
        return null;
      }
      if (group.labelKey === "settings.nav.group.billing") {
        if (!interfaceConfig.billingEnabled || !canSeeBilling) {
          return null;
        }
      }
      const filteredItems = group.items.filter((item) =>
        isNavItemVisible(item, interfaceConfig, workspacePlan),
      );
      if (filteredItems.length === 0) return null;
      return { ...group, items: filteredItems };
    })
    .filter((group): group is NavGroup => group !== null);
}
