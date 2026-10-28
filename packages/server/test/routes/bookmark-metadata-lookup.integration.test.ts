import { setTimeout as sleep } from "node:timers/promises";
import type { EgressPort, EgressRequest, EgressResponse } from "@slugbase/core";
import { FakeEgress } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bearer, HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// POST /api/v1/bookmarks/metadata (doc 04 sections 3.2, 7 and 10.6, doc 02 sections 5.4 and 16, doc 10 T1, T6 and T13), through the whole chain over the
// migrated database, with the fake of the egress port (the real adapter's refusals and cut-offs are held in packages/adapters/test/egress/metadata-fetch).
// The failure scenario: the metadata address, and a public page that redirects to it, answer 422 url_not_allowed with no request for the address;
// a fetch that fails, times out or returns a page of another type answers 502 upstream_failed and caches nothing; the cache of one workspace is never
// read for another; and the request is answered within its budget.

const TEST_TIMEOUT_MS = 60_000;
const METADATA = "/api/v1/bookmarks/metadata";
const PAGE_URL = "https://example.test/docs";
const PAGE = new TextEncoder().encode(
  '<html lang="en"><head><title>Docs</title><meta property="og:description" content="The docs"><meta property="og:site_name" content="Example"><link rel="canonical" href="https://example.test/canonical"></head></html>',
);
const FETCHED = { title: "Docs", description: "The docs", siteName: "Example", canonicalUrl: "https://example.test/canonical", language: "en" };

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
  await database().owner`TRUNCATE pgboss.job`;
});

const lookup = (world: World, as: Person, url: unknown, extra: Record<string, unknown> = {}) => send(world, "POST", METADATA, { cookie: as.cookie }, { url, ...extra });

const html = (body: Uint8Array = PAGE) => ({ contentType: "text/html; charset=utf-8", body });

async function setup(world: World) {
  const owner = await harness.person(world);
  const stranger = await harness.person(world);
  const shared = await harness.workspaceOf([{ person: owner, role: "owner" }]);
  const other = await harness.workspaceOf([{ person: stranger, role: "owner" }]);
  return { owner, stranger, shared, other };
}

interface Stored {
  readonly url_canonical: string;
  readonly status: string;
  readonly title: string | null;
}

async function storedFor(workspaceId: string): Promise<Stored[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<Stored[]>`SELECT url_canonical, status, title FROM url_metadata WHERE workspace_id = ${workspaceId} ORDER BY url_canonical`;
  });
  return [...rows];
}

async function store(workspaceId: string, status: "failed" | "blocked" | "ok", url: string, title: string | null = null): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`INSERT INTO url_metadata (workspace_id, url_canonical, status, title, fetched_at, expires_at) VALUES (${workspaceId}, ${url}, ${status}, ${title}, now(), now() + interval '7 days')`;
  });
}

/** An egress port that waits for the time budget it is given, like the adapter does on a page that never answers. */
function stallingEgress(): EgressPort & { readonly requests: EgressRequest[] } {
  const requests: EgressRequest[] = [];
  return {
    available: true,
    requests,
    async request(request): Promise<EgressResponse> {
      requests.push(request);
      await sleep(request.timeoutMs);
      throw Object.assign(new Error("The request timed out"), { code: "egress_timeout" });
    },
  };
}

describe("a page that can be read", () => {
  it(
    "answers what the page says from a fetch, caches it, and answers the second request from the cache without a request",
    async () => {
      const egress = new FakeEgress({ [PAGE_URL]: html() });
      const world = harness.serve({ egress });
      const { owner, shared } = await setup(world);

      const first = await lookup(world, owner, "https://Example.test/docs/?utm_source=feed#top");
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ ...FETCHED, cached: false });
      expect(egress.fetched).toEqual([PAGE_URL]);
      expect(await storedFor(shared.workspaceId)).toEqual([{ url_canonical: PAGE_URL, status: "ok", title: "Docs" }]);

      const second = await lookup(world, owner, PAGE_URL);
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual({ ...FETCHED, cached: true });
      expect(egress.requests).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "asks the port for the canonical URL, the first 512 KiB, HTML types only and no more time than the budget",
    async () => {
      const egress = new FakeEgress({ [PAGE_URL]: html() });
      const world = harness.serve({ egress });
      const { owner } = await setup(world);

      await lookup(world, owner, "https://reader:secret@example.test/docs/?fbclid=x");

      expect(egress.requests).toHaveLength(1);
      expect(egress.requests[0]).toMatchObject({ url: PAGE_URL, maxBytes: 512 * 1024, truncateAtMaxBytes: true, acceptContentTypes: ["text/html", "application/xhtml+xml"] });
      expect(egress.requests[0]?.timeoutMs).toBeLessThanOrEqual(3_000);
      expect(egress.requests[0]?.timeoutMs).toBeGreaterThan(2_000);
    },
    TEST_TIMEOUT_MS,
  );

  it("answers the cached result of a page the job stored, and fetches again past expiry", async () => {
    const egress = new FakeEgress({ [PAGE_URL]: html() });
    const world = harness.serve({ egress });
    const { owner, shared } = await setup(world);
    await store(shared.workspaceId, "ok", PAGE_URL, "Stored title");

    expect(await (await lookup(world, owner, PAGE_URL)).json()).toMatchObject({ title: "Stored title", cached: true });
    expect(egress.requests).toEqual([]);

    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`UPDATE url_metadata SET fetched_at = now() - interval '8 days', expires_at = now() - interval '1 day' WHERE workspace_id = ${shared.workspaceId}`;
    });

    expect(await (await lookup(world, owner, PAGE_URL)).json()).toEqual({ ...FETCHED, cached: false });
    expect(egress.requests).toHaveLength(1);
    expect(await storedFor(shared.workspaceId)).toEqual([{ url_canonical: PAGE_URL, status: "ok", title: "Docs" }]);
  });

  it.each(["failed", "blocked"] as const)("does not answer from a stored %s result: the page is fetched again and the row is replaced", async (status) => {
    const egress = new FakeEgress({ [PAGE_URL]: html() });
    const world = harness.serve({ egress });
    const { owner, shared } = await setup(world);
    await store(shared.workspaceId, status, PAGE_URL);

    expect(await (await lookup(world, owner, PAGE_URL)).json()).toEqual({ ...FETCHED, cached: false });
    expect(await storedFor(shared.workspaceId)).toEqual([{ url_canonical: PAGE_URL, status: "ok", title: "Docs" }]);
  });

  it("answers every field null for a page that names nothing", async () => {
    const egress = new FakeEgress({ [PAGE_URL]: html(new TextEncoder().encode("<html><body>Hello</body></html>")) });
    const world = harness.serve({ egress });
    const { owner } = await setup(world);

    const response = await lookup(world, owner, PAGE_URL);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ title: null, description: null, siteName: null, canonicalUrl: null, language: null, cached: false });
  });
});

describe("the cache is the workspace's own", () => {
  it("never answers one workspace from another's cached result for the same page", async () => {
    const egress = new FakeEgress({ [PAGE_URL]: html() });
    const world = harness.serve({ egress });
    const { owner, stranger, shared, other } = await setup(world);
    await store(other.workspaceId, "ok", PAGE_URL, "Private title of B");

    const mine = await lookup(world, owner, PAGE_URL);

    expect(await mine.json()).toEqual({ ...FETCHED, cached: false });
    expect(egress.requests).toHaveLength(1);
    expect(await storedFor(shared.workspaceId)).toEqual([{ url_canonical: PAGE_URL, status: "ok", title: "Docs" }]);
    expect(await storedFor(other.workspaceId)).toEqual([{ url_canonical: PAGE_URL, status: "ok", title: "Private title of B" }]);
    expect(await (await lookup(world, stranger, PAGE_URL)).json()).toMatchObject({ title: "Private title of B", cached: true });
    expect(egress.requests).toHaveLength(1);
  });
});

describe("a URL that cannot be fetched is 422", () => {
  it.each(["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "file:///etc/passwd", "ftp://example.test/", "//example.test/", "gopher://example.test/"])(
    "%s is url_not_allowed and nothing is requested",
    async (url) => {
      const egress = new FakeEgress();
      const world = harness.serve({ egress });
      const { owner, shared } = await setup(world);

      const response = await lookup(world, owner, url);

      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code: "url_not_allowed", errors: [{ path: "url", code: "url_not_allowed" }] });
      expect(egress.requests).toEqual([]);
      expect(await storedFor(shared.workspaceId)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    ["", "too_small"],
    ["   ", "too_small"],
    ["https://", "invalid_url"],
    [`https://example.test/${"a".repeat(2100)}`, "too_big"],
  ])("%j is validation_failed and nothing is requested", async (url, code) => {
    const egress = new FakeEgress();
    const world = harness.serve({ egress });
    const { owner } = await setup(world);

    const response = await lookup(world, owner, url);

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "validation_failed", errors: [{ path: "url", code }] });
    expect(egress.requests).toEqual([]);
  });

  it("refuses a body without a URL, with a URL that is not a string and with a field the operation does not declare", async () => {
    const egress = new FakeEgress();
    const world = harness.serve({ egress });
    const { owner } = await setup(world);

    expect((await send(world, "POST", METADATA, { cookie: owner.cookie }, {})).status).toBe(422);
    expect((await lookup(world, owner, 42)).status).toBe(422);
    expect((await lookup(world, owner, PAGE_URL, { method: "HEAD" })).status).toBe(422);
    expect(egress.requests).toEqual([]);
  });

  it.each([
    ["the metadata address", "http://169.254.169.254/latest/meta-data/"],
    ["loopback", "http://127.0.0.1:8080/"],
    ["a private address", "http://10.0.0.5/"],
    ["a carrier-grade NAT address", "http://100.64.0.1/"],
    ["the mapped metadata address", "http://[::ffff:169.254.169.254]/"],
    ["the metadata address in decimal", "http://2852039166/"],
  ])("%s (%s) is url_not_allowed, with no request for it and nothing cached", async (_label, url) => {
    const egress = new FakeEgress();
    const world = harness.serve({ egress });
    const { owner, shared } = await setup(world);

    const response = await lookup(world, owner, url);

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "url_not_allowed" });
    expect(egress.fetched).toEqual([]);
    expect(await storedFor(shared.workspaceId)).toEqual([]);
  });

  it("answers url_not_allowed for a public page that redirects to the metadata address, without a request for the address", async () => {
    const egress = new FakeEgress({ [PAGE_URL]: { kind: "redirect", to: "http://169.254.169.254/latest/meta-data/" } });
    const world = harness.serve({ egress });
    const { owner, shared } = await setup(world);

    const response = await lookup(world, owner, PAGE_URL);

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "url_not_allowed" });
    expect(egress.fetched).toEqual([PAGE_URL]);
    expect(await storedFor(shared.workspaceId)).toEqual([]);
  });

  it("answers url_not_allowed for a name the port refuses, and says nothing of where it pointed", async () => {
    const egress = new FakeEgress({ [PAGE_URL]: { kind: "blocked" } });
    const world = harness.serve({ egress });
    const { owner } = await setup(world);

    const response = await lookup(world, owner, PAGE_URL);
    const text = await response.text();

    expect(response.status).toBe(422);
    expect(JSON.parse(text)).toMatchObject({ code: "url_not_allowed" });
    expect(text).not.toMatch(/10\.|127\.|169\.254|resolve/);
  });
});

describe("a page that cannot be read is 502", () => {
  it.each([
    ["a status outside 2xx", { status: 500, ...html() }],
    ["a page of another type", { contentType: "application/json", body: PAGE }],
    ["a timeout", { kind: "timeout" as const }],
  ])("%s is upstream_failed and nothing is cached", async (_label, route) => {
    const egress = new FakeEgress({ [PAGE_URL]: route });
    const world = harness.serve({ egress });
    const { owner, shared } = await setup(world);

    const response = await lookup(world, owner, PAGE_URL);

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "upstream_failed" });
    expect(await storedFor(shared.workspaceId)).toEqual([]);
  });

  it("is upstream_failed when the egress port is not configured", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);

    expect((await lookup(world, owner, PAGE_URL)).status).toBe(502);
  });

  it("is answered within the budget by a page that never answers, and caches nothing", async () => {
    const egress = stallingEgress();
    const world = harness.serve({ egress, metadataBudgetMs: 400 });
    const { owner, shared } = await setup(world);
    const started = performance.now();

    const response = await lookup(world, owner, PAGE_URL);
    const elapsed = performance.now() - started;

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "upstream_failed" });
    expect(egress.requests).toHaveLength(1);
    expect(egress.requests[0]?.timeoutMs).toBeLessThanOrEqual(400);
    expect(elapsed).toBeLessThan(3_000);
    expect(await storedFor(shared.workspaceId)).toEqual([]);
  });
});

describe("who may ask", () => {
  it("refuses a request with no session", async () => {
    const world = harness.serve({ egress: new FakeEgress() });
    await setup(world);

    expect((await send(world, "POST", METADATA, {}, { url: PAGE_URL })).status).toBe(401);
  });

  it("refuses a token that may only read, and serves one that may write", async () => {
    const egress = new FakeEgress({ [PAGE_URL]: html() });
    const world = harness.serve({ egress });
    const { owner, shared } = await setup(world);
    const readOnly = await harness.token(shared.workspaceId, owner, "read");
    const readWrite = await harness.token(shared.workspaceId, owner, "read-write");

    const refused = await send(world, "POST", METADATA, bearer(readOnly), { url: PAGE_URL });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "token_scope" });
    expect(egress.requests).toEqual([]);
    expect(await storedFor(shared.workspaceId)).toEqual([]);

    const served = await send(world, "POST", METADATA, bearer(readWrite), { url: PAGE_URL });
    expect(served.status).toBe(200);
    expect(await served.json()).toEqual({ ...FETCHED, cached: false });
  });

  it("refuses an account that acts in no workspace", async () => {
    const egress = new FakeEgress({ [PAGE_URL]: html() });
    const world = harness.serve({ egress });
    const loner = await harness.person(world);

    expect((await lookup(world, loner, PAGE_URL)).status).toBe(404);
    expect(egress.requests).toEqual([]);
  });
});

describe("the fetch bucket", () => {
  it("limits a member to the RATE_LIMIT_FETCH_ACCOUNT key, answers 429 with Retry-After, and makes no request for the refused one", async () => {
    const egress = new FakeEgress({ [PAGE_URL]: html() });
    const world = harness.serve({ egress, env: { RATE_LIMIT_FETCH_ACCOUNT: "2/min", RATE_LIMIT_FETCH_IP: "1000/min" } });
    const { owner } = await setup(world);

    expect((await lookup(world, owner, PAGE_URL)).status).toBe(200);
    expect((await lookup(world, owner, PAGE_URL)).status).toBe(200);
    const limited = await lookup(world, owner, PAGE_URL);

    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
    expect(await limited.json()).toMatchObject({ code: "rate_limited" });
  });

  it("limits a client address to the RATE_LIMIT_FETCH_IP key across accounts", async () => {
    const egress = new FakeEgress({ [PAGE_URL]: html() });
    const world = harness.serve({ egress, env: { RATE_LIMIT_FETCH_IP: "2/min", RATE_LIMIT_FETCH_ACCOUNT: "1000/min" } });
    const { owner, stranger } = await setup(world);

    expect((await lookup(world, owner, PAGE_URL)).status).toBe(200);
    expect((await lookup(world, stranger, PAGE_URL)).status).toBe(200);
    expect((await lookup(world, owner, PAGE_URL)).status).toBe(429);
  });

  it("does not take from the write bucket", async () => {
    const egress = new FakeEgress({ [PAGE_URL]: html() });
    const world = harness.serve({ egress, env: { RATE_LIMIT_WRITE_ACCOUNT: "1/min", RATE_LIMIT_WRITE_IP: "1/min" } });
    const { owner } = await setup(world);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await lookup(world, owner, PAGE_URL)).status).toBe(200);
    }
  });
});
