import { describe, expect, it, vi } from "vitest";

import {
  FetchBlockedError,
  FetchSizeLimitError,
  FetchTimeoutError,
} from "./fetch.errors.js";
import { FetchService, type HttpExecutor } from "./fetch.service.js";

const publicLookup = () =>
  Promise.resolve([{ address: "93.184.216.34", family: 4 }] as const);

function createMockResponse(
  body: Uint8Array,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: init.headers,
  });
}

describe("FetchService", () => {
  it("blocks private IP targets before outbound fetch", async () => {
    const httpExecutor = vi.fn<HttpExecutor>();
    const service = new FetchService({ httpExecutor });

    await expect(service.get("http://192.168.0.10/resource")).rejects.toBeInstanceOf(
      FetchBlockedError,
    );
    expect(httpExecutor).not.toHaveBeenCalled();
  });

  it("blocks loopback hostnames before outbound fetch", async () => {
    const httpExecutor = vi.fn<HttpExecutor>();
    const service = new FetchService({ httpExecutor });

    await expect(service.get("http://localhost/admin")).rejects.toBeInstanceOf(
      FetchBlockedError,
    );
    expect(httpExecutor).not.toHaveBeenCalled();
  });

  it("blocks hosts that resolve to private addresses", async () => {
    const httpExecutor = vi.fn<HttpExecutor>();
    const service = new FetchService({
      httpExecutor,
      lookup: () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]),
    });

    await expect(service.get("http://evil.example/resource")).rejects.toBeInstanceOf(
      FetchBlockedError,
    );
    expect(httpExecutor).not.toHaveBeenCalled();
  });

  it("enforces the configured timeout", async () => {
    vi.useFakeTimers();

    try {
      const httpExecutor: HttpExecutor = (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });

      const service = new FetchService({
        httpExecutor,
        lookup: publicLookup,
        timeoutMs: 50,
      });

      const assertion = expect(
        service.get("https://example.com/slow"),
      ).rejects.toBeInstanceOf(FetchTimeoutError);
      await vi.advanceTimersByTimeAsync(50);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces the response size cap", async () => {
    const oversized = new Uint8Array(32);
    const httpExecutor: HttpExecutor = () =>
      Promise.resolve(createMockResponse(oversized));
    const service = new FetchService({
      httpExecutor,
      lookup: publicLookup,
      maxResponseBytes: 16,
    });

    await expect(service.get("https://example.com/large")).rejects.toBeInstanceOf(
      FetchSizeLimitError,
    );
  });

  it("caches successful GET responses", async () => {
    const body = new TextEncoder().encode("cached-body");
    const httpExecutor = vi
      .fn<HttpExecutor>()
      .mockResolvedValue(createMockResponse(body, { status: 200 }));

    const service = new FetchService({
      httpExecutor,
      lookup: publicLookup,
      cacheTtlMs: 60_000,
    });

    const first = await service.get("https://example.com/page");
    const second = await service.get("https://example.com/page");

    expect(httpExecutor).toHaveBeenCalledTimes(1);
    expect(first.body).toEqual(body);
    expect(second.body).toEqual(body);
  });

  it("bypasses cache when skipCache is true", async () => {
    const httpExecutor = vi.fn<HttpExecutor>().mockImplementation(() =>
      Promise.resolve(createMockResponse(new Uint8Array([1]), { status: 200 })),
    );

    const service = new FetchService({
      httpExecutor,
      lookup: publicLookup,
      cacheTtlMs: 60_000,
    });

    await service.get("https://example.com/page");
    await service.get("https://example.com/page", { skipCache: true });

    expect(httpExecutor).toHaveBeenCalledTimes(2);
  });
});
