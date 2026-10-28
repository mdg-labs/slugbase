import { randomBytes, randomUUID } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { faviconRepository } from "@slugbase/db";
import { loadConfig, createWorker, type Logger, type ModuleContext } from "@slugbase/server";
import { FakeEgress, type FakeEgressRoute } from "@slugbase/testing";
import { createTestDatabase, type TestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { composeAdapters } from "../src/main.ts";

// The favicon.fetch job as the composition root wires it (doc 02 section 5.4, doc 10 T6 and T14): the worker the CE image runs registers the job, and the job runs over the
// adapters `composeAdapters` builds, the real image codec among them; only the egress port is a script, since nothing here reaches the internet (the real egress adapter is held in
// packages/adapters/test/egress/favicon-fetch). The failure scenario: an SVG with a script, an image that declares a small size and decodes to an enormous one, an HTML page
// served as the icon and a redirect to a private address all end as a host with no icon and no stored content, and an icon that is one is stored as the two PNGs the codec encoded.

const HOOK_TIMEOUT_MS = 300_000;
const HOST = "icons.example.test";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

let db: TestDatabase;
let accountId: string;
let workspaceId: string;

function databaseUrl(database: TestDatabase): string {
  const { options } = database.app;
  const url = new URL("postgres://localhost");
  url.hostname = String(options.host[0]);
  url.port = String(options.port[0]);
  url.username = options.user;
  url.password = String(options.pass);
  url.pathname = `/${options.database}`;
  return url.href;
}

beforeAll(async () => {
  db = await createTestDatabase();
  accountId = randomUUID();
  workspaceId = randomUUID();
  await db.owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
    await tx`INSERT INTO accounts (id, email, display_name) VALUES (${accountId}, 'favicons@example.test', 'Favicons')`;
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`INSERT INTO workspaces (id, name) VALUES (${workspaceId}, 'Favicons')`;
    await tx`INSERT INTO workspace_settings (workspace_id) VALUES (${workspaceId})`;
    await tx`INSERT INTO workspace_members (workspace_id, account_id, role) VALUES (${workspaceId}, ${accountId}, 'owner')`;
    await tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title)
      VALUES (${randomUUID()}, ${workspaceId}, ${accountId}, ${`https://${HOST}/`}, ${`https://${HOST}/`}, ${HOST}, 'Icons')`;
  });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await db.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`DELETE FROM favicons`;
  });
});

const environment = {
  NODE_ENV: "test",
  APP_ORIGIN: "https://bookmarks.example.com",
  DATABASE_URL: "postgres://slugbase_app:Zq8-prod-app-pw@db.internal:5432/slugbase",
  DATABASE_MIGRATE_URL: "postgres://slugbase_migrator:Zq8-prod-mig-pw@db.internal:5432/slugbase",
  SESSION_SECRET: randomBytes(48).toString("base64url"),
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  ENCRYPTION_KEY_ID: "k1",
  MIGRATE_ON_START: "false",
};

/** Runs the favicon.fetch job of the worker the composition builds, over its real adapters but the egress port. */
async function runJob(egress: FakeEgress): Promise<void> {
  const config = loadConfig("worker", { ...environment, DATABASE_URL: databaseUrl(db) }).config;
  const adapters = { ...composeAdapters(config, logger), egress };
  const worker = createWorker({ config, adapters, modules: [], logger, database: { withTenant: (context, fn) => db.tenant.withTenant(context, fn), close: () => Promise.resolve() } });
  const job = worker.jobs.find((candidate) => candidate.name === "favicon.fetch");
  if (job === undefined) {
    throw new Error("the worker does not register favicon.fetch");
  }
  const context: ModuleContext = { config, logger, adapters, withTenant: (tenant, fn) => db.tenant.withTenant(tenant, fn) };
  await job.handle({ host: HOST, workspaceId, accountId }, context);
}

interface Row {
  readonly status: string;
  readonly content: Buffer | null;
  readonly content_32: Buffer | null;
}

async function rows(): Promise<Row[]> {
  return [
    ...(await db.owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      return tx<Row[]>`SELECT status, content, content_32 FROM favicons`;
    })),
  ];
}

const ICON = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQI12NgYGBgAAAABQABXvMqOgAAAABJRU5ErkJggg==",
  "base64",
);

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A PNG of `edge` by `edge` gray pixels, all zero: under 64 KiB at 7 000 pixels, and 49 million pixels once decoded. */
function bomb(edge: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(edge, 0);
  header.writeUInt32BE(edge, 4);
  header[8] = 8;
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.alloc(edge * (edge + 1)), { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const missing: FakeEgressRoute = { status: 404, contentType: "text/html" };

function scripted(icon: FakeEgressRoute): FakeEgress {
  return new FakeEgress({
    [`https://${HOST}/favicon.ico`]: icon,
    [`http://${HOST}/favicon.ico`]: icon,
    [`https://${HOST}/`]: { contentType: "text/html", body: new TextEncoder().encode("<html><title>No link</title></html>") },
    [`http://${HOST}/`]: missing,
  });
}

describe("the worker the composition root builds", () => {
  it("registers favicon.fetch, and the adapters it runs it with hold the real image codec", () => {
    const config = loadConfig("worker", environment).config;
    const adapters = composeAdapters(config, logger);
    const worker = createWorker({ config, adapters, modules: [], logger });

    expect(worker.jobs.map((job) => job.name)).toContain("favicon.fetch");
    expect(adapters.imageCodec.available).toBe(true);
  });

  it("stores the 64 px and the 32 px PNG the real codec encoded from the icon a host serves", async () => {
    await runJob(scripted({ contentType: "image/x-icon", body: ICON }));

    const [row, ...others] = await rows();
    expect(others).toEqual([]);
    expect(row?.status).toBe("ok");
    for (const [png, edge] of [
      [row?.content, 64],
      [row?.content_32, 32],
    ] as const) {
      expect(png?.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
      expect(png?.readUInt32BE(16)).toBe(edge);
      expect(png?.readUInt32BE(20)).toBe(edge);
    }
    const stored = await db.tenant.withTenant({ accountId, workspaceId, requestId: "favicons-test" }, (tx) => faviconRepository(tx).current(HOST, 32));
    expect(stored?.status).toBe("ok");
  });
});

describe("what a hostile host serves, through the real codec", () => {
  const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>');
  const hostile: [string, FakeEgressRoute][] = [
    ["an SVG with a script, served as an SVG", { contentType: "image/svg+xml", body: SVG }],
    ["an SVG with a script, served as a PNG", { contentType: "image/png", body: SVG }],
    ["a small file that decodes to 49 million pixels", { contentType: "image/png", body: bomb(7_000) }],
    ["an HTML page served as the icon", { contentType: "text/html", body: Buffer.from("<html><script>alert(1)</script></html>") }],
    ["a redirect to a private address", { kind: "redirect", to: "http://10.0.0.5/favicon.ico" }],
    ["a body over 64 KiB", { contentType: "image/png", body: Buffer.concat([ICON, Buffer.alloc(64 * 1024)]) }],
  ];

  it.each(hostile)("%s ends as a host with no icon", async (_name, route) => {
    expect(bomb(7_000).length).toBeLessThan(64 * 1024);

    await runJob(scripted(route));

    expect(await rows()).toMatchObject([{ status: "none", content: null, content_32: null }]);
  });
});
