import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BookmarkModalLoadError,
  loadBookmarkModalOptions,
} from "./bookmark-modal-api.js";

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

  it("uses direct API paths when VITE_API_URL is set", async () => {
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
      "https://api.example.com/folders?pageSize=100",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      "https://api.example.com/tags?pageSize=100",
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
