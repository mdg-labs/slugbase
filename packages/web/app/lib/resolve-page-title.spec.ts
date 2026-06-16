import { describe, expect, it } from "vitest";

import { resolveErrorPageTitleKey, resolvePageTitleKey } from "./resolve-page-title.js";

describe("resolvePageTitleKey", () => {
  it("maps main app routes to nav keys", () => {
    expect(resolvePageTitleKey("/", "")).toBe("app.shell.nav.home");
    expect(resolvePageTitleKey("/bookmarks", "")).toBe("app.shell.nav.bookmarks");
    expect(resolvePageTitleKey("/go", "")).toBe("go.forwarding.title");
    expect(resolvePageTitleKey("/go/docs", "")).toBe("app.page.go_disambiguation");
  });

  it("uses settings page_title for default settings routes", () => {
    expect(resolvePageTitleKey("/settings/account", "")).toBe("settings.account.page_title");
    expect(resolvePageTitleKey("/settings/billing", "")).toBe("settings.billing.page_title");
  });

  it("uses nav item label for settings section/tab query params", () => {
    expect(resolvePageTitleKey("/settings/account", "?section=mfa")).toBe("settings.nav.item.mfa");
    expect(resolvePageTitleKey("/settings/billing", "?tab=seats")).toBe("settings.nav.item.seats");
    expect(resolvePageTitleKey("/settings/workspace", "?section=smtp")).toBe("settings.nav.item.smtp");
  });
});

describe("resolveErrorPageTitleKey", () => {
  it("maps HTTP statuses to error title keys", () => {
    expect(resolveErrorPageTitleKey(404)).toBe("error.page.404.title");
    expect(resolveErrorPageTitleKey(500)).toBe("error.page.500.title");
  });
});
