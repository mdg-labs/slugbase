import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { staticMessages } from "../../i18n/messages.js";
import type { BookmarkListData, BookmarkListItem } from "./bookmarks-loader.js";
import { BookmarkListPage } from "./BookmarkListPage.js";
import { BookmarkModalProvider } from "../../components/bookmark-modal/BookmarkModalProvider.js";
import { AppToastProvider } from "../../components/feedback/AppToastProvider.js";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const messages = staticMessages.en as Record<string, string>;
      const template = messages[key] ?? key;
      return template.replace(/\{(\w+)\}/g, (_match: string, name: string) =>
        params?.[name] != null ? String(params[name]) : `{${name}}`,
      );
    },
  }),
}));

const mockNavigate = vi.fn();

vi.mock("react-router", () => ({
  useLoaderData: () => mockLoaderData,
  useNavigate: () => mockNavigate,
  useNavigation: () => ({ state: "idle" }),
  useRevalidator: () => ({ revalidate: vi.fn(), state: "idle" }),
}));

vi.mock("./bookmarks-api.js", () => ({
  bulkDeleteBookmarks: vi.fn(),
  bulkMoveToFolder: vi.fn(),
  bulkPinBookmarks: vi.fn(),
  bulkAddTags: vi.fn(),
  bulkRemoveTags: vi.fn(),
  deleteBookmark: vi.fn(),
  loadToolbarOptions: vi.fn().mockResolvedValue({ folders: [], tags: [] }),
  toggleBookmarkPin: vi.fn(),
}));

vi.mock("../../components/bookmark-modal/bookmark-modal-api.js", () => ({
  loadBookmarkModalOptions: vi.fn().mockResolvedValue({ folders: [], tags: [] }),
  submitBookmarkModal: vi.fn(),
}));

vi.mock("../../components/sharing/use-workspace-entitlements.js", () => ({
  useWorkspaceEntitlements: () => ({
    currentUserId: "user-1",
    canShare: false,
  }),
}));

vi.mock("./BookmarkFavicon.js", () => ({
  BookmarkFavicon: () => <span data-testid="bookmark-favicon" />,
}));

vi.mock("../../components/list/SectionHead.js", () => ({
  SectionHead: ({ label }: { label: string }) => (
    <div data-testid="section-head">{label}</div>
  ),
}));

vi.mock("../../components/import/ImportDialog.js", () => ({
  ImportDialog: ({
    open,
    onOpenChange,
    onSuccess,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSuccess?: (result: { successCount: number; capLimitedCount: number }) => void;
  }) =>
    open ? (
      <div data-testid="import-dialog">
        <button
          type="button"
          data-testid="import-dialog-mock-submit"
          onClick={() => {
            onSuccess?.({ successCount: 2, capLimitedCount: 0 });
            onOpenChange(false);
          }}
        >
          Mock import
        </button>
      </div>
    ) : null,
}));

let mockLoaderData: BookmarkListData;

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
  shareGrantCount: 0,
  folders: [],
  tags: [],
  ...overrides,
});

const emptyUnfilteredData: BookmarkListData = {
  items: [],
  total: 0,
  page: 1,
  pageSize: 24,
  q: "",
  folderId: null,
  tagIds: [],
  pinnedOnly: false,
  scope: "all",
  sort: "created-desc",
  view: "grid",
  defaultBookmarkView: "grid",
  bookmarkCap: null,
  workspaceBookmarkTotal: 0,
  toolbarFolders: [],
  toolbarTags: [],
};

function renderPage() {
  return render(
    <AppToastProvider>
      <BookmarkModalProvider>
        <BookmarkListPage />
      </BookmarkModalProvider>
    </AppToastProvider>,
  );
}

describe("BookmarkListPage", () => {
  beforeEach(() => {
    mockLoaderData = { ...emptyUnfilteredData };
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("opens bookmark modal when empty-state primary button is clicked", async () => {
    renderPage();

    expect(screen.getByTestId("bookmark-list-empty")).toBeTruthy();

    const newBtn = screen.getByText("New bookmark");
    expect(newBtn).toBeTruthy();

    fireEvent.click(newBtn);

    await waitFor(() => {
      expect(screen.getByTestId("bookmark-modal")).toBeTruthy();
    });
  });

  it("opens import dialog from empty-state import button", async () => {
    renderPage();

    fireEvent.click(screen.getByTestId("bookmark-import-action-empty"));

    await waitFor(() => {
      expect(screen.getByTestId("import-dialog")).toBeTruthy();
    });
  });

  it("opens import dialog from toolbar when bookmarks exist", async () => {
    mockLoaderData = {
      ...emptyUnfilteredData,
      items: [makeBookmark()],
      total: 1,
    };

    renderPage();

    fireEvent.click(screen.getByTestId("bookmark-import-action"));

    await waitFor(() => {
      expect(screen.getByTestId("import-dialog")).toBeTruthy();
    });
  });

  describe("Folder chip colors", () => {
    it("applies folder color to grid card chips when set", () => {
      mockLoaderData = {
        ...emptyUnfilteredData,
        items: [
          makeBookmark({
            id: "bk-1",
            folders: [{ id: "folder-1", name: "work", color: "#45c98a" }],
          }),
        ],
        total: 1,
      };

      renderPage();

      const card = screen.getByTestId("bookmark-card-bk-1");
      const chips = card.querySelectorAll(".font-mono");
      const coloredChip = Array.from(chips).find((el) =>
        el.textContent.includes("work"),
      );
      expect(coloredChip).toBeTruthy();
      expect((coloredChip as HTMLElement).style.color).toBe("#45c98a");
    });

    it("renders neutral folder chip when color is null", () => {
      mockLoaderData = {
        ...emptyUnfilteredData,
        items: [
          makeBookmark({
            id: "bk-1",
            folders: [{ id: "folder-1", name: "inbox", color: null }],
          }),
        ],
        total: 1,
      };

      renderPage();

      const card = screen.getByTestId("bookmark-card-bk-1");
      const chips = card.querySelectorAll(".font-mono");
      const neutralChip = Array.from(chips).find((el) =>
        el.textContent.includes("inbox"),
      );
      expect(neutralChip).toBeTruthy();
      expect((neutralChip as HTMLElement).style.color).toBe("");
    });
  });

  describe("Tag chip colors", () => {
    it("applies tag color to grid card chips when set", () => {
      mockLoaderData = {
        ...emptyUnfilteredData,
        items: [
          makeBookmark({
            id: "bk-1",
            tags: [
              { id: "tag-1", name: "alpha", color: "#7782f7" },
              { id: "tag-2", name: "beta", color: null },
            ],
          }),
        ],
        total: 1,
      };

      renderPage();

      const card = screen.getByTestId("bookmark-card-bk-1");
      const chips = card.querySelectorAll(".font-mono");
      const coloredChip = Array.from(chips).find((el) =>
        el.textContent.includes("alpha"),
      );
      expect(coloredChip).toBeTruthy();
      expect((coloredChip as HTMLElement).style.color).toBe("#7782f7");

      const neutralChip = Array.from(chips).find((el) =>
        el.textContent.includes("beta"),
      );
      expect(neutralChip).toBeTruthy();
      expect((neutralChip as HTMLElement).style.color).toBe("");
    });
  });

  describe("Bookmark card click - normal mode", () => {
    it("opens bookmark URL in a new tab when a card is clicked", () => {
      const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
      mockLoaderData = {
        ...emptyUnfilteredData,
        items: [makeBookmark({ id: "bk-1", url: "https://example.com" })],
      };

      renderPage();

      const card = screen.getByTestId("bookmark-card-bk-1");
      fireEvent.click(card);

      expect(openSpy).toHaveBeenCalledWith(
        "https://example.com",
        "_blank",
        "noopener,noreferrer",
      );
      openSpy.mockRestore();
    });
  });

  describe("Bookmark table row click - normal mode", () => {
    it("opens bookmark URL in a new tab when a row is clicked", () => {
      const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
      mockLoaderData = {
        ...emptyUnfilteredData,
        view: "table",
        defaultBookmarkView: "table",
        items: [makeBookmark({ id: "bk-1", url: "https://example.com" })],
      };

      renderPage();

      const row = screen.getByTestId("bookmark-row-bk-1");
      fireEvent.click(row);

      expect(openSpy).toHaveBeenCalledWith(
        "https://example.com",
        "_blank",
        "noopener,noreferrer",
      );
      openSpy.mockRestore();
    });
  });

  describe("3-dot menu stopPropagation", () => {
    it("does not open URL when the 3-dot menu trigger is clicked", () => {
      const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
      mockLoaderData = {
        ...emptyUnfilteredData,
        items: [makeBookmark({ id: "bk-1", url: "https://example.com" })],
      };

      renderPage();

      const menuBtn = screen.getByLabelText("More options");
      fireEvent.click(menuBtn);

      // The card's onClick should NOT have been triggered
      expect(openSpy).not.toHaveBeenCalled();
      openSpy.mockRestore();
    });
  });

  describe("Bulk-select mode toggle", () => {
    it("has a Select button in the toolbar", () => {
      mockLoaderData = {
        ...emptyUnfilteredData,
        items: [makeBookmark()],
      };

      renderPage();

      const selectBtn = screen.getByTestId("bookmark-bulk-select-toggle");
      expect(selectBtn).toBeTruthy();
      expect(selectBtn.textContent).toContain("Select");
    });

    it("enters bulk-select mode when Select button is clicked", () => {
      mockLoaderData = {
        ...emptyUnfilteredData,
        items: [makeBookmark({ id: "bk-1" })],
      };

      renderPage();

      const selectBtn = screen.getByTestId("bookmark-bulk-select-toggle");
      fireEvent.click(selectBtn);

      // Button text should change to "Cancel selection"
      expect(selectBtn.textContent).toContain("Cancel selection");
    });

    it("card click in bulk-select mode toggles selection instead of opening URL", () => {
      const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
      mockLoaderData = {
        ...emptyUnfilteredData,
        total: 1,
        items: [makeBookmark({ id: "bk-1", url: "https://example.com" })],
      };

      renderPage();

      // Enter bulk-select mode
      const selectBtn = screen.getByTestId("bookmark-bulk-select-toggle");
      fireEvent.click(selectBtn);

      // Click the card
      const card = screen.getByTestId("bookmark-card-bk-1");
      fireEvent.click(card);

      // Should NOT open URL
      expect(openSpy).not.toHaveBeenCalled();

      // Should show BulkBar
      expect(screen.getByTestId("bulk-bar")).toBeTruthy();
      openSpy.mockRestore();
    });
  });

  describe("Bulk-select checkbox position", () => {
    it("shows checkbox next to the 3-dot menu in bulk-select mode", () => {
      mockLoaderData = {
        ...emptyUnfilteredData,
        total: 1,
        items: [makeBookmark({ id: "bk-1" })],
      };

      renderPage();

      // Enter bulk-select mode
      const selectBtn = screen.getByTestId("bookmark-bulk-select-toggle");
      fireEvent.click(selectBtn);

      const card = screen.getByTestId("bookmark-card-bk-1");
      // The card should contain an aria-hidden checkbox element
      const checkboxes = card.querySelectorAll('[aria-hidden="true"]');
      expect(checkboxes.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Exit bulk-select mode", () => {
    it("clears selection and exits bulk-select mode when Select button is clicked again", () => {
      mockLoaderData = {
        ...emptyUnfilteredData,
        total: 2,
        items: [makeBookmark({ id: "bk-1" }), makeBookmark({ id: "bk-2", title: "Second" })],
      };

      renderPage();

      // Enter bulk-select mode
      const selectBtn = screen.getByTestId("bookmark-bulk-select-toggle");
      fireEvent.click(selectBtn);

      // Select a card
      const card = screen.getByTestId("bookmark-card-bk-1");
      fireEvent.click(card);

      // BulkBar should appear
      expect(screen.getByTestId("bulk-bar")).toBeTruthy();

      // Exit bulk-select mode
      fireEvent.click(selectBtn);

      // BulkBar should disappear (selection cleared)
      expect(screen.queryByTestId("bulk-bar")).toBeNull();

      // Button should be back to "Select"
      expect(selectBtn.textContent).toContain("Select");
    });

    it("exits bulk-select mode and clears selection on Escape key", () => {
      mockLoaderData = {
        ...emptyUnfilteredData,
        total: 1,
        items: [makeBookmark({ id: "bk-1" })],
      };

      renderPage();

      // Enter bulk-select mode
      const selectBtn = screen.getByTestId("bookmark-bulk-select-toggle");
      fireEvent.click(selectBtn);

      // Select a card
      const card = screen.getByTestId("bookmark-card-bk-1");
      fireEvent.click(card);

      // BulkBar should appear
      expect(screen.getByTestId("bulk-bar")).toBeTruthy();

      // Press Escape
      fireEvent.keyDown(document, { key: "Escape" });

      // BulkBar should disappear
      expect(screen.queryByTestId("bulk-bar")).toBeNull();
      expect(selectBtn.textContent).toContain("Select");
    });
  });

  describe("Table view bulk-select", () => {
    it("row click in normal mode opens URL", () => {
      const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
      mockLoaderData = {
        ...emptyUnfilteredData,
        view: "table",
        defaultBookmarkView: "table",
        items: [makeBookmark({ id: "bk-1", url: "https://test.com" })],
      };

      renderPage();

      const row = screen.getByTestId("bookmark-row-bk-1");
      fireEvent.click(row);

      expect(openSpy).toHaveBeenCalledWith(
        "https://test.com",
        "_blank",
        "noopener,noreferrer",
      );
      openSpy.mockRestore();
    });

    it("row click in bulk-select mode toggles selection", () => {
      const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
      mockLoaderData = {
        ...emptyUnfilteredData,
        view: "table",
        defaultBookmarkView: "table",
        items: [makeBookmark({ id: "bk-1", url: "https://test.com" })],
      };

      renderPage();

      // Enter bulk-select mode
      const selectBtn = screen.getByTestId("bookmark-bulk-select-toggle");
      fireEvent.click(selectBtn);

      const row = screen.getByTestId("bookmark-row-bk-1");
      fireEvent.click(row);

      // Should NOT open URL
      expect(openSpy).not.toHaveBeenCalled();

      // Should show BulkBar
      expect(screen.getByTestId("bulk-bar")).toBeTruthy();
      openSpy.mockRestore();
    });
  });
});
