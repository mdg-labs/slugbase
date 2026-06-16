import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { staticMessages } from "../i18n/messages.js";
import { ListPageMetaProvider } from "./list/ListPageMetaProvider.js";

vi.mock("react-router", () => ({
  useLocation: () => ({ pathname: "/bookmarks", search: "" }),
  useNavigate: () => vi.fn(),
  useFetcher: () => ({ submit: vi.fn() }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const messages = staticMessages.en as Record<string, string>;
      return messages[key] ?? key;
    },
  }),
}));

vi.mock("@slugbase/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@slugbase/ui")>();
  return {
    ...actual,
    ThemeSwitcher: () => <div data-testid="theme-switcher" />,
  };
});

import { AppTopBar } from "./AppTopBar.js";

const themeLabels = {
  group: "Theme",
  light: "Light",
  dark: "Dark",
  auto: "Auto",
};

function renderTopBar(overrides: Partial<Parameters<typeof AppTopBar>[0]> = {}) {
  const onOpenPalette = vi.fn();
  const onNewBookmark = vi.fn();

  render(
    <ListPageMetaProvider>
      <AppTopBar
        userName="Alex Kerr"
        userEmail="alex@example.com"
        onOpenPalette={onOpenPalette}
        onNewBookmark={onNewBookmark}
        themeLabels={themeLabels}
        {...overrides}
      />
    </ListPageMetaProvider>,
  );

  return { onOpenPalette, onNewBookmark };
}

describe("AppTopBar", () => {
  afterEach(() => {
    cleanup();
  });

  it("uses a three-region grid layout with a centered command trigger", () => {
    renderTopBar();

    const topBar = screen.getByTestId("app-top-bar");
    expect(topBar.className).toContain("grid-cols-[1fr_auto_1fr]");

    const trigger = screen.getByTestId("app-top-bar-cmd-trigger");
    expect(trigger.className).toContain("justify-self-center");
    expect(trigger.className).toContain("max-w-[420px]");

    expect(screen.getByTestId("app-top-bar-breadcrumbs")).toBeTruthy();
    expect(screen.getByTestId("app-top-bar-actions")).toBeTruthy();
    expect(screen.getByTestId("app-top-bar-actions").className).toContain(
      "justify-self-end",
    );
  });

  it("opens the command palette when the search trigger is clicked", () => {
    const { onOpenPalette } = renderTopBar();

    fireEvent.click(screen.getByTestId("app-top-bar-cmd-trigger"));

    expect(onOpenPalette).toHaveBeenCalledTimes(1);
  });

  it("shows the search placeholder and ⌘K hint on the trigger", () => {
    renderTopBar();

    expect(
      screen.getByText("Search bookmarks or run a command…"),
    ).toBeTruthy();
    expect(screen.getByText("⌘K")).toBeTruthy();
  });
});
