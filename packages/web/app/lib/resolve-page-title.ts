import type { MessageKey } from "../i18n/messages.js";
import { ALL_NAV_GROUPS } from "../routes/settings/settings-nav-config.js";

const SETTINGS_ROUTE_PAGE_KEYS: Record<string, MessageKey> = {
  "/settings/account": "settings.account.page_title",
  "/settings/workspace": "settings.workspace.page_title",
  "/settings/billing": "settings.billing.page_title",
  "/settings/members": "settings.members.page_title",
  "/settings/audit": "settings.audit.page_title",
};

/**
 * Resolve the i18n key for the current page label used in `formatDocumentTitle`.
 *
 * Settings granularity: when `?section=` or `?tab=` matches a nav item, use that
 * item's `labelKey` (e.g. "Two-factor auth" for `?section=mfa`). Otherwise use
 * the route's `settings.*.page_title` key (e.g. "Account").
 */
export function resolvePageTitleKey(pathname: string, search: string): MessageKey {
  if (pathname === "/") return "app.shell.nav.home";
  if (pathname === "/bookmarks") return "app.shell.nav.bookmarks";
  if (pathname === "/folders") return "app.shell.nav.folders";
  if (pathname === "/tags") return "app.shell.nav.tags";
  if (pathname === "/go") return "go.forwarding.title";

  if (pathname.startsWith("/go/")) return "app.page.go_disambiguation";

  if (pathname.startsWith("/settings")) {
    return resolveSettingsPageTitleKey(pathname, search);
  }

  return "app.page.not_found";
}

function resolveSettingsPageTitleKey(pathname: string, search: string): MessageKey {
  const params = new URLSearchParams(search);
  const section = params.get("section");
  const tab = params.get("tab");

  for (const group of ALL_NAV_GROUPS) {
    for (const item of group.items) {
      if (item.path !== pathname) continue;
      if (section && item.section === section) {
        return item.labelKey as MessageKey;
      }
      if (tab && item.tab === tab) {
        return item.labelKey as MessageKey;
      }
    }
  }

  const routeKey = SETTINGS_ROUTE_PAGE_KEYS[pathname];
  if (routeKey) return routeKey;

  return "app.shell.nav.settings";
}

const ERROR_STATUS_TITLE_KEYS: Record<number, MessageKey> = {
  401: "error.page.401.title",
  403: "error.page.403.title",
  404: "error.page.404.title",
  500: "error.page.500.title",
  503: "error.page.503.title",
};

export function resolveErrorPageTitleKey(status: number): MessageKey {
  return ERROR_STATUS_TITLE_KEYS[status] ?? "error.page.500.title";
}
