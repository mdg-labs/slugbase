import { useTranslation } from "react-i18next";
import { Link, Outlet, useLocation } from "react-router";

type NavItem = {
  id: string;
  labelKey: string;
  path: string;
  section?: string;
  tab?: string;
};

type NavGroup = {
  labelKey: string;
  items: NavItem[];
};

const NAV_GROUPS: NavGroup[] = [
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

  return (
    <div className="flex min-h-0 flex-1" data-testid="settings-layout">
      <nav
        aria-label={t("settings.nav.aria_label")}
        className="w-[212px] shrink-0 overflow-y-auto border-r border-[color:var(--border-subtle)] py-sp-5"
      >
        {NAV_GROUPS.map((group) => (
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
