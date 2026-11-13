import { ImportRequestSchema, ImportResultSchema } from "@slugbase/contracts";
import { assertBookmarkCountMatches, useTestDatabase } from "@slugbase/testing/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../../vitest.shared.ts";
import { importWorker, ImportWorker, ImportWorkerBusy } from "../../src/import-worker/client.ts";
import { bearer, HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";
import { NETSCAPE, bookmarkFile, uploadRequest } from "./netscape-upload.ts";

// The CPU work of an import runs on the import worker thread, not on the thread that serves the requests (doc 02 section 13.1, doc 01 section 8.1, doc 10 T13), through the whole chain over the migrated database. The failure
// scenario: a 5 MiB body decoded, parsed and validated on the request thread, which holds every other request back while it runs; and a worker that dies, answers wrongly or is not there, which must fail that one import,
// write nothing, and leave the next import a working worker.

const IMPORT = "/api/v1/import/json";
const KEY_HEADER = "idempotency-key";
const RELAXED = { RATE_LIMIT_BULK_IP: "10000/hour", RATE_LIMIT_BULK_ACCOUNT: "10000/hour", RATE_LIMIT_WRITE_IP: "10000/min", RATE_LIMIT_WRITE_ACCOUNT: "10000/min" };
/** A body this large is one the request thread would take a few milliseconds to parse; the spies below see any such parse. */
const BOOKMARKS = 3000;
const LARGE = 50_000;

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

afterAll(async () => {
  importWorker().terminate();
  await harness.stop();
});

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
  await database().owner`TRUNCATE pgboss.job`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await assertBookmarkCountMatches(database());
});

async function setup(world: World) {
  const a = await harness.person(world);
  const shared = await harness.workspaceOf([{ person: a, role: "owner" }]);
  return { a, shared };
}

const file = (count = BOOKMARKS, prefix = "https://example.com/") => Array.from({ length: count }, (_, index) => ({ url: `${prefix}${String(index)}`, title: `Bookmark ${String(index)}`, tags: ["t"], folders: ["f"] }));

async function bookmarkCount(workspaceId: string): Promise<number> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ count: number }[]>`SELECT count(*)::int AS count FROM bookmarks WHERE workspace_id = ${workspaceId}`;
  });
  return rows[0]?.count ?? -1;
}

/** Spies on every way the request thread could decode, parse or validate an import body, and on the jobs given to the worker. */
function watchRequestThread() {
  const parse = vi.spyOn(JSON, "parse");
  const validate = vi.spyOn(ImportRequestSchema, "safeParse");
  const decodes = [vi.spyOn(Request.prototype, "formData"), vi.spyOn(Response.prototype, "formData")];
  const jobs = vi.spyOn(ImportWorker.prototype, "run");
  return {
    jobs,
    largeParses: () => parse.mock.calls.filter(([text]) => typeof text === "string" && text.length > LARGE).length,
    validations: () => validate.mock.calls.length,
    decoded: () => decodes.reduce((total, spy) => total + spy.mock.calls.length, 0),
  };
}

describe("POST /api/v1/import/json on the import worker", () => {
  // It starts the import worker thread and imports 3000 bookmarks: 0.7 s alone, 2.2 to 3.5 s beside 60 busy loops (issue 891).
  it("parses and validates the file on the worker and never on the request thread, and writes what it always wrote", { timeout: HEAVY_TEST_TIMEOUT_MS }, async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);
    const watching = watchRequestThread();

    const response = await send(world, "POST", IMPORT, { cookie: a.cookie }, file());
    const seen = { parses: watching.largeParses(), validations: watching.validations(), jobs: watching.jobs.mock.calls.length };
    vi.restoreAllMocks();

    expect(response.status).toBe(200);
    expect(ImportResultSchema.parse(await response.json())).toMatchObject({ detected: { bookmarks: BOOKMARKS, folders: 1, tags: 1 }, created: BOOKMARKS, foldersCreated: 1, tagsCreated: 1 });
    expect(seen).toEqual({ parses: 0, validations: 0, jobs: 1 });
    expect(await bookmarkCount(shared.workspaceId)).toBe(BOOKMARKS);
  });

  it("reads the file once for the request with a key, the first request and the replay of it alike", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a } = await setup(world);
    const headers = { cookie: a.cookie, [KEY_HEADER]: crypto.randomUUID() };
    const watching = watchRequestThread();

    const first = await send(world, "POST", IMPORT, headers, file(200));
    const readsOfFirst = watching.jobs.mock.calls.length;
    const replay = await send(world, "POST", IMPORT, headers, file(200));
    const readsInAll = watching.jobs.mock.calls.length;
    vi.restoreAllMocks();

    expect([first.status, replay.status, replay.headers.get("idempotency-replayed")]).toEqual([200, 200, "true"]);
    expect([readsOfFirst, readsInAll]).toEqual([1, 2]);
  });

  it("answers a body that is not JSON, not the format and no body as it always did, from the worker's answer", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a } = await setup(world);

    const notJson = await world.server.fetch(new Request(new URL(IMPORT, world.origin), { method: "POST", headers: { origin: world.origin, "content-type": "application/json", cookie: a.cookie }, body: "[{ nope" }));
    const notFormat = await send(world, "POST", IMPORT, { cookie: a.cookie }, [{ url: 7, nope: true }]);
    const empty = await world.server.fetch(new Request(new URL(IMPORT, world.origin), { method: "POST", headers: { origin: world.origin, "content-type": "application/json", cookie: a.cookie } }));

    expect([notJson.status, await notJson.json()]).toEqual([400, expect.objectContaining({ code: "bad_request", detail: "The request body is not valid JSON." }) as unknown]);
    expect([notFormat.status, await notFormat.json()]).toEqual([422, expect.objectContaining({ code: "validation_failed", errors: [{ path: "0.url", code: "invalid_type" }, { path: "0.nope", code: "unrecognized_keys" }] }) as unknown]);
    expect(empty.status).toBe(422);
  });

  it("reads the file of a request that carries an API token and a session cookie too, whose cookie the cross-site stage drops by making a new request", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);
    const token = await harness.token(shared.workspaceId, a, "read-write");
    const watching = watchRequestThread();

    const response = await send(world, "POST", IMPORT, { ...bearer(token), cookie: a.cookie }, file(50));
    const jobs = watching.jobs.mock.calls.length;
    vi.restoreAllMocks();

    expect(response.status).toBe(200);
    expect(ImportResultSchema.parse(await response.json())).toMatchObject({ created: 50 });
    expect(jobs).toBe(1);
    expect(await bookmarkCount(shared.workspaceId)).toBe(50);
  });

  it("does not hand the body of a request nobody is signed in for to the worker", async () => {
    const world = harness.serve({ env: RELAXED });
    const watching = watchRequestThread();

    const response = await world.server.fetch(new Request(new URL(IMPORT, world.origin), { method: "POST", headers: { origin: world.origin, "content-type": "application/json" }, body: "[{ nope" }));
    const jobs = watching.jobs.mock.calls.length;
    vi.restoreAllMocks();

    expect(response.status).toBe(401);
    expect(jobs).toBe(0);
  });
});

describe("POST /api/v1/import/netscape on the import worker", () => {
  it("decodes, reads and prepares the upload on the worker and never on the request thread", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);
    const request = await uploadRequest(world, a, bookmarkFile(file(500).map((entry) => ({ url: entry.url, title: entry.title }))));
    const watching = watchRequestThread();

    const response = await world.server.fetch(request);
    const seen = { decodes: watching.decoded(), jobs: watching.jobs.mock.calls.length };
    vi.restoreAllMocks();

    expect(response.status).toBe(200);
    expect(ImportResultSchema.parse(await response.json())).toMatchObject({ created: 500 });
    expect(seen).toEqual({ decodes: 0, jobs: 1 });
    expect(await bookmarkCount(shared.workspaceId)).toBe(500);
  });
});

describe.each([
  { route: "the JSON import", request: (world: World, a: Person, headers: Record<string, string>) => send(world, "POST", IMPORT, { cookie: a.cookie, ...headers }, file(300)) },
  { route: "the upload", request: async (world: World, a: Person, headers: Record<string, string>) => world.server.fetch(await uploadRequest(world, a, bookmarkFile(file(300).map((entry) => ({ url: entry.url }))), { headers })) },
])("a worker that fails an import through $route", ({ request }) => {
  /** Makes the next job fail the way `how` says, after the real worker has been handed it, and leaves every later job alone. */
  function failNext(how: "dies" | "answers wrongly" | "is busy") {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with the instance it is given (`original.call(this, ...)`)
    const original = ImportWorker.prototype.run;
    vi.spyOn(ImportWorker.prototype, "run").mockImplementationOnce(function (this: ImportWorker, job) {
      if (how === "is busy") {
        return Promise.reject(new ImportWorkerBusy());
      }
      if (how === "answers wrongly") {
        return Promise.resolve({ kind: "prepared", prepared: { kind: "ready", reads: "no" } });
      }
      const running = original.call(this, job);
      this.terminate();
      return running;
    });
  }

  it.each([
    ["dies", 500, "internal"],
    ["answers wrongly", 500, "internal"],
    ["is busy", 503, "unavailable"],
  ] as const)("refuses the import and writes nothing when the worker %s, and the next import, with the same key, creates its bookmarks", async (how, status, code) => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);
    const headers = { [KEY_HEADER]: crypto.randomUUID() };
    failNext(how);

    const failed = await request(world, a, headers);
    const afterFailure = await bookmarkCount(shared.workspaceId);
    const next = await request(world, a, headers);

    expect([failed.status, await failed.json()]).toEqual([status, expect.objectContaining({ code }) as unknown]);
    expect(afterFailure).toBe(0);
    expect(next.status).toBe(200);
    expect(next.headers.get("idempotency-replayed")).toBeNull();
    expect(ImportResultSchema.parse(await next.json())).toMatchObject({ created: 300 });
    expect(await bookmarkCount(shared.workspaceId)).toBe(300);
  });
});

describe("an import file at the caps, through the worker", () => {
  it("refuses a file that names more distinct names than the bound before the database is asked anything, as it did on the request thread", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);
    const tags = Array.from({ length: 110_001 }, (_, index) => `tag ${String(index)}`);

    const response = await send(world, "POST", IMPORT, { cookie: a.cookie }, { format: "slugbase-export", version: 1, tags, bookmarks: [{ url: "https://example.com/a" }] });

    expect([response.status, await response.json()]).toEqual([422, expect.objectContaining({ code: "validation_failed", errors: [{ path: "", code: "too_many_new_names" }] }) as unknown]);
    expect(await bookmarkCount(shared.workspaceId)).toBe(0);
  });

  it("keeps the upload's hostile cases the upload's own: a link count past the cap is 422, a body that is no form is 400", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a } = await setup(world);
    const many = bookmarkFile(Array.from({ length: 5001 }, (_, index) => ({ url: `https://example.com/${String(index)}` })));

    const tooMany = await world.server.fetch(await uploadRequest(world, a, many));
    const notForm = await world.server.fetch(
      new Request(new URL(NETSCAPE, world.origin), { method: "POST", headers: { origin: world.origin, cookie: a.cookie, "content-type": "multipart/form-data; boundary=b" }, body: "no parts" }),
    );

    expect([tooMany.status, await tooMany.json()]).toEqual([422, expect.objectContaining({ errors: [{ path: "", code: "too_big" }] }) as unknown]);
    expect(notForm.status).toBe(400);
  });
});
