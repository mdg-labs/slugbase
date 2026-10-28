import { randomUUID } from "node:crypto";
import { EgressTooLarge, type EgressPort } from "@slugbase/core";
import { FakeEgress, type FakeEgressRoute } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.ts";
import type { ModuleContext } from "../../src/create-server.ts";
import { fetchMetadataJob } from "../../src/worker/jobs/fetch-metadata.ts";
import { productionEnv } from "../config/support.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { adapters, recordingLogger } from "../support.ts";
import { HOOK_TIMEOUT_MS, workspaceHarness, type World } from "../workspaces/support.ts";

// The bookmark.fetchMetadata job against the database and a scripted egress port (doc 02 section 5.4, doc 01 section 8.1, doc 08 section 3.1,
// doc 10 T6, T13 and section 5). The failure scenario of T13: pages that try to hurt the parser or the page that shows its result (a head of 10 MB,
// tags that are never closed, a flood of nested meta tags, an entity bomb, NUL bytes, a body that is not HTML, a title that is an HTML payload)
// all end as bounded plain text or a `failed` row, and nothing is executed or followed: the only address the port is asked for is the bookmark's own
// canonical URL, whatever the page names. The cache is the workspace's: the same page saved in two workspaces is fetched and stored for each. The job
// never changes a bookmark and fetches nothing it has a current result for.

const database = useTestDatabase();
const harness = workspaceHarness(database);
const TEST_TIMEOUT_MS = 60_000;
const MAX_BYTES = 512 * 1024;
const HTML = "text/html; charset=utf-8";
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
});

interface Placed {
  readonly workspaceId: string;
  readonly accountId: string;
}

async function workspace(world: World): Promise<Placed> {
  const owner = await harness.person(world);
  const { workspaceId } = await harness.workspaceOf([{ person: owner, role: "owner" }]);
  return { workspaceId, accountId: owner.account.id };
}

async function bookmarkIn(placed: Placed, options: { readonly url: string; readonly canonical: string; readonly archived?: boolean }): Promise<string> {
  const id = randomUUID();
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, description, plan_archived_at)
      VALUES (${id}, ${placed.workspaceId}, ${placed.accountId}, ${options.url}, ${options.canonical}, 'example.test', 'As entered', 'As entered too',
              ${options.archived === true ? new Date() : null})`;
  });
  return id;
}

interface Result {
  readonly url_canonical: string;
  readonly status: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly site_name: string | null;
  readonly canonical_url: string | null;
  readonly language: string | null;
  readonly fetched_at: Date;
  readonly expires_at: Date;
}

async function resultsOf(workspaceId: string): Promise<Result[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<Result[]>`SELECT url_canonical, status, title, description, site_name, canonical_url, language, fetched_at, expires_at FROM url_metadata WHERE workspace_id = ${workspaceId} ORDER BY url_canonical`;
  });
  return [...rows];
}

async function bookmarkRows(workspaceId: string): Promise<string[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ row: string }[]>`SELECT b::text AS row FROM bookmarks b WHERE workspace_id = ${workspaceId} ORDER BY id`;
  });
  return rows.map((row) => row.row);
}

function contextWith(egress: EgressPort, logger = recordingLogger()): { context: ModuleContext; logger: ReturnType<typeof recordingLogger> } {
  const config = loadConfig("worker", { ...productionEnv(), NODE_ENV: "test", DATABASE_URL: appUrl(database()) }).config;
  const tenants = tenantDatabase(database());
  return { context: { config, logger, adapters: { ...adapters(), egress }, withTenant: tenants.withTenant.bind(tenants) }, logger };
}

/** Runs the job once, as the worker hands it over. */
function run(placed: Placed, bookmarkId: string, egress: EgressPort): Promise<void> {
  return fetchMetadataJob.handle({ bookmarkId, workspaceId: placed.workspaceId, accountId: placed.accountId }, contextWith(egress).context);
}

const PAGE = "https://example.test/articles/one";
const route = (body: string | Uint8Array, contentType = HTML): FakeEgressRoute => ({ contentType, body: typeof body === "string" ? encode(body) : body });

describe("the job fetches the page of a bookmark and caches what it says", () => {
  it(
    "asks the port for the canonical URL only, reads at most 512 KiB of html, and stores the fields for the workspace for seven days without changing the bookmark",
    async () => {
      const world = harness.serve();
      const a = await workspace(world);
      const id = await bookmarkIn(a, { url: "https://reader:secret@example.test/articles/one/?utm_source=feed&b=2&a=1#section", canonical: "https://example.test/articles/one?a=1&b=2" });
      const egress = new FakeEgress({
        "https://example.test/articles/one?a=1&b=2": route(`<!doctype html><html lang="en"><head><title>Fallback</title>
          <meta property="og:title" content="One &amp; only"><meta name="description" content="About &lt;one&gt;">
          <meta property="og:site_name" content="Example"><link rel="canonical" href="/articles/1"></head></html>`),
      });
      const before = await bookmarkRows(a.workspaceId);

      await run(a, id, egress);

      expect(egress.requests).toHaveLength(1);
      expect(egress.requests[0]).toMatchObject({
        url: "https://example.test/articles/one?a=1&b=2",
        maxBytes: MAX_BYTES,
        truncateAtMaxBytes: true,
        acceptContentTypes: ["text/html", "application/xhtml+xml"],
        timeoutMs: 10_000,
      });
      expect(egress.requests[0]?.method ?? "GET").toBe("GET");
      expect(JSON.stringify(egress.requests[0]?.headers ?? {})).not.toMatch(/cookie|authorization/i);
      const [result, ...others] = await resultsOf(a.workspaceId);
      expect(others).toEqual([]);
      expect(result).toMatchObject({
        url_canonical: "https://example.test/articles/one?a=1&b=2",
        status: "ok",
        title: "One & only",
        description: "About <one>",
        site_name: "Example",
        canonical_url: "https://example.test/articles/1",
        language: "en",
      });
      expect((result?.expires_at.getTime() ?? 0) - (result?.fetched_at.getTime() ?? 0)).toBe(7 * 24 * 3600 * 1000);
      expect(await bookmarkRows(a.workspaceId)).toEqual(before);
    },
    TEST_TIMEOUT_MS,
  );

  it("accepts application/xhtml+xml and follows the redirects of the port to the page", async () => {
    const world = harness.serve();
    const a = await workspace(world);
    const id = await bookmarkIn(a, { url: PAGE, canonical: PAGE });
    const egress = new FakeEgress({ [PAGE]: { kind: "redirect", to: "/moved" }, "https://example.test/moved": route("<title>Moved</title>", "application/xhtml+xml") });

    await run(a, id, egress);

    expect(await resultsOf(a.workspaceId)).toMatchObject([{ url_canonical: PAGE, status: "ok", title: "Moved" }]);
  });

  it("makes no request while the cached result has not expired, and fetches again once it has", async () => {
    const world = harness.serve();
    const a = await workspace(world);
    const id = await bookmarkIn(a, { url: PAGE, canonical: PAGE });
    const egress = new FakeEgress({ [PAGE]: route("<title>First</title>") });
    await run(a, id, egress);
    egress.script(PAGE, route("<title>Second</title>"));

    await run(a, id, egress);

    expect(egress.requests).toHaveLength(1);
    expect(await resultsOf(a.workspaceId)).toMatchObject([{ title: "First" }]);

    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`UPDATE url_metadata SET fetched_at = now() - interval '8 days', expires_at = now() - interval '1 day' WHERE workspace_id = ${a.workspaceId}`;
    });
    await run(a, id, egress);

    expect(egress.requests).toHaveLength(2);
    expect(await resultsOf(a.workspaceId)).toMatchObject([{ title: "Second", status: "ok" }]);
  });

  it("caches a failed result like any other, so a second run makes no request", async () => {
    const world = harness.serve();
    const a = await workspace(world);
    const id = await bookmarkIn(a, { url: PAGE, canonical: PAGE });
    const egress = new FakeEgress({ [PAGE]: { status: 500, contentType: "text/html", body: encode("<title>Error</title>") } });

    await run(a, id, egress);
    await run(a, id, egress);

    expect(egress.requests).toHaveLength(1);
    expect(await resultsOf(a.workspaceId)).toMatchObject([{ url_canonical: PAGE, status: "failed", title: null, description: null, site_name: null, canonical_url: null, language: null }]);
  });
});

describe("a fetch that does not end in a page", () => {
  const outcomes: [string, FakeEgressRoute, string][] = [
    ["a target the port refuses", { kind: "blocked" }, "blocked"],
    ["a redirect to the metadata address", { kind: "redirect", to: "http://169.254.169.254/latest/meta-data/" }, "blocked"],
    ["a timeout", { kind: "timeout" }, "failed"],
    ["a body that is not html", { contentType: "text/plain", body: encode("<title>Not html</title>") }, "failed"],
    ["a pdf", { contentType: "application/pdf", body: encode("%PDF-1.7") }, "failed"],
    ["a response without a content type", { body: encode("<title>None</title>") }, "failed"],
    ["a server error", { status: 503, contentType: "text/html", body: encode("<title>Down</title>") }, "failed"],
    ["a page that is not found", { status: 404, contentType: "text/html", body: encode("<title>Not found</title>") }, "failed"],
    ["a redirect loop", { kind: "redirect", to: PAGE }, "failed"],
  ];

  it.each(outcomes)("is recorded for %s as %s, without a field, and the job ends without an error", async (_name, scripted, status) => {
    const world = harness.serve();
    const a = await workspace(world);
    const id = await bookmarkIn(a, { url: PAGE, canonical: PAGE });
    const egress = new FakeEgress({ [PAGE]: scripted });
    const before = await bookmarkRows(a.workspaceId);

    await expect(run(a, id, egress)).resolves.toBeUndefined();

    expect(await resultsOf(a.workspaceId)).toMatchObject([{ url_canonical: PAGE, status, title: null, description: null, site_name: null, canonical_url: null, language: null }]);
    expect(await bookmarkRows(a.workspaceId)).toEqual(before);
  });

  it("is recorded as failed for any other error of the port, such as a body over the limit that the port refuses", async () => {
    const world = harness.serve();
    const a = await workspace(world);
    const id = await bookmarkIn(a, { url: PAGE, canonical: PAGE });
    const refusing: EgressPort = { available: true, request: () => Promise.reject(new EgressTooLarge()) };

    await run(a, id, refusing);

    expect(await resultsOf(a.workspaceId)).toMatchObject([{ status: "failed" }]);
  });
});

describe("pages that try to hurt the parser or the page that shows the result", () => {
  const FIELD_LIMITS = { title: 300, description: 1000, site_name: 100, canonical_url: 2048, language: 35 } as const;
  const hostile: [string, () => string | Uint8Array, string][] = [
    ["a head of 10 MB", () => `<html lang="en"><head>${'<meta name="x" content="y">'.repeat(400_000)}<title>Late</title></head>`, "ok"],
    ["a head of 10 MB that holds the title in its first bytes", () => `<title>Early</title>${'<meta name="x" content="y">'.repeat(400_000)}`, "ok"],
    ["tags that are never closed", () => "<title>Open<meta property=og:title content=\"never closed<a <a <a ".repeat(50_000), "ok"],
    ["a flood of nested meta tags", () => "<meta ".repeat(100_000) + '<meta property="og:title" content="Flood">'.repeat(100_000), "ok"],
    ["an entity bomb", () => `<title>${"&amp;".repeat(200_000)}&#x${"0".repeat(500)}41;</title>`, "ok"],
    ["NUL bytes", () => `<ti\u0000tle>A\u0000B</ti\u0000tle>${"\u0000".repeat(400_000)}`, "ok"],
    ["a title that is an HTML payload", () => "<title>&lt;img src=x onerror=alert(1)&gt;<img src=x onerror=alert(2)><script>alert(3)</script></title>", "ok"],
    ["a body of random bytes", () => Uint8Array.from({ length: 700_000 }, (_, index) => (index * 7919) % 256), "ok"],
  ];

  it.each(hostile)("ends %s as bounded plain text, and the port is asked for the bookmark's address and nothing else", async (_name, build, status) => {
    const world = harness.serve();
    const a = await workspace(world);
    const id = await bookmarkIn(a, { url: PAGE, canonical: PAGE });
    const egress = new FakeEgress({ [PAGE]: route(build()) });

    await run(a, id, egress);

    expect(egress.fetched).toEqual([PAGE]);
    const [result] = await resultsOf(a.workspaceId);
    expect(result?.status).toBe(status);
    for (const [field, limit] of Object.entries(FIELD_LIMITS)) {
      const value = result?.[field as keyof typeof FIELD_LIMITS];
      if (typeof value === "string") {
        expect(Array.from(value).length).toBeLessThanOrEqual(limit);
        expect(value).not.toMatch(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/);
      }
    }
  });

  it("keeps a title that holds an img tag as the text of a title", async () => {
    const world = harness.serve();
    const a = await workspace(world);
    const id = await bookmarkIn(a, { url: PAGE, canonical: PAGE });

    await run(a, id, new FakeEgress({ [PAGE]: route("<title>&lt;img src=x onerror=alert(1)&gt;</title>") }));

    expect(await resultsOf(a.workspaceId)).toMatchObject([{ status: "ok", title: "<img src=x onerror=alert(1)>" }]);
  });

  it("reads only the first 512 KiB of a page the port cuts, so a title after them is never stored", async () => {
    const world = harness.serve();
    const a = await workspace(world);
    const id = await bookmarkIn(a, { url: PAGE, canonical: PAGE });
    const egress = new FakeEgress({ [PAGE]: route(`${" ".repeat(MAX_BYTES + 10)}<title>Too late</title>`) });

    await run(a, id, egress);

    expect(await resultsOf(a.workspaceId)).toMatchObject([{ status: "ok", title: null }]);
  });

  it("stores the canonical link of a page as text and never asks the port for it", async () => {
    const world = harness.serve();
    const a = await workspace(world);
    const id = await bookmarkIn(a, { url: PAGE, canonical: PAGE });
    const egress = new FakeEgress({ [PAGE]: route('<link rel="canonical" href="http://169.254.169.254/latest/meta-data/"><link rel="icon" href="http://127.0.0.1/x.ico"><meta property="og:image" content="http://10.0.0.1/i.png">') });

    await run(a, id, egress);

    expect(egress.fetched).toEqual([PAGE]);
    expect(await resultsOf(a.workspaceId)).toMatchObject([{ canonical_url: "http://169.254.169.254/latest/meta-data/" }]);
  });
});

describe("what the job reads again when it runs", () => {
  it("does nothing for a bookmark that is archived, deleted or unknown, and writes no result", async () => {
    const world = harness.serve();
    const a = await workspace(world);
    const archived = await bookmarkIn(a, { url: PAGE, canonical: PAGE, archived: true });
    const egress = new FakeEgress({ [PAGE]: route("<title>Never</title>") });

    await run(a, archived, egress);
    await run(a, randomUUID(), egress);

    expect(egress.requests).toEqual([]);
    expect(await resultsOf(a.workspaceId)).toEqual([]);
  });

  it("judges a bookmark by the address it has now: a bookmark that was re-pointed is fetched at the new one", async () => {
    const world = harness.serve();
    const a = await workspace(world);
    const id = await bookmarkIn(a, { url: PAGE, canonical: PAGE });
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`UPDATE bookmarks SET url = 'https://example.test/new', url_canonical = 'https://example.test/new' WHERE id = ${id}`;
    });
    const egress = new FakeEgress({ [PAGE]: route("<title>Old</title>"), "https://example.test/new": route("<title>New</title>") });

    await run(a, id, egress);

    expect(egress.fetched).toEqual(["https://example.test/new"]);
    expect(await resultsOf(a.workspaceId)).toMatchObject([{ url_canonical: "https://example.test/new", title: "New" }]);
  });

  it("finds no bookmark of another workspace by its identifier, whatever the payload names", async () => {
    const world = harness.serve();
    const a = await workspace(world);
    const b = await workspace(world);
    const ofB = await bookmarkIn(b, { url: PAGE, canonical: PAGE });
    const egress = new FakeEgress({ [PAGE]: route("<title>Of B</title>") });

    await run(a, ofB, egress);
    await fetchMetadataJob.handle({ bookmarkId: ofB, workspaceId: a.workspaceId, accountId: b.accountId }, contextWith(egress).context).catch(() => undefined);

    expect(egress.requests).toEqual([]);
    expect(await resultsOf(a.workspaceId)).toEqual([]);
    expect(await resultsOf(b.workspaceId)).toEqual([]);
  });

  it("caches the same page for each workspace that saved it, and never serves one workspace the result of another", async () => {
    const world = harness.serve();
    const a = await workspace(world);
    const b = await workspace(world);
    const ofA = await bookmarkIn(a, { url: PAGE, canonical: PAGE });
    const ofB = await bookmarkIn(b, { url: PAGE, canonical: PAGE });
    const egress = new FakeEgress({ [PAGE]: route("<title>First</title>") });
    await run(a, ofA, egress);
    egress.script(PAGE, route("<title>Second</title>"));

    await run(b, ofB, egress);

    expect(egress.requests).toHaveLength(2);
    expect(await resultsOf(a.workspaceId)).toMatchObject([{ title: "First" }]);
    expect(await resultsOf(b.workspaceId)).toMatchObject([{ title: "Second" }]);
  });
});

describe("a failure that is the job's", () => {
  it("rejects, so the queue retries it, when the result cannot be written, and leaves no result behind", async () => {
    const world = harness.serve();
    const a = await workspace(world);
    const id = await bookmarkIn(a, { url: PAGE, canonical: PAGE });
    const egress = new FakeEgress({ [PAGE]: route("<title>Written</title>") });
    const { context } = contextWith(egress);
    let transactions = 0;
    const failing: ModuleContext = {
      ...context,
      withTenant: (tenant, work) => {
        transactions += 1;
        return transactions === 2 ? Promise.reject(new Error("the database refused the write")) : context.withTenant(tenant, work);
      },
    };

    await expect(fetchMetadataJob.handle({ bookmarkId: id, workspaceId: a.workspaceId, accountId: a.accountId }, failing)).rejects.toThrow("refused the write");

    expect(await resultsOf(a.workspaceId)).toEqual([]);
    await run(a, id, egress);
    expect(await resultsOf(a.workspaceId)).toMatchObject([{ status: "ok", title: "Written" }]);
  });

  it("holds no transaction open while the port answers", async () => {
    const world = harness.serve();
    const a = await workspace(world);
    const id = await bookmarkIn(a, { url: PAGE, canonical: PAGE });
    const { context } = contextWith(new FakeEgress());
    let open = 0;
    let openDuringRequest = -1;
    const egress: EgressPort = {
      available: true,
      request: () => {
        openDuringRequest = open;
        return Promise.resolve({ url: PAGE, status: 200, contentType: "text/html", body: encode("<title>Quick</title>") });
      },
    };
    const counting: ModuleContext = {
      ...context,
      adapters: { ...context.adapters, egress },
      withTenant: async (tenant, work) => {
        open += 1;
        try {
          return await context.withTenant(tenant, work);
        } finally {
          open -= 1;
        }
      },
    };

    await fetchMetadataJob.handle({ bookmarkId: id, workspaceId: a.workspaceId, accountId: a.accountId }, counting);

    expect(openDuringRequest).toBe(0);
  });

  it("refuses a payload that holds more than the three identifiers, or an identifier that is not one", () => {
    const ok = { bookmarkId: randomUUID(), workspaceId: randomUUID(), accountId: randomUUID() };

    expect(fetchMetadataJob.parse(ok)).toEqual(ok);
    expect(() => fetchMetadataJob.parse({ ...ok, url: "https://example.test/" })).toThrow();
    expect(() => fetchMetadataJob.parse({ ...ok, bookmarkId: "not a uuid" })).toThrow();
    expect(() => fetchMetadataJob.parse({ bookmarkId: ok.bookmarkId, workspaceId: ok.workspaceId })).toThrow();
  });
});
