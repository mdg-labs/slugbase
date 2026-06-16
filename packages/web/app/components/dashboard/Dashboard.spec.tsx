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
import { PRIVATE_BOOKMARK_SHARING_SUMMARY } from "../../routes/bookmarks/bookmarks-loader.js";
import type { BookmarkSharingSummary } from "../sharing/sharing-recipients.utils.js";

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
      userId: "user-1",
      title: "React docs",
      url: "https://react.dev",
      slug: "react",
      forwardingEnabled: true,
      pinned: false,
      accessCount: 42,
      lastAccessedAt: "2026-05-30T10:00:00.000Z",
      createdAt: "2026-05-01T10:00:00.000Z",
      sharingSummary: PRIVATE_BOOKMARK_SHARING_SUMMARY,
      folders: [],
      tags: [],
    },
  ],
  pinned: [
    {
      id: "bm-2",
      userId: "user-1",
      title: "Pinned guide",
      url: "https://example.com/guide",
      slug: "guide",
      forwardingEnabled: true,
      pinned: true,
      accessCount: 3,
      lastAccessedAt: "2026-05-29T08:00:00.000Z",
      createdAt: "2026-05-02T08:00:00.000Z",
      sharingSummary: PRIVATE_BOOKMARK_SHARING_SUMMARY,
      folders: [],
      tags: [],
    },
  ],
  recent: [
    {
      id: "bm-3",
      userId: "user-1",
      title: "Recent article",
      url: "https://example.com/article",
      slug: null,
      forwardingEnabled: false,
      pinned: false,
      accessCount: 1,
      lastAccessedAt: "2026-05-31T09:00:00.000Z",
      createdAt: "2026-05-03T09:00:00.000Z",
      sharingSummary: PRIVATE_BOOKMARK_SHARING_SUMMARY,
      folders: [],
      tags: [],
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

vi.mock("../../lib/session-client.js", () => ({
  useAppShellData: () => ({
    user: {
      id: "user-1",
      email: "alex@example.com",
      name: "Alex",
      language: "en" as const,
      mfaState: "not_enrolled" as const,
      emailVerified: true,
      onboardingCompletedAt: Date.now(),
      dashboardChecklistDismissed: false,
      dashboardChecklistManual: {
        import: false,
        browser_shortcut: false,
        folder: false,
        tag: false,
      },
    },
    workspace: { id: "ws-1", name: "Personal workspace", plan: "free" as const },
    workspaces: [],
    sidebarFolders: [],
    bookmarkTotal: 0,
  }),
}));

vi.mock("../bookmark-modal/BookmarkModalProvider.js", () => ({
  useBookmarkModal: () => ({
    openEdit: vi.fn(),
    openCreate: vi.fn(),
    open: vi.fn(),
  }),
}));

vi.mock("../../routes/bookmarks/bookmarks-api.js", () => ({
  toggleBookmarkPin: vi.fn(),
  deleteBookmark: vi.fn(),
}));

vi.mock("../../routes/bookmarks/BookmarkFavicon.js", () => ({
  BookmarkFavicon: ({ size }: { size: number }) => (
    <span data-testid="bookmark-favicon" data-size={size} />
  ),
}));

const useLoaderDataMock = vi.fn(() => mockDashboardData);
const mockNavigate = vi.fn();
const mockLoad = vi.fn();

vi.mock("react-router", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-router")>();
  return {
    ...original,
  useLoaderData: () => useLoaderDataMock(),
  useNavigate: () => mockNavigate,
  useRevalidator: () => ({ revalidate: vi.fn() }),
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

  it("shows sharing badge on dashboard bookmark cards from loader data", () => {
    const sharingSummary: BookmarkSharingSummary = {
      scope: "shared-by-me",
      directRecipients: [{ kind: "user", targetId: "u2", targetName: "Alice" }],
      viaFolders: [],
    };

    const pinnedItem = mockDashboardData.pinned.at(0);
    if (!pinnedItem) {
      throw new Error("Expected pinned bookmark fixture");
    }

    useLoaderDataMock.mockReturnValue({
      ...mockDashboardData,
      pinned: [
        {
          ...pinnedItem,
          sharingSummary,
        },
      ],
    });

    const view = renderDashboard();

    expect(
      view.getByTestId("dashboard-pinned").querySelector(
        '[data-testid="sharing-recipients-badge"]',
      )?.textContent,
    ).toContain("Shared with 1");
    expect(view.queryAllByTestId("sharing-recipients-badge")).toHaveLength(1);
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
