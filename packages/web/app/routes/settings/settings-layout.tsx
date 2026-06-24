import { Link, Outlet, useLoaderData, useLocation } from "react-router";
import { useTranslation } from "react-i18next";

import { useAppShellData } from "../../lib/session-client.js";
import { loadWorkspaceInterfaceConfig } from "./workspace/workspace-config.js";
import { ALL_NAV_GROUPS, filterNavGroups } from "./settings-nav-config.js";
import type { NavItem } from "./settings-nav-config.js";

type SettingsLayoutData = {
  interfaceConfig: {
    billingEnabled: boolean;
  };
};

export async function loader(): Promise<SettingsLayoutData> {
  const interfaceConfig = await loadWorkspaceInterfaceConfig();
  return { interfaceConfig };
}

function itemHref(item: NavItem): string {
  if (item.section) return `${item.path}?section=${item.section}`;
  if (item.tab) return `${item.path}?tab=${item.tab}`;
  return item.path;
}

function isItemActive(item: NavItem, pathname: string, search: string): boolean {
  if (pathname !== item.path) return false;
  const params = new URLSearchParams(search);

  if (item.section) {
    return params.get("section") === item.section;
  }
  if (item.tab) {
    return params.get("tab") === item.tab;
  }
  if (item.path === "/settings/account") {
    const sec = params.get("section");
    return !sec || sec === "profile";
  }
  if (item.path === "/settings/workspace") {
    const sec = params.get("section");
    return !sec || sec === "general";
  }
  if (item.path === "/settings/billing") {
    const tab = params.get("tab");
    return !tab || tab === "plan";
  }
  return !params.get("section") && !params.get("tab");
}

export default function SettingsLayout() {
  const { t } = useTranslation();
  const { pathname, search } = useLocation();
  const { interfaceConfig } = useLoaderData<typeof loader>();
  const appShell = useAppShellData();
  const workspacePlan = appShell.workspace.plan;

  const navGroups = filterNavGroups(
    ALL_NAV_GROUPS,
    interfaceConfig,
    workspacePlan,
    appShell.currentUserRole,
  );

  return (
    <div className="flex min-h-0 flex-1" data-testid="settings-layout">
      <nav
        aria-label={t("settings.nav.aria_label")}
        className="w-[212px] shrink-0 overflow-y-auto border-r border-[color:var(--border-subtle)] py-sp-5"
      >
        {navGroups.map((group) => (
          <div key={group.labelKey} className="mb-sp-5">
            <div
              className="px-sp-4 pb-sp-2 font-medium uppercase tracking-wide text-fg-subtle"
              style={{ fontSize: "10px" }}
            >
              {t(group.labelKey)}
            </div>
            {group.items.map((item) => {
              const active = isItemActive(item, pathname, search);
              return (
                <Link
                  key={item.id}
                  to={itemHref(item)}
                  className={`flex items-center rounded-md px-sp-4 py-sp-2 transition-colors ${
                    active
                      ? "bg-raised font-medium text-fg"
                      : "text-fg-muted hover:bg-raised hover:text-fg"
                  }`}
                  style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
                  aria-current={active ? "page" : undefined}
                >
                  {t(item.labelKey)}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </div>
    </div>
  );
}
