import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppToastProvider } from "../../components/feedback/AppToastProvider.js";
import { staticMessages } from "../../i18n/messages.js";
import type { TagListData } from "./tags-loader.js";
import { TagListPage } from "./TagListPage.js";
import type { TaggedBookmark } from "./tags-api.js";
import { PRIVATE_BOOKMARK_SHARING_SUMMARY } from "../bookmarks/bookmarks-loader.js";

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

const mockNavigate = vi.fn();
const mockRevalidate = vi.fn();

vi.mock("react-router", () => ({
  useLoaderData: () => mockTagListData,
  useNavigate: () => mockNavigate,
  useNavigation: () => ({ state: "idle" }),
  useRevalidator: () => ({ revalidate: mockRevalidate }),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

vi.mock("../../lib/session-client.js", () => ({
  useAppShellData: () => ({
    user: { id: "user-1" },
  }),
}));

vi.mock("../../components/bookmark-modal/BookmarkModalProvider.js", () => ({
  useBookmarkModal: () => ({
    openEdit: vi.fn(),
    openCreate: vi.fn(),
    open: vi.fn(),
  }),
}));

vi.mock("./tags-api.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./tags-api.js")>();
  return {
    ...original,
    fetchTaggedBookmarks: vi.fn(),
    createTag: vi.fn(),
    renameTag: vi.fn(),
    deleteTag: vi.fn(),
  };
});

vi.mock("../../routes/bookmarks/BookmarkFavicon.js", () => ({
  BookmarkFavicon: ({ size }: { size: number }) => (
    <span data-testid="bookmark-favicon" data-size={size} />
  ),
}));

vi.mock("../../routes/bookmarks/bookmarks-api.js", () => ({
  toggleBookmarkPin: vi.fn(),
  deleteBookmark: vi.fn(),
}));

const mockTagListData: TagListData = {
  items: [
    {
      id: "tag-1",
      name: "docs",
      color: "#7782f7",
      bookmarkCount: 2,
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
    },
  ],
  total: 1,
  page: 1,
  pageSize: 50,
  sort: "usage-desc",
  q: "",
  maxBookmarkCount: 2,
};

const taggedBookmarks: TaggedBookmark[] = [
  {
    id: "bm-10",
    userId: "user-1",
    title: "API reference",
    url: "https://example.com/api",
    slug: "api",
    forwardingEnabled: true,
    pinned: false,
    accessCount: 4,
    lastAccessedAt: "2026-05-30T10:00:00.000Z",
    createdAt: "2026-05-01T10:00:00.000Z",
    sharingSummary: PRIVATE_BOOKMARK_SHARING_SUMMARY,
    folders: [],
    tags: [{ id: "tag-1", name: "docs", color: "#7782f7" }],
  },
];

describe("TagListPage detail panel", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { fetchTaggedBookmarks } = await import("./tags-api.js");
    vi.mocked(fetchTaggedBookmarks).mockResolvedValue(taggedBookmarks);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders tag bookmark preview with bookmark-card testids", async () => {
    render(
      <AppToastProvider>
        <TagListPage />
      </AppToastProvider>,
    );

    fireEvent.click(screen.getByTestId("tag-row-tag-1"));

    await waitFor(() => {
      expect(screen.getByTestId("tag-detail-panel")).toBeTruthy();
      expect(screen.getByTestId("bookmark-card-bm-10")).toBeTruthy();
    });

    expect(screen.getByText("API reference")).toBeTruthy();
    expect(screen.getByLabelText("More options")).toBeTruthy();
  });
});
