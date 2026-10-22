// @vitest-environment jsdom
import type { ComponentTypes } from "@slugbase/contracts";
import { act, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";

// The CE web entry: it builds the app with createWebApp, mounts it on #root, and
// the app asks /api/config before it renders, then checks the session, loads the account
// for its first page and the list of its workspaces for the switcher. The server side of the configuration
// answer (the product name from the build info) is checked with the built app in web-build.test.ts; here the answer is typed from the contract.

const config: ComponentTypes["schemas"]["ApiConfig"] = {
  apiVersion: "v1",
  origin: "https://bookmarks.example.com",
  product: { name: "Bookmarks Entry Test", version: "1.2.3" },
  locales: ["en", "de"],
  defaultLocale: "en",
  docsBaseUrl: "https://slugbase.app/docs",
  features: { mail: false, ai: false },
};

it("mounts the app on #root and shows the product name that /api/config answers with", { timeout: HEAVY_TEST_TIMEOUT_MS }, async () => {
  const requested: string[] = [];
  const me: ComponentTypes["schemas"]["Me"] = {
    account: {
      id: "0192f3a0-bbbb-7000-8000-000000000001",
      email: "ada@example.org",
      displayName: "Ada Lovelace",
      locale: "en",
      theme: "system",
      accent: null,
      defaultView: "grid",
      singleKeyShortcuts: true,
      signinAlerts: true,
      aiOptOut: false,
      analyticsConsent: "unset",
      onboarding: { browserSetupDone: false, importDone: false, checklistDismissed: false },
      emailVerified: true,
      hasPassword: true,
      mfaEnabled: false,
      isInstanceAdmin: false,
      pendingEmail: null,
    },
    memberships: [{ workspaceId: "0192f3a0-cccc-7000-8000-000000000001", name: "Home", role: "owner" }],
    activeWorkspaceId: "0192f3a0-cccc-7000-8000-000000000001",
  };
  const workspaces: ComponentTypes["schemas"]["WorkspaceList"] = {
    items: [{ id: "0192f3a0-cccc-7000-8000-000000000001", name: "Home", role: "owner", memberCount: 1 }],
    canCreate: false,
  };
  const entitlements: ComponentTypes["schemas"]["Entitlements"] = {
    entitlements: {
      "bookmarks.max": "unlimited",
      "seats.max": "unlimited",
      "workspaces.ownMax": "unlimited",
      "ai.suggestions": true,
      "sharing.members": true,
      "sharing.teams": true,
      "members.invite": true,
      "teams.manage": true,
      "audit.log": true,
    },
    usage: { "bookmarks.used": 0, "seats.used": 1, "workspaces.owned": 1 },
    upgradeAvailable: false,
  };
  vi.stubGlobal("fetch", (request: Request) => {
    const { pathname } = new URL(request.url);
    requested.push(pathname);
    if (pathname === "/api/v1/me") {
      return Promise.resolve(Response.json(me));
    }
    if (pathname === "/api/v1/entitlements") {
      return Promise.resolve(Response.json(entitlements));
    }
    return Promise.resolve(Response.json(pathname === "/api/v1/workspaces" ? workspaces : config));
  });
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);

  await act(async () => {
    await import("../src/web.tsx");
  });

  const heading = await screen.findByRole("heading", { name: "Welcome to Bookmarks Entry Test" });
  expect(heading.closest("#root")).not.toBeNull();
  expect(requested).toEqual(["/api/config", "/api/v1/me/sessions", "/api/v1/me", "/api/v1/workspaces", "/api/v1/entitlements"]);
});
