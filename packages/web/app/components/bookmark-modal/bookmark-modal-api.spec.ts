import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BookmarkModalLoadError,
  loadBookmarkModalOptions,
  submitBookmarkModal,
} from "./bookmark-modal-api.js";
import type { BookmarkModalSubmitPayload } from "./bookmark-modal.types.js";

function fetchInputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function mockOkJson(data: unknown) {
  return { ok: true, json: () => Promise.resolve(data) } as Response;
}

function mockOkEmpty() {
  return { ok: true } as Response;
}

describe("submitBookmarkModal", () => {
  const originalFetch = globalThis.fetch;
  const CSRF_TOKEN = "csrf-shared-token";

  beforeEach(() => {
    vi.stubEnv("VITE_API_URL", "");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("fetches CSRF token once and reuses it for parallel ad-hoc tag creation", async () => {
    const mutationCalls: Array<{ url: string; token?: string }> = [];
    let tagCounter = 0;

    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = fetchInputUrl(input);
      const headers = init?.headers as Record<string, string> | undefined;
      const token = headers?.["x-csrf-token"];

      if (url.endsWith("/auth/csrf-token")) {
        return Promise.resolve(mockOkJson({ csrfToken: CSRF_TOKEN }));
      }

      if (url.endsWith("/api/tags") && init?.method === "POST") {
        tagCounter += 1;
        mutationCalls.push({ url, token });
        return Promise.resolve(mockOkJson({ id: `tag-${String(tagCounter)}` }));
      }

      if (url.endsWith("/api/bookmarks") && init?.method === "POST") {
        mutationCalls.push({ url, token });
        return Promise.resolve(mockOkJson({ id: "bm-new" }));
      }

      if (url.includes("/tags/") && url.endsWith("/bookmarks")) {
        mutationCalls.push({ url, token });
        return Promise.resolve(mockOkEmpty());
      }

      return Promise.resolve({ ok: false, status: 404 } as Response);
    });

    const payload: BookmarkModalSubmitPayload = {
      mode: "create",
      url: "https://example.com/adhoc-tags",
      title: "Ad-hoc tags",
      slug: "",
      folderIds: [],
      newFolderNames: [],
      tagIds: [],
      newTagNames: ["alpha", "beta"],
      pinned: false,
      forwardingEnabled: false,
    };

    await submitBookmarkModal(payload);

    const csrfFetches = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]) => fetchInputUrl(url as RequestInfo | URL).endsWith("/auth/csrf-token"),
    );
    expect(csrfFetches).toHaveLength(1);
    expect(mutationCalls.length).toBeGreaterThanOrEqual(4);
    expect(mutationCalls.every((call) => call.token === CSRF_TOKEN)).toBe(true);
  });

  it("reuses CSRF token for parallel folder and tag membership on create", async () => {
    const mutationTokens: string[] = [];

    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = fetchInputUrl(input);
      const headers = init?.headers as Record<string, string> | undefined;
      const token = headers?.["x-csrf-token"];

      if (url.endsWith("/auth/csrf-token")) {
        return Promise.resolve(mockOkJson({ csrfToken: CSRF_TOKEN }));
      }

      if (url.endsWith("/api/bookmarks") && init?.method === "POST") {
        mutationTokens.push(token ?? "");
        return Promise.resolve(mockOkJson({ id: "bm-1" }));
      }

      if (
        (url.includes("/folders/") || url.includes("/tags/")) &&
        url.endsWith("/bookmarks")
      ) {
        mutationTokens.push(token ?? "");
        return Promise.resolve(mockOkEmpty());
      }

      return Promise.resolve({ ok: false, status: 404 } as Response);
    });

    const payload: BookmarkModalSubmitPayload = {
      mode: "create",
      url: "https://example.com/multi-link",
      title: "Multi link",
      slug: "",
      folderIds: ["folder-1", "folder-2"],
      newFolderNames: [],
      tagIds: ["tag-1", "tag-2"],
      newTagNames: [],
      pinned: false,
      forwardingEnabled: false,
    };

    await submitBookmarkModal(payload);

    const csrfFetches = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]) => fetchInputUrl(url as RequestInfo | URL).endsWith("/auth/csrf-token"),
    );
    expect(csrfFetches).toHaveLength(1);
    expect(mutationTokens).toHaveLength(5);
    expect(mutationTokens.every((token) => token === CSRF_TOKEN)).toBe(true);
  });
});

describe("loadBookmarkModalOptions", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubEnv("VITE_API_URL", "");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns folders and tags on successful responses", async () => {
    const folders = [{ id: "f-1", name: "Reading", icon: null }];
    const tags = [{ id: "t-1", name: "research" }];

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ items: folders, total: 1, page: 1, pageSize: 100 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ items: tags, total: 1, page: 1, pageSize: 100 }),
      });

    const result = await loadBookmarkModalOptions();

    expect(result.folders).toEqual(folders);
    expect(result.tags).toEqual(tags);
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      "/api/folders?pageSize=100",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      "/api/tags?pageSize=100",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("uses same-origin /api proxy paths when VITE_API_URL is set (hosted)", async () => {
    vi.stubEnv("VITE_API_URL", "https://api.example.com");
    vi.resetModules();
    const { loadBookmarkModalOptions: loadOptions } = await import(
      "./bookmark-modal-api.js"
    );

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ items: [], total: 0, page: 1, pageSize: 100 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ items: [], total: 0, page: 1, pageSize: 100 }),
      });

    await loadOptions();

    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      "/api/folders?pageSize=100",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      "/api/tags?pageSize=100",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("throws BookmarkModalLoadError when folders endpoint returns non-OK", async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ items: [], total: 0, page: 1, pageSize: 100 }),
      });

    try {
      await loadBookmarkModalOptions();
      expect.fail("Expected BookmarkModalLoadError to be thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(BookmarkModalLoadError);
      expect((error as BookmarkModalLoadError).message).toMatch(/Failed to load folders/);
    }
  });

  it("throws BookmarkModalLoadError when tags endpoint returns non-OK", async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ items: [], total: 0, page: 1, pageSize: 100 }),
      })
      .mockResolvedValueOnce({ ok: false, status: 403 });

    try {
      await loadBookmarkModalOptions();
      expect.fail("Expected BookmarkModalLoadError to be thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(BookmarkModalLoadError);
      expect((error as BookmarkModalLoadError).message).toMatch(/Failed to load tags/);
    }
  });

  it("throws BookmarkModalLoadError when both endpoints return non-OK", async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 401 });

    try {
      await loadBookmarkModalOptions();
      expect.fail("Expected BookmarkModalLoadError to be thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(BookmarkModalLoadError);
    }
  });

  it("throws BookmarkModalLoadError when folders response has unexpected shape", async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve("<html><body>Error</body></html>"),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ items: [], total: 0, page: 1, pageSize: 100 }),
      });

    try {
      await loadBookmarkModalOptions();
      expect.fail("Expected BookmarkModalLoadError to be thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(BookmarkModalLoadError);
      expect((error as BookmarkModalLoadError).message).toMatch(/Unexpected response shape when loading folders/);
    }
  });

  it("throws BookmarkModalLoadError when tags response has unexpected shape", async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ items: [], total: 0, page: 1, pageSize: 100 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve("not json"),
      });

    try {
      await loadBookmarkModalOptions();
      expect.fail("Expected BookmarkModalLoadError to be thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(BookmarkModalLoadError);
      expect((error as BookmarkModalLoadError).message).toMatch(/Unexpected response shape when loading tags/);
    }
  });

  it("throws BookmarkModalLoadError when folders items are missing required fields", async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ items: [{ id: "f-1" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ items: [], total: 0, page: 1, pageSize: 100 }),
      });

    try {
      await loadBookmarkModalOptions();
      expect.fail("Expected BookmarkModalLoadError to be thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(BookmarkModalLoadError);
      expect((error as BookmarkModalLoadError).message).toMatch(/Unexpected response shape when loading folders/);
    }
  });

  it("propagates network errors", async () => {
    globalThis.fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ items: [], total: 0, page: 1, pageSize: 100 }),
      });

    await expect(loadBookmarkModalOptions()).rejects.toThrow(TypeError);
  });
});
