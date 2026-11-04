import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebApp } from "../src/index.ts";
import { renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";
import { stubWorkspaceSettingsServer } from "./workspace-settings-server.ts";

// The settings navigation (doc 03 section 11). The failure it guards against is a link that stays highlighted on the
// pages below it, so that two entries look selected at once.

const SLOW_TEST_TIMEOUT_MS = 30_000;

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia(false);
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("lang");
});

describe("the current entry of the settings navigation", () => {
  it.each<[string, string]>([
    ["/settings/account", "Profile"],
    ["/settings/account/preferences", "Preferences"],
    ["/settings/account/security", "Security"],
    ["/settings/account/tokens", "API tokens"],
    ["/settings/account/data", "Import & export"],
    ["/settings/workspace", "General"],
    ["/settings/workspace/members", "Members"],
    ["/settings/workspace/teams", "Teams"],
    ["/settings/workspace/ai", "AI suggestions"],
  ])("is the entry of %s alone: %s", async (path, name) => {
    stubWorkspaceSettingsServer();
    window.history.replaceState(null, "", path);
    const App = createWebApp({ extensions: [] });
    await renderApp(<App />);

    const nav = await screen.findByRole("navigation", { name: "Settings" });
    await within(nav).findByRole("list", { name: "Workspace" });

    const current = within(nav)
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page")
      .map((link) => link.textContent);
    expect(current).toEqual([name]);
  }, SLOW_TEST_TIMEOUT_MS);
});
