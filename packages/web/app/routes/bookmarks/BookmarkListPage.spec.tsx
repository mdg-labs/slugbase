import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { staticMessages } from "../../i18n/messages.js";
import type { BookmarkListData } from "./bookmarks-loader.js";
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
}));

vi.mock("./bookmarks-api.js", () => ({
  bulkDeleteBookmarks: vi.fn(),
  bulkMoveToFolder: vi.fn(),
  bulkPinBookmarks: vi.fn(),
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

let mockLoaderData: BookmarkListData;

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
  });

  afterEach(() => {
    cleanup();
  });

  it("opens bookmark modal when empty-state primary button is clicked", async () => {
    renderPage();

    // The unfiltered empty state should be visible
    expect(screen.getByTestId("bookmark-list-empty")).toBeTruthy();

    // Find the "New bookmark" button
    const newBtn = screen.getByText("New bookmark");
    expect(newBtn).toBeTruthy();

    // Click it — should open the bookmark modal
    fireEvent.click(newBtn);

    await waitFor(() => {
      expect(screen.getByTestId("bookmark-modal")).toBeTruthy();
    });
  });
});