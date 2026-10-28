import { FakeEgress } from "@slugbase/testing-ports";
import { describe, expect, it } from "vitest";
import { lookupPageMetadata, type CachedPageMetadata, type PageMetadata, type PageMetadataCache, type PageMetadataLookupDependencies } from "../../src/index.ts";

// The synchronous metadata lookup (doc 02 section 5.4, doc 10 T6 and T13): the URL is judged as a bookmark's URL is before anything is read or
// requested; a successful cached result is served without a request; a target the port refuses is `blocked` and any other failure `failed`, and
// neither is cached; a successful fetch is cached under the canonical URL; and the fetch gets only what is left of the budget.

const PAGE = new TextEncoder().encode(
  '<html lang="en"><head><title>Docs</title><meta property="og:description" content="The docs"><meta property="og:site_name" content="Example"></head></html>',
);
const FETCHED: PageMetadata = { title: "Docs", description: "The docs", siteName: "Example", canonicalUrl: null, language: "en" };
const CANONICAL = "https://example.test/docs";

function memoryCache(rows: Record<string, CachedPageMetadata> = {}): PageMetadataCache & {
  readonly rows: Map<string, CachedPageMetadata>;
  readonly reads: string[];
  readonly writes: { readonly url: string; readonly page: PageMetadata }[];
} {
  const map = new Map(Object.entries(rows));
  const reads: string[] = [];
  const writes: { readonly url: string; readonly page: PageMetadata }[] = [];
  return {
    rows: map,
    reads,
    writes,
    read: (url) => {
      reads.push(url);
      return Promise.resolve(map.get(url));
    },
    write: (url, page) => {
      writes.push({ url, page });
      map.set(url, { status: "ok", ...page });
      return Promise.resolve();
    },
  };
}

function lookup(
  egress: FakeEgress,
  cache: PageMetadataCache,
  url: string,
  options: { readonly budgetMs?: number; readonly now?: () => number } = {},
) {
  const dependencies: PageMetadataLookupDependencies = { egress, cache, budgetMs: options.budgetMs ?? 3_000, now: options.now ?? (() => 0) };
  return lookupPageMetadata(dependencies, url);
}

describe("lookupPageMetadata", () => {
  it("fetches the canonical URL, answers what the page says and caches it for that URL", async () => {
    const egress = new FakeEgress({ [CANONICAL]: { contentType: "text/html; charset=utf-8", body: PAGE } });
    const cache = memoryCache();

    const outcome = await lookup(egress, cache, "  HTTPS://user:pw@Example.test/docs/?utm_source=x#top ");

    expect(outcome).toEqual({ kind: "found", page: FETCHED, cached: false });
    expect(egress.fetched).toEqual([CANONICAL]);
    expect(cache.writes).toEqual([{ url: CANONICAL, page: FETCHED }]);
  });

  it("answers an unexpired successful result from the cache without a request", async () => {
    const egress = new FakeEgress();
    const cache = memoryCache({ [CANONICAL]: { status: "ok", ...FETCHED } });

    expect(await lookup(egress, cache, "https://example.test/docs")).toEqual({ kind: "found", page: FETCHED, cached: true });
    expect(egress.requests).toEqual([]);
    expect(cache.writes).toEqual([]);
  });

  it.each(["failed", "blocked"] as const)("does not serve a stored %s result: the page is fetched again and the result replaces it", async (status) => {
    const egress = new FakeEgress({ [CANONICAL]: { contentType: "text/html", body: PAGE } });
    const cache = memoryCache({ [CANONICAL]: { status, title: null, description: null, siteName: null, canonicalUrl: null, language: null } });

    expect(await lookup(egress, cache, CANONICAL)).toEqual({ kind: "found", page: FETCHED, cached: false });
    expect(egress.fetched).toEqual([CANONICAL]);
    expect(cache.rows.get(CANONICAL)).toEqual({ status: "ok", ...FETCHED });
  });

  it.each([
    ["javascript:alert(1)", "not_http"],
    ["data:text/html,<script>1</script>", "not_http"],
    ["file:///etc/passwd", "not_http"],
    ["//example.test/docs", "not_http"],
    ["ftp://example.test/", "not_http"],
    ["", "empty"],
    ["   ", "empty"],
    ["https://", "malformed"],
    [`https://example.test/${"a".repeat(2100)}`, "too_long"],
  ] as const)("refuses %j as %s before the cache is read or anything is requested", async (url, reason) => {
    const egress = new FakeEgress();
    const cache = memoryCache();

    expect(await lookup(egress, cache, url)).toEqual({ kind: "url_refused", reason });
    expect(egress.requests).toEqual([]);
    expect(cache.reads).toEqual([]);
  });

  it.each([
    ["the metadata address", "http://169.254.169.254/latest/meta-data/"],
    ["a loopback address", "http://127.0.0.1:8080/"],
    ["a private address", "http://10.0.0.5/"],
    ["a carrier-grade NAT address", "http://100.64.0.1/"],
    ["the mapped metadata address", "http://[::ffff:169.254.169.254]/"],
    ["a link-local IPv6 address", "http://[fe80::1]/"],
  ])("answers blocked for %s and caches nothing", async (_name, url) => {
    const egress = new FakeEgress();
    const cache = memoryCache();

    expect(await lookup(egress, cache, url)).toEqual({ kind: "blocked" });
    expect(egress.fetched).toEqual([]);
    expect(cache.writes).toEqual([]);
  });

  it("answers blocked for a public page that redirects to the metadata address, and requests nothing from it", async () => {
    const egress = new FakeEgress({ [CANONICAL]: { kind: "redirect", to: "http://169.254.169.254/latest/meta-data/" } });
    const cache = memoryCache();

    expect(await lookup(egress, cache, CANONICAL)).toEqual({ kind: "blocked" });
    expect(egress.fetched).toEqual([CANONICAL]);
    expect(cache.writes).toEqual([]);
  });

  it.each([
    ["a status outside 2xx", { status: 500, contentType: "text/html", body: PAGE }],
    ["a page of another type", { contentType: "application/json", body: PAGE }],
    ["a response with no type", { body: PAGE }],
    ["a timeout", { kind: "timeout" as const }],
    ["a type the parser does not read, with parameters", { contentType: "text/plain; charset=utf-8", body: PAGE }],
  ])("answers failed for %s and caches nothing", async (_name, route) => {
    const egress = new FakeEgress({ [CANONICAL]: route });
    const cache = memoryCache();

    const outcome = await lookup(egress, cache, CANONICAL);

    expect(outcome.kind).toBe("failed");
    expect(cache.writes).toEqual([]);
  });

  it("answers a page that names nothing with every field null, and caches that", async () => {
    const egress = new FakeEgress({ [CANONICAL]: { contentType: "text/html", body: new TextEncoder().encode("<html><body>Hello</body></html>") } });
    const cache = memoryCache();

    const outcome = await lookup(egress, cache, CANONICAL);

    expect(outcome).toEqual({ kind: "found", page: { title: null, description: null, siteName: null, canonicalUrl: null, language: null }, cached: false });
    expect(cache.writes).toHaveLength(1);
  });

  it("answers failed when the egress adapter throws something it did not classify", async () => {
    const cache = memoryCache();

    expect(await lookup(new FakeEgress(), cache, CANONICAL)).toEqual({ kind: "failed" });
    expect(cache.writes).toEqual([]);
  });

  it("gives the fetch what is left of the budget after the cache read, and the page's size and type limits", async () => {
    const egress = new FakeEgress({ [CANONICAL]: { contentType: "text/html", body: PAGE } });
    let clock = 1_000;
    const cache: PageMetadataCache = {
      read: () => {
        clock += 1_250;
        return Promise.resolve(undefined);
      },
      write: () => Promise.resolve(),
    };

    await lookup(egress, cache, CANONICAL, { budgetMs: 3_000, now: () => clock });

    expect(egress.requests).toHaveLength(1);
    expect(egress.requests[0]).toMatchObject({ timeoutMs: 1_750, maxBytes: 512 * 1024, truncateAtMaxBytes: true, acceptContentTypes: ["text/html", "application/xhtml+xml"] });
  });

  it("fails without a request when the cache read used up the budget", async () => {
    const egress = new FakeEgress({ [CANONICAL]: { contentType: "text/html", body: PAGE } });
    let clock = 0;
    const cache: PageMetadataCache = {
      read: () => {
        clock += 3_000;
        return Promise.resolve(undefined);
      },
      write: () => Promise.resolve(),
    };

    expect(await lookup(egress, cache, CANONICAL, { budgetMs: 3_000, now: () => clock })).toEqual({ kind: "failed" });
    expect(egress.requests).toEqual([]);
  });

  it("rejects when the cache cannot be written, instead of answering as if it were", async () => {
    const egress = new FakeEgress({ [CANONICAL]: { contentType: "text/html", body: PAGE } });
    const cache: PageMetadataCache = { read: () => Promise.resolve(undefined), write: () => Promise.reject(new Error("write failed")) };

    await expect(lookup(egress, cache, CANONICAL)).rejects.toThrow("write failed");
  });
});
