import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppToastProvider } from "../feedback/AppToastProvider.js";
import { staticMessages } from "../../i18n/messages.js";
import { DashboardPinned } from "./DashboardPinned.js";
import { DashboardRecent } from "./DashboardRecent.js";
import { DashboardQuickAccess } from "./DashboardQuickAccess.js";
import type { DashboardBookmark } from "./dashboard.types.js";

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

vi.mock("react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  useRevalidator: () => ({ revalidate: vi.fn() }),
}));

vi.mock("../../lib/session-client.js", () => ({
  useAppShellData: () => ({
    user: { id: "user-1" },
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

const pinnedBookmark: DashboardBookmark = {
  id: "bm-1",
  userId: "user-1",
  title: "Pinned guide",
  url: "https://example.com/guide",
  slug: "guide",
  forwardingEnabled: true,
  pinned: true,
  accessCount: 3,
  lastAccessedAt: "2026-05-29T08:00:00.000Z",
  createdAt: "2026-05-01T08:00:00.000Z",
  shareGrantCount: 0,
  folders: [],
  tags: [],
};

const recentBookmark: DashboardBookmark = {
  id: "bm-2",
  userId: "user-1",
  title: "Recent article",
  url: "https://example.com/article",
  slug: null,
  forwardingEnabled: false,
  pinned: false,
  accessCount: 1,
  lastAccessedAt: "2026-05-31T09:00:00.000Z",
  createdAt: "2026-05-02T09:00:00.000Z",
  shareGrantCount: 0,
  folders: [],
  tags: [],
};

const quickAccessBookmark: DashboardBookmark = {
  id: "bm-3",
  userId: "user-1",
  title: "React docs",
  url: "https://react.dev",
  slug: "react",
  forwardingEnabled: true,
  pinned: false,
  accessCount: 42,
  lastAccessedAt: "2026-05-30T10:00:00.000Z",
  createdAt: "2026-05-03T10:00:00.000Z",
  shareGrantCount: 0,
  folders: [],
  tags: [],
};

function renderWithToast(ui: ReactNode) {
  return render(<AppToastProvider>{ui}</AppToastProvider>);
}

describe("DashboardPinned", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders shared BookmarkCard with bookmark-card testids", () => {
    renderWithToast(<DashboardPinned bookmarks={[pinnedBookmark]} />);

    expect(screen.getByTestId("dashboard-pinned")).toBeTruthy();
    expect(screen.getByTestId("bookmark-card-bm-1")).toBeTruthy();
    expect(screen.getByText("Pinned guide")).toBeTruthy();
    expect(screen.getByLabelText("More options")).toBeTruthy();
  });

  it("exposes bookmark menu actions", async () => {
    renderWithToast(<DashboardPinned bookmarks={[pinnedBookmark]} />);

    fireEvent.pointerDown(screen.getByLabelText("More options"));
    await waitFor(() => {
      expect(screen.getByText("Edit")).toBeTruthy();
      expect(screen.getByText("Unpin")).toBeTruthy();
      expect(screen.getByText("Delete")).toBeTruthy();
    });
  });
});

describe("DashboardRecent", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders shared BookmarkCard in the recent section", () => {
    renderWithToast(<DashboardRecent bookmarks={[recentBookmark]} />);

    expect(screen.getByTestId("dashboard-recent")).toBeTruthy();
    expect(screen.getByTestId("bookmark-card-bm-2")).toBeTruthy();
    expect(screen.getByText("Recent article")).toBeTruthy();
  });
});

describe("DashboardQuickAccess", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders shared BookmarkCard in the quick-access section", () => {
    renderWithToast(
      <DashboardQuickAccess bookmarks={[quickAccessBookmark]} />,
    );

    expect(screen.getByTestId("dashboard-quick-access")).toBeTruthy();
    expect(screen.getByTestId("bookmark-card-bm-3")).toBeTruthy();
    expect(screen.getByText("React docs")).toBeTruthy();
  });
});
