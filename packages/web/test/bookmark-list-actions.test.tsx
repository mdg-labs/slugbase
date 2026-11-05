import type { ComponentTypes } from "@slugbase/contracts";
import { FeedbackToastProvider } from "@slugbase/ui/patterns";
import { QueryClient, QueryClientProvider, type InfiniteData } from "@tanstack/react-query";
import { act, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient, type ApiClient } from "../src/api/client.ts";
import { useBulkBookmarks, usePinBookmark } from "../src/bookmarks/bookmark-list-actions.ts";
import type { BookmarkSelection } from "../src/bookmarks/bookmark-selection.ts";
import { BOOKMARK_LISTS_QUERY_KEY, type Bookmark, type BookmarkPage } from "../src/bookmarks/bookmarks.ts";
import { ConfigProvider } from "../src/config/config-context.tsx";
import { useSetForwarding } from "../src/forwarding/use-forwarding.ts";
import { I18nProvider } from "../src/i18n/i18n-provider.tsx";
import { CONFIG_BODY, json, problem, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The optimistic updates of a pin, a forwarding switch and a bulk change (doc 03 "Optimistic where safe") with the other
// queries cached under the bookmark lists' key: the palette's lists and search results and the tag preview. The failure
// scenarios are an update that reads every cached entry as pages of bookmarks and throws before the request is sent, and
// again when the change is put back, so nothing is saved and nothing is said; and an update that skips the entries it does
// not understand and leaves them out of the refresh that follows.

type SearchResults = ComponentTypes["schemas"]["SearchResults"];

const OWNER = "0192f3a0-bbbb-7000-8000-000000000001";
const TAG = { id: "0192f3a0-eeee-7000-8000-000000000001", name: "go" };

function bookmark(n: number, overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    id: `0192f3a0-aaaa-7000-8000-${String(n).padStart(12, "0")}`,
    ownerId: OWNER,
    url: `https://site${String(n)}.example.com/page`,
    host: `site${String(n)}.example.com`,
    title: `Bookmark ${String(n)}`,
    description: null,
    slug: null,
    forwarding: false,
    pinned: false,
    openCount: 0,
    lastOpenedAt: null,
    folders: [],
    tags: [],
    version: 3,
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-01T08:00:00.000Z",
    ...overrides,
  };
}

const LIST_KEY = [...BOOKMARK_LISTS_QUERY_KEY, { sort: "recent" }] as const;
const RECENT_KEY = [...BOOKMARK_LISTS_QUERY_KEY, "palette", "recent"] as const;
const PINNED_KEY = [...BOOKMARK_LISTS_QUERY_KEY, "palette", "pinned"] as const;
const SEARCH_KEY = [...BOOKMARK_LISTS_QUERY_KEY, "palette", "search", "book"] as const;
const PREVIEW_KEY = [...BOOKMARK_LISTS_QUERY_KEY, "tag-preview", TAG.id] as const;
const OTHER_KEYS = [RECENT_KEY, PINNED_KEY, SEARCH_KEY, PREVIEW_KEY] as const;

const first = bookmark(1);
const second = bookmark(2);

function pagesOf(items: readonly Bookmark[]): InfiniteData<BookmarkPage> {
  return { pages: [{ items: [...items], nextCursor: null, total: items.length }], pageParams: [undefined] };
}

function itemsOf(queryClient: QueryClient): readonly Bookmark[] {
  return queryClient.getQueryData<InfiniteData<BookmarkPage>>(LIST_KEY)?.pages.flatMap((page) => page.items) ?? [];
}

/** Puts a paged list and one entry of every other shape that sits under the list key into the cache. */
function seed(queryClient: QueryClient): { readonly others: Map<string, unknown> } {
  const search: SearchResults = { bookmarks: [], folders: [], tags: [] };
  queryClient.setQueryData(LIST_KEY, pagesOf([first, second]));
  queryClient.setQueryData(RECENT_KEY, [first]);
  queryClient.setQueryData(PINNED_KEY, []);
  queryClient.setQueryData(SEARCH_KEY, search);
  queryClient.setQueryData(PREVIEW_KEY, { items: [first, second], nextCursor: null, total: 2 } satisfies BookmarkPage);
  return { others: new Map(OTHER_KEYS.map((key) => [key.join("/"), queryClient.getQueryData(key)])) };
}

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

interface Server {
  readonly api: ApiClient;
  readonly sent: Sent[];
  /** Holds the answer to the next request until `release` is called, so that the list can be read while it is on its way. */
  readonly hold: () => () => void;
}

function createServer(answer: (request: Request) => Response): Server {
  const sent: Sent[] = [];
  let gate: Promise<void> | undefined;
  const api = createApiClient({
    baseUrl: "http://localhost",
    fetch: async (request) => {
      sent.push({ method: request.method, path: new URL(request.url).pathname, body: request.method === "GET" ? undefined : await request.clone().json() });
      await gate;
      return answer(request);
    },
  });
  return {
    api,
    sent,
    hold: () => {
      let release: () => void = () => undefined;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        release();
        gate = undefined;
      };
    },
  };
}

const routerApi: { current: ApiClient | undefined } = { current: undefined };
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useRouter: () => ({ options: { context: { api: routerApi.current } } }),
}));

let queryClient: QueryClient;

function Providers({ children }: { readonly children: ReactNode }) {
  return (
    <ConfigProvider config={{ ...CONFIG_BODY, locales: ["en", "de"] }}>
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          <FeedbackToastProvider regionLabel="Notifications">{children}</FeedbackToastProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ConfigProvider>
  );
}

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
  queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
});

afterEach(() => {
  vi.restoreAllMocks();
  queryClient.clear();
});

function expectOthersUntouched(before: Map<string, unknown>): void {
  for (const key of OTHER_KEYS) {
    expect(queryClient.getQueryData(key)).toBe(before.get(key.join("/")));
  }
}

function expectOthersRefreshed(): void {
  for (const key of OTHER_KEYS) {
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
  }
}

describe("pinning with the palette's and the tag preview's queries cached", () => {
  it("sends the request, shows the pin at once and keeps it once the server answers", async () => {
    const server = createServer(() => json({ ...first, pinned: true, version: 4 }));
    routerApi.current = server.api;
    const { others } = seed(queryClient);
    const { result } = renderHook(() => usePinBookmark(), { wrapper: Providers });
    const release = server.hold();

    act(() => {
      result.current.pin(first, true);
    });

    await waitFor(() => {
      expect(server.sent.map(({ method }) => method)).toEqual(["PATCH"]);
    });
    expect(server.sent[0]?.body).toEqual({ pinned: true });
    expect(itemsOf(queryClient).map(({ pinned }) => pinned)).toEqual([true, false]);
    expectOthersUntouched(others);

    await act(async () => {
      release();
      await Promise.resolve();
    });

    await waitFor(() => {
      expectOthersRefreshed();
    });
    expect(itemsOf(queryClient)[0]).toMatchObject({ pinned: true, version: 4 });
  });

  it("puts the pin back and says so when the server refuses it", async () => {
    const server = createServer(() => problem(412, "precondition_failed", "req-1"));
    routerApi.current = server.api;
    const { others } = seed(queryClient);
    const { result } = renderHook(() => usePinBookmark(), { wrapper: Providers });

    act(() => {
      result.current.pin(first, true);
    });

    expect((await screen.findAllByText("This bookmark changed elsewhere. The list is up to date now; try again.")).length).toBeGreaterThan(0);
    expect(itemsOf(queryClient).map(({ pinned }) => pinned)).toEqual([false, false]);
    expectOthersUntouched(others);
    expectOthersRefreshed();
  });
});

describe("the forwarding switch with the palette's and the tag preview's queries cached", () => {
  it("sends the request, shows the change at once and keeps it once the server answers", async () => {
    const server = createServer(() => json({ ...first, forwarding: true, version: 4 }));
    routerApi.current = server.api;
    const { others } = seed(queryClient);
    const { result } = renderHook(() => useSetForwarding(), { wrapper: Providers });
    const release = server.hold();

    act(() => {
      result.current.setForwarding(first, true);
    });

    await waitFor(() => {
      expect(server.sent.map(({ method }) => method)).toEqual(["PATCH"]);
    });
    expect(server.sent[0]?.body).toEqual({ forwarding: true });
    expect(itemsOf(queryClient).map(({ forwarding }) => forwarding)).toEqual([true, false]);
    expectOthersUntouched(others);

    await act(async () => {
      release();
      await Promise.resolve();
    });

    await waitFor(() => {
      expectOthersRefreshed();
    });
    expect(itemsOf(queryClient)[0]).toMatchObject({ forwarding: true, version: 4 });
  });

  it("puts the change back and says so when the bookmark is gone", async () => {
    const server = createServer(() => problem(404, "not_found", "req-1"));
    routerApi.current = server.api;
    const { others } = seed(queryClient);
    const { result } = renderHook(() => useSetForwarding(), { wrapper: Providers });

    act(() => {
      result.current.setForwarding(first, true);
    });

    expect((await screen.findAllByText("This bookmark no longer exists.")).length).toBeGreaterThan(0);
    await waitFor(() => {
      expectOthersRefreshed();
    });
    expect(itemsOf(queryClient).map(({ forwarding }) => forwarding)).toEqual([false, false]);
    expectOthersUntouched(others);
  });
});

describe("a bulk change with the palette's and the tag preview's queries cached", () => {
  function selectionOf(): BookmarkSelection {
    return { scope: "all", ids: new Set([first.id]), has: () => true, toggle: () => undefined, add: () => undefined, replace: () => undefined, clear: () => undefined };
  }

  it("shows the added tag at once, sends the request and refreshes the other queries", async () => {
    const server = createServer(() => json({ requested: 1, affected: 1, skipped: 0, skippedReasons: { not_owner: 0, not_found: 0 } }));
    routerApi.current = server.api;
    const { others } = seed(queryClient);
    const { result } = renderHook(() => useBulkBookmarks(selectionOf()), { wrapper: Providers });
    const release = server.hold();

    act(() => {
      result.current.run("add_tags", [first.id], { target: { tags: [TAG] } });
    });

    await waitFor(() => {
      expect(server.sent.map(({ method }) => method)).toEqual(["POST"]);
    });
    expect(server.sent[0]?.body).toMatchObject({ action: "add_tags", ids: [first.id], tagIds: [TAG.id] });
    expect(itemsOf(queryClient).map(({ tags }) => tags.length)).toEqual([1, 0]);
    expectOthersUntouched(others);

    await act(async () => {
      release();
      await Promise.resolve();
    });

    await waitFor(() => {
      expectOthersRefreshed();
    });
    expect(itemsOf(queryClient).map(({ tags }) => tags.length)).toEqual([1, 0]);
  });

  it("puts the tag back and says so when the request fails", async () => {
    const server = createServer(() => problem(500, "internal", "req-1"));
    routerApi.current = server.api;
    const { others } = seed(queryClient);
    const { result } = renderHook(() => useBulkBookmarks(selectionOf()), { wrapper: Providers });

    act(() => {
      result.current.run("add_tags", [first.id], { target: { tags: [TAG] } });
    });

    expect((await screen.findAllByText("The tags could not be added. Nothing was changed. Try again in a moment.")).length).toBeGreaterThan(0);
    expect(server.sent.map(({ method }) => method)).toEqual(["POST"]);
    expect(itemsOf(queryClient).map(({ tags }) => tags.length)).toEqual([0, 0]);
    expectOthersUntouched(others);
    expectOthersRefreshed();
  });
});
