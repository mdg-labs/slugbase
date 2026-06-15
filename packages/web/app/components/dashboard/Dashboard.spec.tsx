import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppToastProvider } from "../feedback/AppToastProvider.js";
import { staticMessages } from "../../i18n/messages.js";
import { CommandPalette } from "../command-palette/CommandPalette.js";
import { CommandPaletteProvider, useCommandPalette } from "../command-palette/CommandPaletteProvider.js";
import { DashboardPage } from "./DashboardPage.js";
import { FREE_BOOKMARK_CAP } from "./dashboard.constants.js";
import type { DashboardData } from "./dashboard.types.js";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const messages = staticMessages.en as Record<string, string>;
      const template = messages[key] ?? key;
      if (!params) {
        return template;
      }
      return Object.entries(params).reduce(
        (value, [name, replacement]) =>
          value.replaceAll(`{${name}}`, String(replacement)),
        template,
      );
    },
  }),
}));

const mockDashboardData: DashboardData = {
  workspace: { id: "ws-1", name: "Personal workspace", plan: "free" },
  counts: {
    bookmarks: FREE_BOOKMARK_CAP,
    folders: 4,
    tags: 6,
    sharedWithMe: 2,
    sharedByMe: 1,
  },
  quickAccess: [
    {
      id: "bm-1",
      title: "React docs",
      url: "https://react.dev",
      slug: "react",
      forwardingEnabled: true,
      pinned: false,
      accessCount: 42,
      lastAccessedAt: "2026-05-30T10:00:00.000Z",
    },
  ],
  pinned: [
    {
      id: "bm-2",
      title: "Pinned guide",
      url: "https://example.com/guide",
      slug: "guide",
      forwardingEnabled: true,
      pinned: true,
      accessCount: 3,
      lastAccessedAt: "2026-05-29T08:00:00.000Z",
    },
  ],
  recent: [
    {
      id: "bm-3",
      title: "Recent article",
      url: "https://example.com/article",
      slug: null,
      forwardingEnabled: false,
      pinned: false,
      accessCount: 1,
      lastAccessedAt: "2026-05-31T09:00:00.000Z",
    },
  ],
  folders: [
    {
      id: "folder-1",
      name: "Engineering",
      icon: null,
      bookmarkCount: 12,
    },
  ],
  tags: [
    {
      id: "tag-1",
      name: "docs",
      color: null,
      bookmarkCount: 8,
    },
  ],
};

const useLoaderDataMock = vi.fn(() => mockDashboardData);
const mockNavigate = vi.fn();
const mockLoad = vi.fn();

vi.mock("react-router", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-router")>();
  return {
    ...original,
    useLoaderData: () => useLoaderDataMock(),
    useNavigate: () => mockNavigate,
    useFetcher: () => ({
      state: "idle" as const,
      data: undefined,
      load: mockLoad,
    }),
    Link: ({
      children,
      to,
      ...props
    }: {
      children: ReactNode;
      to: string;
    }) => (
      <a href={to} {...props}>
        {children}
      </a>
    ),
  };
});

function DashboardHarness() {
  const { open, setOpen } = useCommandPalette();
  return (
    <>
      <DashboardPage />
      <CommandPalette open={open} onOpenChange={setOpen} />
    </>
  );
}

function renderDashboard() {
  return render(
    <AppToastProvider>
      <CommandPaletteProvider>
        <DashboardHarness />
      </CommandPaletteProvider>
    </AppToastProvider>,
  );
}

describe("DashboardPage", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    useLoaderDataMock.mockReturnValue(mockDashboardData);
  });

  it("renders dashboard sections from loader data", () => {
    const view = renderDashboard();

    expect(view.getByTestId("dashboard-page")).toBeTruthy();
    expect(view.getByTestId("dashboard-stats-row")).toBeTruthy();
    expect(view.getByTestId("dashboard-search-entry")).toBeTruthy();
    expect(view.getByTestId("dashboard-quick-access")).toBeTruthy();
    expect(view.getByTestId("dashboard-pinned")).toBeTruthy();
    expect(view.getByTestId("dashboard-recent")).toBeTruthy();
    expect(view.getByTestId("dashboard-folders-overview")).toBeTruthy();
    expect(view.getByTestId("dashboard-tags-overview")).toBeTruthy();
    expect(view.getByTestId("dashboard-sharing-stats")).toBeTruthy();
    expect(view.getByTestId("dashboard-onboarding-checklist")).toBeTruthy();
    expect(view.getByText("React docs")).toBeTruthy();
    expect(view.getByText("Pinned guide")).toBeTruthy();
    expect(view.getByText("Recent article")).toBeTruthy();
  });

  it("shows entitlement banner for Free workspaces at cap", () => {
    const view = renderDashboard();
    const banner = view.getByTestId("dashboard-entitlement-banner");

    expect(banner.getAttribute("data-variant")).toBe("at-cap");
    expect(view.getByText("Bookmark limit reached")).toBeTruthy();
  });

  it("opens the command palette from the search entry", () => {
    const view = renderDashboard();

    fireEvent.click(view.getByTestId("dashboard-search-entry"));

    expect(view.getByTestId("command-palette-dialog")).toBeTruthy();
  });
});

describe("DashboardPage without entitlement banner", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("hides upgrade banner for Personal workspaces", () => {
    const personalData: DashboardData = {
      ...mockDashboardData,
      workspace: { ...mockDashboardData.workspace, plan: "personal" },
      counts: { ...mockDashboardData.counts, bookmarks: 120 },
    };

    vi.mocked(useLoaderDataMock).mockReturnValue(personalData);

    const view = renderDashboard();

    expect(view.queryByTestId("dashboard-entitlement-banner")).toBeNull();
  });
});
