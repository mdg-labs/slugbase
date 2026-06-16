import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { staticMessages } from "../../i18n/messages.js";
import type { BookmarkListItem } from "../../routes/bookmarks/bookmarks-loader.js";
import { PRIVATE_BOOKMARK_SHARING_SUMMARY } from "../../routes/bookmarks/bookmarks-loader.js";
import type { BookmarkSharingSummary } from "../sharing/sharing-recipients.utils.js";
import { BookmarkCard } from "./BookmarkCard.js";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const messages = staticMessages.en as Record<string, string>;
      const template = messages[key] ?? key;
      if (!params) {
        return template;
      }
      return Object.entries(params).reduce(
        (value, [name, paramValue]) =>
          value.replace(new RegExp(`\\{${name}\\}`, "g"), String(paramValue)),
        template,
      );
    },
  }),
}));

vi.mock("../../routes/bookmarks/BookmarkFavicon.js", () => ({
  BookmarkFavicon: ({ size }: { size: number }) => (
    <span data-testid="bookmark-favicon" data-size={size} />
  ),
}));

const makeBookmark = (overrides: Partial<BookmarkListItem> = {}): BookmarkListItem => ({
  id: "bk-1",
  userId: "user-1",
  title: "Example Bookmark",
  url: "https://example.com",
  slug: "example",
  forwardingEnabled: true,
  pinned: false,
  accessCount: 5,
  lastAccessedAt: "2026-06-01T10:00:00Z",
  createdAt: "2026-05-01T10:00:00Z",
  sharingSummary: PRIVATE_BOOKMARK_SHARING_SUMMARY,
  folders: [],
  tags: [],
  ...overrides,
});

function renderCard(
  overrides: Partial<Parameters<typeof BookmarkCard>[0]> = {},
) {
  const bookmark = overrides.bookmark ?? makeBookmark();
  const props = {
    bookmark,
    selected: false,
    bulkSelectMode: false,
    onToggleSelect: vi.fn(),
    onOpenUrl: vi.fn(),
    onPin: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    currentUserId: "user-1",
    ...overrides,
  };

  const view = render(<BookmarkCard {...props} />);
  return { ...view, props };
}

describe("BookmarkCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders card anatomy with favicon, title, URL, slug, and chips", () => {
    renderCard({
      bookmark: makeBookmark({
        id: "bk-42",
        title: "Docs Site",
        url: "https://docs.example.com",
        slug: "docs",
        folders: [{ id: "f-1", name: "work", color: "#45c98a" }],
        tags: [{ id: "t-1", name: "reference", color: "#7782f7" }],
      }),
    });

    const card = screen.getByTestId("bookmark-card-bk-42");
    expect(card).toBeTruthy();
    expect(screen.getByText("Docs Site")).toBeTruthy();
    expect(screen.getByText("https://docs.example.com")).toBeTruthy();
    expect(screen.getByText("/docs")).toBeTruthy();
    expect(screen.getByText("work")).toBeTruthy();
    expect(screen.getByText("reference")).toBeTruthy();

    const favicon = screen.getByTestId("bookmark-favicon");
    expect(favicon.getAttribute("data-size")).toBe("32");
    expect(screen.queryByTestId("sharing-recipients-badge")).toBeNull();
  });

  it("shows sharing badge for owned bookmark shared directly", () => {
    const sharingSummary: BookmarkSharingSummary = {
      scope: "shared-by-me",
      directRecipients: [{ kind: "user", targetId: "u2", targetName: "Alice" }],
      viaFolders: [],
    };

    renderCard({
      bookmark: makeBookmark({ id: "bk-shared", sharingSummary }),
    });

    expect(screen.getByTestId("sharing-recipients-badge").textContent).toContain(
      "Shared with 1",
    );
  });

  it("shows sharing badge for owned bookmark shared via folder only", () => {
    const sharingSummary: BookmarkSharingSummary = {
      scope: "shared-by-me",
      directRecipients: [],
      viaFolders: [
        {
          folderId: "f1",
          folderName: "Reading",
          recipients: [{ kind: "user", targetId: "u2", targetName: "Bob" }],
        },
      ],
    };

    renderCard({
      bookmark: makeBookmark({ id: "bk-folder-share", sharingSummary }),
    });

    expect(screen.getByTestId("sharing-recipients-badge").textContent).toContain(
      "Shared with 1",
    );
  });

  it("shows shared-with-you badge for recipient bookmarks", () => {
    const sharingSummary: BookmarkSharingSummary = {
      scope: "shared-with-me",
      directRecipients: [],
      viaFolders: [],
      accessPath: {
        kind: "folder",
        ownerName: "Sarah K.",
        folderName: "Team Resources",
      },
    };

    renderCard({
      bookmark: makeBookmark({
        id: "bk-recipient",
        userId: "other-user",
        sharingSummary,
      }),
    });

    expect(screen.getByTestId("sharing-recipients-badge").textContent).toContain(
      "Shared with you",
    );
  });

  it("shows pinned left accent when bookmark is pinned", () => {
    renderCard({
      bookmark: makeBookmark({ id: "bk-pinned", pinned: true }),
    });

    const card = screen.getByTestId("bookmark-card-bk-pinned");
    expect(card.className).toContain("shadow-[inset_3px_0_0_var(--accent)]");
  });

  it("does not show pinned accent when bookmark is not pinned", () => {
    renderCard({
      bookmark: makeBookmark({ id: "bk-unpinned", pinned: false }),
    });

    const card = screen.getByTestId("bookmark-card-bk-unpinned");
    expect(card.className).not.toContain("shadow-[inset_3px_0_0_var(--accent)]");
  });

  it("invokes menu action callbacks for open, edit, pin, and delete", async () => {
    const bookmark = makeBookmark({ id: "bk-menu", pinned: false });
    const { props } = renderCard({ bookmark });

    const openMenu = async () => {
      fireEvent.pointerDown(screen.getByLabelText("More options"));
      await waitFor(() => {
        expect(screen.getByText("Open URL")).toBeTruthy();
      });
    };

    await openMenu();
    fireEvent.click(screen.getByText("Open URL"));
    expect(props.onOpenUrl).toHaveBeenCalledWith("https://example.com");

    await openMenu();
    fireEvent.click(screen.getByText("Edit"));
    expect(props.onEdit).toHaveBeenCalledWith(bookmark);

    await openMenu();
    fireEvent.click(screen.getByText("Pin"));
    expect(props.onPin).toHaveBeenCalledWith(true);

    await openMenu();
    fireEvent.click(screen.getByText("Delete"));
    expect(props.onDelete).toHaveBeenCalledWith(bookmark);
  });

  it("opens URL on card click in normal mode", () => {
    const { props } = renderCard({
      bookmark: makeBookmark({ id: "bk-click", url: "https://example.com" }),
      bulkSelectMode: false,
    });

    fireEvent.click(screen.getByTestId("bookmark-card-bk-click"));
    expect(props.onOpenUrl).toHaveBeenCalledWith("https://example.com");
    expect(props.onToggleSelect).not.toHaveBeenCalled();
  });

  it("toggles selection on card click in bulk-select mode", () => {
    const { props } = renderCard({
      bookmark: makeBookmark({ id: "bk-bulk" }),
      bulkSelectMode: true,
    });

    fireEvent.click(screen.getByTestId("bookmark-card-bk-bulk"));
    expect(props.onToggleSelect).toHaveBeenCalledTimes(1);
    expect(props.onOpenUrl).not.toHaveBeenCalled();
  });

  it("shows bulk-select checkbox overlay when bulkSelectMode is active", () => {
    renderCard({
      bookmark: makeBookmark({ id: "bk-checkbox" }),
      bulkSelectMode: true,
      selected: true,
    });

    const card = screen.getByTestId("bookmark-card-bk-checkbox");
    const checkboxes = card.querySelectorAll('[aria-hidden="true"]');
    expect(checkboxes.length).toBeGreaterThanOrEqual(1);
    expect(card.className).toContain("border-[color:var(--accent-border)]");
  });

  it("toggles selection when bulk-select checkbox is clicked", () => {
    const { props } = renderCard({
      bookmark: makeBookmark({ id: "bk-checkbox-click" }),
      bulkSelectMode: true,
    });

    const card = screen.getByTestId("bookmark-card-bk-checkbox-click");
    const checkbox = card.querySelector('[aria-hidden="true"]');
    expect(checkbox).toBeTruthy();
    fireEvent.click(checkbox as Element);
    expect(props.onToggleSelect).toHaveBeenCalledTimes(1);
  });
});
