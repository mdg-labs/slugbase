import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { staticMessages } from "../../i18n/messages.js";
import type { GlobalSearchResult } from "../../lib/search.types.js";
import { CommandPalette } from "./CommandPalette.js";
import {
  filterGoSlugMatches,
  goRouteForSlug,
  openGoTarget,
  parsePaletteQuery,
} from "./go-mode.js";

const mockNavigate = vi.fn();
const mockLoad = vi.fn();
let fetcherData: GlobalSearchResult | undefined;
let fetcherState: "idle" | "loading" = "idle";

vi.mock("@tolgee/react", () => ({
  useTranslate: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const messages = staticMessages.en as Record<string, string>;
      const template = messages[key] ?? key;
      if (!params) return template;
      return Object.entries(params).reduce(
        (acc, [name, value]) =>
          acc.replace(new RegExp(`\\{${name}\\}`, "g"), String(value)),
        template,
      );
    },
  }),
}));

vi.mock("react-router", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-router")>();
  return {
    ...original,
    useNavigate: () => mockNavigate,
    useFetcher: () => ({
      state: fetcherState,
      data: fetcherData,
      load: mockLoad,
    }),
  };
});

const forwardingBookmark = (
  id: string,
  slug: string,
  title: string,
): GlobalSearchResult["bookmarks"]["items"][number] => ({
  id,
  workspaceId: "ws-1",
  userId: "user-1",
  title,
  url: `https://example.com/${slug}`,
  slug,
  forwardingEnabled: true,
  pinned: false,
  planArchived: false,
  accessCount: 0,
  lastAccessedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("go-mode utilities", () => {
  it("detects go mode from go prefix", () => {
    expect(parsePaletteQuery("go react")).toEqual({
      mode: "go",
      slugPrefix: "react",
    });
  });

  it("detects pasted /go/slug paths", () => {
    expect(parsePaletteQuery("/go/my-link")).toEqual({
      mode: "go",
      slugPrefix: "my-link",
    });
  });

  it("filters forwarding bookmarks by slug prefix", () => {
    const hits = [
      forwardingBookmark("1", "react19", "React 19"),
      forwardingBookmark("2", "react-docs", "React docs"),
      {
        ...forwardingBookmark("3", "rust", "Rust"),
        forwardingEnabled: false,
      },
      {
        ...forwardingBookmark("4", "readme", "Readme"),
        slug: null,
      },
    ];

    expect(filterGoSlugMatches(hits, "react").map((b) => b.slug)).toEqual([
      "react19",
      "react-docs",
    ]);
  });

  it("builds /go routes", () => {
    expect(goRouteForSlug("react19")).toBe("/go/react19");
  });
});

describe("CommandPalette go mode", () => {
  let locationAssignMock: ReturnType<typeof vi.fn>;
  let windowOpenMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockNavigate.mockReset();
    mockLoad.mockReset();
    fetcherData = undefined;
    fetcherState = "idle";
    windowOpenMock = vi.fn().mockReturnValue(null);
    locationAssignMock = vi.fn();
    vi.spyOn(window, "open").mockImplementation(windowOpenMock);
    vi.spyOn(window.location, "assign").mockImplementation(locationAssignMock);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("enters go mode and loads slug matches from search", async () => {
    vi.useFakeTimers();

    const view = render(<CommandPalette open onOpenChange={vi.fn()} />);

    await act(async () => {
      fireEvent.change(view.getByTestId("command-palette-input"), {
        target: { value: "go re" },
      });
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(mockLoad).toHaveBeenCalledWith(
      "/api/search?q=re&bookmarkLimit=6&folderLimit=1&tagLimit=1",
    );
    expect(view.getByTestId("go-mode-badge")).toBeTruthy();
  });

  it("renders live slug matches and navigates via /go on select", async () => {
    vi.useFakeTimers();

    fetcherData = {
      q: "re",
      limits: { bookmarks: 6, folders: 1, tags: 1 },
      bookmarks: {
        items: [
          forwardingBookmark("1", "react19", "React 19"),
          forwardingBookmark("2", "readme", "Readme"),
        ],
        total: 2,
        truncated: false,
      },
      folders: { items: [], total: 0, truncated: false },
      tags: { items: [], total: 0, truncated: false },
      fallback: {
        bookmarks: { path: "/", queryParam: "q" },
        folders: { path: "/folders", queryParam: "q" },
        tags: { path: "/tags", queryParam: "q" },
      },
    };

    const view = render(<CommandPalette open onOpenChange={vi.fn()} />);

    await act(async () => {
      fireEvent.change(view.getByTestId("command-palette-input"), {
        target: { value: "go re" },
      });
      await vi.advanceTimersByTimeAsync(300);
    });
    vi.useRealTimers();

    await waitFor(() => {
      expect(view.getByTestId("go-mode-item-react19")).toBeTruthy();
    });

    fireEvent.click(view.getByTestId("go-mode-item-react19"));

    expect(locationAssignMock).toHaveBeenCalledWith("/go/react19");
  });

  it("opens /go in a new tab when Enter uses the modifier", async () => {
    vi.useFakeTimers();

    fetcherData = {
      q: "react19",
      limits: { bookmarks: 6, folders: 1, tags: 1 },
      bookmarks: {
        items: [forwardingBookmark("1", "react19", "React 19")],
        total: 1,
        truncated: false,
      },
      folders: { items: [], total: 0, truncated: false },
      tags: { items: [], total: 0, truncated: false },
      fallback: {
        bookmarks: { path: "/", queryParam: "q" },
        folders: { path: "/folders", queryParam: "q" },
        tags: { path: "/tags", queryParam: "q" },
      },
    };

    const view = render(<CommandPalette open onOpenChange={vi.fn()} />);

    await act(async () => {
      fireEvent.change(view.getByTestId("command-palette-input"), {
        target: { value: "go react19" },
      });
      await vi.advanceTimersByTimeAsync(300);
    });
    vi.useRealTimers();

    await waitFor(() => {
      expect(view.getByTestId("go-mode-item-react19")).toBeTruthy();
    });

    const input = view.getByTestId("command-palette-input");
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });

    expect(windowOpenMock).toHaveBeenCalledWith(
      "/go/react19",
      "_blank",
      "noopener,noreferrer",
    );
  });
});

describe("openGoTarget", () => {
  it("assigns location for same-tab navigation", () => {
    const assign = vi.fn();
    vi.spyOn(window.location, "assign").mockImplementation(assign);
    openGoTarget("/go/test", false);
    expect(assign).toHaveBeenCalledWith("/go/test");
    vi.restoreAllMocks();
  });
});
