import { randomUUID } from "node:crypto";
import { ImageRefused, PortUnavailable, unconfigured, type EgressPort, type ImageCodecPort, type ReencodedIcon } from "@slugbase/core";
import { FakeEgress, type FakeEgressRoute } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.ts";
import type { ModuleContext } from "../../src/create-server.ts";
import { fetchFaviconJob, queueFetchFavicon } from "../../src/worker/jobs/fetch-favicon.ts";
import { productionEnv } from "../config/support.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { adapters, recordingLogger } from "../support.ts";
import { HOOK_TIMEOUT_MS, workspaceHarness, type World } from "../workspaces/support.ts";

// The favicon.fetch job against the database, a scripted egress port and a codec that stands in for the real one (doc 02 section 5.4, doc 01 section 8.1, doc 08 section
// 3.1, doc 10 T6, T14 and section 5; the real codec and the real egress adapter are held in packages/adapters/test). The failure scenario: an SVG with a script, an image that
// declares a small size and decodes to an enormous one, a body over 64 KiB, an HTML page served as the icon and a redirect to a private address all end with the host
// recorded as having no icon: a `none` row with no content, nothing for the browser to be served but the placeholder. The job fetches only for a member who can still read a
// bookmark on the host, and fetches nothing it has a current icon for.

const database = useTestDatabase();
const harness = workspaceHarness(database);
const HOST = "icons.example.test";
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const ICON = encode("icon-bytes-the-codec-accepts");
const OUT: ReencodedIcon = {
  png64: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x64]),
  png32: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x32]),
};

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`DELETE FROM favicons`;
  });
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

async function bookmarkOn(placed: Placed, host: string, options: { readonly ownerId?: string; readonly archived?: boolean } = {}): Promise<void> {
  const url = `https://${host}/page`;
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, plan_archived_at)
      VALUES (${randomUUID()}, ${placed.workspaceId}, ${options.ownerId ?? placed.accountId}, ${url}, ${url}, ${host}, 'As entered', ${options.archived === true ? new Date() : null})`;
  });
}

interface Row {
  readonly host: string;
  readonly status: string;
  readonly content: Buffer | null;
  readonly content_32: Buffer | null;
  readonly fetched_at: Date;
  readonly expires_at: Date;
}

async function rows(): Promise<Row[]> {
  const found = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<Row[]>`SELECT host, status, content, content_32, fetched_at, expires_at FROM favicons ORDER BY host`;
  });
  return [...found];
}

/** A codec that accepts the bytes of `ICON` and refuses everything else as the real one refuses an unsupported or too large image. */
function codec(): ImageCodecPort & { readonly seen: Uint8Array[] } {
  const seen: Uint8Array[] = [];
  return {
    available: true,
    seen,
    reencodeIcon: (input) => {
      seen.push(input);
      return Buffer.from(input).equals(Buffer.from(ICON)) ? Promise.resolve(OUT) : Promise.reject(new ImageRefused("unsupported_format"));
    },
  };
}

function contextWith(egress: EgressPort, imageCodec: ImageCodecPort = codec()): ModuleContext {
  const config = loadConfig("worker", { ...productionEnv(), NODE_ENV: "test", DATABASE_URL: appUrl(database()) }).config;
  const tenants = tenantDatabase(database());
  return { config, logger: recordingLogger(), adapters: { ...adapters(), egress, imageCodec }, withTenant: tenants.withTenant.bind(tenants) };
}

function run(placed: Placed, egress: EgressPort, imageCodec?: ImageCodecPort, host = HOST): Promise<void> {
  return fetchFaviconJob.handle({ host, workspaceId: placed.workspaceId, accountId: placed.accountId }, contextWith(egress, imageCodec));
}

const image = (body: Uint8Array = ICON, contentType = "image/x-icon"): FakeEgressRoute => ({ contentType, body });
const html = (body: string): FakeEgressRoute => ({ contentType: "text/html", body: encode(body) });
const missing: FakeEgressRoute = { status: 404, contentType: "text/html" };

describe("the job fetches the icon of a host and stores it for the deployment", () => {
  it("asks the port for /favicon.ico with the 64 KiB cap and the image types, and stores the 64 px and the 32 px PNG for seven days", async () => {
    const world = harness.serve();
    const a = await workspace(world);
    await bookmarkOn(a, HOST);
    const egress = new FakeEgress({ [`https://${HOST}/favicon.ico`]: image() });

    await run(a, egress);

    expect(egress.requests).toHaveLength(1);
    expect(egress.requests[0]).toMatchObject({
      url: `https://${HOST}/favicon.ico`,
      maxBytes: 65_536,
      acceptContentTypes: ["image/x-icon", "image/vnd.microsoft.icon", "image/ico", "image/png", "image/jpeg", "image/gif", "image/webp"],
    });
    expect(egress.requests[0]?.truncateAtMaxBytes).toBeUndefined();
    expect(JSON.stringify(egress.requests[0]?.headers ?? {})).not.toMatch(/cookie|authorization/i);
    const [row, ...others] = await rows();
    expect(others).toEqual([]);
    expect(row).toMatchObject({ host: HOST, status: "ok" });
    expect(row?.content?.equals(Buffer.from(OUT.png64))).toBe(true);
    expect(row?.content_32?.equals(Buffer.from(OUT.png32))).toBe(true);
    expect((row?.expires_at.getTime() ?? 0) - (row?.fetched_at.getTime() ?? 0)).toBe(7 * 24 * 3600 * 1000);
  });

  it("finds the icon through the link rel=icon of the home page when /favicon.ico has none", async () => {
    const world = harness.serve();
    const a = await workspace(world);
    await bookmarkOn(a, HOST);
    const egress = new FakeEgress({
      [`https://${HOST}/favicon.ico`]: missing,
      [`http://${HOST}/favicon.ico`]: missing,
      [`https://${HOST}/`]: html('<link rel="icon" href="/static/icon.png">'),
      [`https://${HOST}/static/icon.png`]: image(ICON, "image/png"),
    });

    await run(a, egress);

    expect(await rows()).toMatchObject([{ host: HOST, status: "ok" }]);
    expect(egress.fetched).toEqual([`https://${HOST}/favicon.ico`, `http://${HOST}/favicon.ico`, `https://${HOST}/`, `https://${HOST}/static/icon.png`]);
  });

  it("stores a host with no icon as none, with no content", async () => {
    const world = harness.serve();
    const a = await workspace(world);
    await bookmarkOn(a, HOST);
    const egress = new FakeEgress({ [`https://${HOST}/favicon.ico`]: missing, [`http://${HOST}/favicon.ico`]: missing, [`https://${HOST}/`]: html("<title>No icon</title>") });

    await run(a, egress);

    expect(await rows()).toMatchObject([{ host: HOST, status: "none", content: null, content_32: null }]);
  });
});

describe("what a hostile host serves ends as a none row and nothing to serve", () => {
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>';
  const hostile: [string, FakeEgressRoute][] = [
    ["an SVG with a script, served as an SVG", { contentType: "image/svg+xml", body: encode(SVG) }],
    ["an SVG with a script, served as a PNG", { contentType: "image/png", body: encode(SVG) }],
    ["an image the codec refuses for its decoded size", { contentType: "image/png", body: encode("declares-a-small-size-and-decodes-to-an-enormous-one") }],
    ["a body over 64 KiB", { contentType: "image/png", body: new Uint8Array(64 * 1024 + 1) }],
    ["an HTML page served as the icon", { contentType: "text/html", body: encode("<html><script>alert(1)</script></html>") }],
    ["an HTML page served with an image type", { contentType: "image/x-icon", body: encode("<html><script>alert(1)</script></html>") }],
    ["a redirect to a private address", { kind: "redirect", to: "http://10.0.0.5/favicon.ico" }],
    ["a redirect to the metadata address", { kind: "redirect", to: "http://169.254.169.254/latest/meta-data/" }],
    ["a target the port refuses", { kind: "blocked" }],
    ["a host that times out", { kind: "timeout" }],
  ];

  it.each(hostile)("%s", async (_name, route) => {
    const world = harness.serve();
    const a = await workspace(world);
    await bookmarkOn(a, HOST);
    const egress = new FakeEgress({
      [`https://${HOST}/favicon.ico`]: route,
      [`http://${HOST}/favicon.ico`]: route,
      [`https://${HOST}/`]: html(""),
      [`http://${HOST}/`]: html(""),
    });
    const images = codec();

    await run(a, egress, images);

    expect(await rows()).toMatchObject([{ host: HOST, status: "none", content: null, content_32: null }]);
    expect(egress.fetched.every((url) => url.includes(HOST))).toBe(true);
    for (const seen of images.seen) {
      expect(Buffer.from(seen).equals(Buffer.from(ICON))).toBe(false);
    }
  });

  it("does not follow a link rel=icon to a private address: the port is asked and refuses, and nothing is stored but none", async () => {
    const world = harness.serve();
    const a = await workspace(world);
    await bookmarkOn(a, HOST);
    const egress = new FakeEgress({
      [`https://${HOST}/favicon.ico`]: missing,
      [`http://${HOST}/favicon.ico`]: missing,
      [`https://${HOST}/`]: html('<link rel="icon" href="http://192.168.0.1/icon.png"><link rel="icon" href="http://[::1]/icon.png">'),
    });

    await run(a, egress);

    expect(await rows()).toMatchObject([{ host: HOST, status: "none", content: null }]);
  });
});

describe("the job fetches for a member who can read a bookmark on the host, and only then", () => {
  it("fetches nothing and stores nothing when the account has no bookmark on the host", async () => {
    const world = harness.serve();
    const a = await workspace(world);
    await bookmarkOn(a, "another.example.test");
    const egress = new FakeEgress({ [`https://${HOST}/favicon.ico`]: image() });

    await run(a, egress);

    expect(egress.requests).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it("fetches nothing for a bookmark of another member, an archived one or one of another workspace", async () => {
    const world = harness.serve();
    const owner = await harness.person(world);
    const colleague = await harness.person(world);
    const { workspaceId } = await harness.workspaceOf([
      { person: owner, role: "owner" },
      { person: colleague, role: "member" },
    ]);
    const a = { workspaceId, accountId: owner.account.id };
    const b = await workspace(world);
    await bookmarkOn(b, HOST);
    await bookmarkOn(a, HOST, { archived: true });
    await bookmarkOn(a, HOST, { ownerId: colleague.account.id });
    const egress = new FakeEgress({ [`https://${HOST}/favicon.ico`]: image() });

    await run(a, egress);

    expect(egress.requests).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it("fetches nothing for a host whose icon has not expired, and fetches again once it has", async () => {
    const world = harness.serve();
    const a = await workspace(world);
    await bookmarkOn(a, HOST);
    const egress = new FakeEgress({ [`https://${HOST}/favicon.ico`]: image() });
    await run(a, egress);
    await run(a, egress);
    expect(egress.requests).toHaveLength(1);

    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`UPDATE favicons SET fetched_at = now() - interval '8 days', expires_at = now() - interval '1 second'`;
    });
    await run(a, egress);

    expect(egress.requests).toHaveLength(2);
    expect(await rows()).toMatchObject([{ status: "ok" }]);
  });
});

describe("a failure that is the job's", () => {
  it("rejects, and stores nothing, when the egress port is not configured", async () => {
    const world = harness.serve();
    const a = await workspace(world);
    await bookmarkOn(a, HOST);

    await expect(run(a, unconfigured().egress)).rejects.toBeInstanceOf(PortUnavailable);

    expect(await rows()).toEqual([]);
  });

  it("rejects, and stores nothing, when the image codec is not configured or fails for a reason of its own", async () => {
    const world = harness.serve();
    const a = await workspace(world);
    await bookmarkOn(a, HOST);
    const egress = new FakeEgress({ [`https://${HOST}/favicon.ico`]: image() });

    await expect(run(a, egress, unconfigured().imageCodec)).rejects.toBeInstanceOf(PortUnavailable);
    await expect(run(a, egress, { available: true, reencodeIcon: () => Promise.reject(new Error("the codec crashed")) })).rejects.toThrow("the codec crashed");

    expect(await rows()).toEqual([]);
  });

  it("rejects, so the queue retries it, when the result cannot be written, and leaves no row behind", async () => {
    const world = harness.serve();
    const a = await workspace(world);
    await bookmarkOn(a, HOST);
    const egress = new FakeEgress({ [`https://${HOST}/favicon.ico`]: image() });
    const context = contextWith(egress);
    let transactions = 0;
    const failing: ModuleContext = {
      ...context,
      withTenant: (tenant, work) => {
        transactions += 1;
        return transactions === 2 ? Promise.reject(new Error("the database refused the write")) : context.withTenant(tenant, work);
      },
    };

    await expect(fetchFaviconJob.handle({ host: HOST, workspaceId: a.workspaceId, accountId: a.accountId }, failing)).rejects.toThrow("refused the write");

    expect(await rows()).toEqual([]);
    await run(a, egress);
    expect(await rows()).toMatchObject([{ status: "ok" }]);
  });

  it("holds no transaction open while the port answers", async () => {
    const world = harness.serve();
    const a = await workspace(world);
    await bookmarkOn(a, HOST);
    const context = contextWith(new FakeEgress());
    let open = 0;
    let openDuringRequest = -1;
    const egress: EgressPort = {
      available: true,
      request: () => {
        openDuringRequest = open;
        return Promise.resolve({ url: `https://${HOST}/favicon.ico`, status: 200, contentType: "image/x-icon", body: ICON });
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

    await fetchFaviconJob.handle({ host: HOST, workspaceId: a.workspaceId, accountId: a.accountId }, counting);

    expect(openDuringRequest).toBe(0);
    expect(await rows()).toMatchObject([{ status: "ok" }]);
  });

  it("refuses a payload that holds more than the host and two identifiers, a host that is not a host name or an identifier that is not one", () => {
    const ok = { host: HOST, workspaceId: randomUUID(), accountId: randomUUID() };

    expect(fetchFaviconJob.parse(ok)).toEqual(ok);
    expect(() => fetchFaviconJob.parse({ ...ok, url: "https://icons.example.test/" })).toThrow();
    for (const host of ["Icons.Example.Test", "icons.example.test:8080", "http://icons.example.test", "icons example", "", "a".repeat(254)]) {
      expect(() => fetchFaviconJob.parse({ ...ok, host })).toThrow();
    }
    expect(() => fetchFaviconJob.parse({ ...ok, accountId: "not a uuid" })).toThrow();
    expect(() => fetchFaviconJob.parse({ host: HOST, workspaceId: ok.workspaceId })).toThrow();
  });
});

describe("the queued job", () => {
  it("carries the host and the two identifiers and is keyed by the host alone, so the queue holds one waiting job for it", () => {
    const placed = { host: HOST, workspaceId: randomUUID(), accountId: randomUUID() };
    const job = queueFetchFavicon(randomUUID(), placed);

    expect(job).toMatchObject({ queue: "favicon.fetch", data: placed, singletonKey: HOST });
    expect(queueFetchFavicon(randomUUID(), { ...placed, workspaceId: randomUUID() }).singletonKey).toBe(job.singletonKey);
    expect(fetchFaviconJob.dedupe).toBe(true);
  });
});
