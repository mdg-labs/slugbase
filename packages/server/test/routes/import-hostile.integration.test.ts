import { IMPORT_MAX_BYTES, IMPORT_MAX_BOOKMARKS, IMPORT_MAX_NEW_NAMES, ImportResultSchema } from "@slugbase/contracts";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HOOK_TIMEOUT_MS, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// The hostile files of POST /api/v1/import/json (doc 08 section 3.5 `import/hostile`, doc 10 T1 and T13), through the whole chain over the migrated database. The failure scenario: a file the
// importer must not trust, an oversized body, a body nested a hundred thousand deep that is sent with an Idempotency-Key, malformed JSON, five megabytes of empty objects, `javascript:` and
// `data:` addresses, control characters, huge strings, script-laden titles and prototype-pollution keys, a folder or tag name or a folder icon of a hundred thousand
// characters, and a file of more new folders and tags than one import may create, is each rejected or neutralised: no `500`, no polluted prototype, no stored key for a refused request, and no row of any workspace written, the caller's or another's.

const TEST_TIMEOUT_MS = 120_000;
const IMPORT = "/api/v1/import/json?dryRun=true";
const KEY_HEADER = "idempotency-key";
const RELAXED = { RATE_LIMIT_BULK_IP: "10000/hour", RATE_LIMIT_BULK_ACCOUNT: "10000/hour", RATE_LIMIT_WRITE_IP: "10000/min", RATE_LIMIT_WRITE_ACCOUNT: "10000/min" };

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
  await database().owner`TRUNCATE pgboss.job`;
});

/** Sends `body` as it is: the helper of the harness would serialise it, and a hostile body is already text. */
function raw(world: World, person: Person, body: string, headers: Record<string, string> = {}, path = IMPORT): Promise<Response> {
  return world.server.fetch(
    new Request(new URL(path, world.origin), { method: "POST", headers: { origin: world.origin, "content-type": "application/json", cookie: person.cookie, ...headers }, body }),
  );
}

const json = (world: World, person: Person, body: unknown, headers: Record<string, string> = {}, path = IMPORT) => raw(world, person, JSON.stringify(body), headers, path);

interface Problem {
  readonly code: string;
  readonly errors?: readonly { path: string; code: string }[];
}

const problemOf = async (response: Response): Promise<Problem> => (await response.json()) as Problem;

/** Everything a request could have written, of every workspace: the rows, the counters and the audit log. */
async function written(): Promise<unknown> {
  const jobs = await database().owner<{ count: number }[]>`SELECT count(*)::int AS count FROM pgboss.job`;
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx`
      SELECT
        (SELECT count(*) FROM bookmarks)::int AS bookmarks,
        (SELECT count(*) FROM folders)::int AS folders,
        (SELECT count(*) FROM tags)::int AS tags,
        (SELECT count(*) FROM folder_bookmarks)::int AS folder_links,
        (SELECT count(*) FROM bookmark_tags)::int AS tag_links,
        (SELECT coalesce(sum(bookmark_count), 0) FROM workspaces)::int AS counters,
        (SELECT count(*) FROM audit_events)::int AS audit_events`;
  });
  return { ...rows[0], jobs: jobs[0]?.count };
}

async function keyCount(): Promise<number> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ count: number }[]>`SELECT count(*)::int AS count FROM idempotency_keys`;
  });
  return rows[0]?.count ?? -1;
}

async function setup(world: World) {
  const a = await harness.person(world);
  const b = await harness.person(world);
  const workspaceA = await harness.workspaceOf([{ person: a, role: "owner" }]);
  const workspaceB = await harness.workspaceOf([{ person: b, role: "owner" }]);
  // Both workspaces hold a bookmark already, so that a write of the importer would show in a count or a counter.
  for (const [person, url] of [[a, "https://example.com/mine"] as const, [b, "https://example.com/theirs"] as const]) {
    const response = await world.server.fetch(
      new Request(new URL("/api/v1/bookmarks", world.origin), { method: "POST", headers: { origin: world.origin, "content-type": "application/json", cookie: person.cookie }, body: JSON.stringify({ url, title: "Existing" }) }),
    );
    expect(response.status).toBe(201);
  }
  return { a, b, workspaceA, workspaceB };
}

describe("POST /import/json with a hostile file", { timeout: TEST_TIMEOUT_MS }, () => {
  it("refuses a body over 5 MiB with 413 payload_too_large before it is read, and writes nothing", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a } = await setup(world);
    const before = await written();

    const response = await raw(world, a, `"${"x".repeat(IMPORT_MAX_BYTES)}"`);

    expect(response.status).toBe(413);
    expect((await problemOf(response)).code).toBe("payload_too_large");
    expect(await written()).toEqual(before);
  });

  it("refuses 100 000 nested arrays sent with an Idempotency-Key without a 500, stores no key for it, and writes nothing", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a } = await setup(world);
    const before = await written();
    const depth = 100_000;

    const response = await raw(world, a, `${"[".repeat(depth)}${"]".repeat(depth)}`, { [KEY_HEADER]: crypto.randomUUID() });

    expect(response.status).toBe(422);
    expect((await problemOf(response)).code).toBe("validation_failed");
    expect(await keyCount()).toBe(0);
    expect(await written()).toEqual(before);
  });

  it("refuses 100 000 nested objects the same way", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a } = await setup(world);
    const depth = 100_000;

    const response = await raw(world, a, `${'{"bookmarks":'.repeat(depth)}[]${"}".repeat(depth)}`, { [KEY_HEADER]: crypto.randomUUID() });

    expect(response.status).toBe(422);
    expect((await problemOf(response)).code).toBe("validation_failed");
    expect(await keyCount()).toBe(0);
  });

  it("refuses malformed JSON with 400", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a } = await setup(world);

    for (const body of ['[{"url":"https://example.com/"', "{'url': 1}", "[1,]", "\u0000", '{"bookmarks":[]}}']) {
      const response = await raw(world, a, body, { [KEY_HEADER]: crypto.randomUUID() });
      expect(response.status, body).toBe(400);
      expect((await problemOf(response)).code).toBe("bad_request");
    }
    expect(await keyCount()).toBe(0);
  });

  it("answers 422 with a bounded errors[] to 5 MiB of empty objects, and to a file of thousands of bad items", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a } = await setup(world);
    const before = await written();
    const empties = `[${"{},".repeat(Math.floor((IMPORT_MAX_BYTES - 2) / 3) - 1)}{}]`;
    expect(empties.length).toBeLessThanOrEqual(IMPORT_MAX_BYTES);

    const tooMany = await raw(world, a, empties);
    const problem = await problemOf(tooMany);

    expect(tooMany.status).toBe(422);
    expect(problem.code).toBe("validation_failed");
    expect(problem.errors?.length).toBeGreaterThan(0);
    expect(problem.errors?.length).toBeLessThanOrEqual(100);

    const wrong = await json(world, a, Array.from({ length: IMPORT_MAX_BOOKMARKS }, () => ({})));
    const wrongProblem = await problemOf(wrong);

    expect(wrong.status).toBe(422);
    expect(wrongProblem.errors?.length).toBe(100);
    expect(wrongProblem.errors?.[0]).toEqual({ path: "0.url", code: "invalid_type" });
    expect(await written()).toEqual(before);
  });

  it("refuses more than 5 000 bookmarks with 422, in the envelope and as a plain array", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a } = await setup(world);
    const items = Array.from({ length: IMPORT_MAX_BOOKMARKS + 1 }, (_, index) => ({ url: `https://example.com/${String(index)}` }));

    const plain = await json(world, a, items);
    const envelope = await json(world, a, { format: "slugbase-export", version: 1, bookmarks: items });

    expect(plain.status).toBe(422);
    expect((await problemOf(plain)).errors).toEqual([{ path: "", code: "too_big" }]);
    expect(envelope.status).toBe(422);
    expect((await problemOf(envelope)).errors).toEqual([{ path: "bookmarks", code: "too_big" }]);
  });

  it("neutralises javascript:, data: and other addresses that are not http or https: each is a failure of its bookmark, and the rest of the file is read", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a } = await setup(world);
    const before = await written();
    const hostile = [
      "javascript:alert(1)",
      " JaVaScRiPt:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "//evil.example/",
      "https://exa\u0000mple.com/",
      "https://example.com/\nsecond-line",
      "http://",
      "",
      "https://" + "a".repeat(IMPORT_MAX_BYTES / 4),
    ];

    const response = await json(world, a, [...hostile.map((url) => ({ url })), { url: "https://example.com/fine", title: "Fine" }]);
    const result = ImportResultSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(result.created).toBe(1);
    expect(result.failed.map((entry) => [entry.position, entry.reason])).toEqual([
      [1, "url_not_allowed"],
      [2, "url_not_allowed"],
      [3, "url_not_allowed"],
      [4, "url_not_allowed"],
      [5, "url_not_allowed"],
      [6, "url_not_allowed"],
      [7, "url_invalid"],
      [8, "url_invalid"],
      [9, "url_invalid"],
      [10, "url_invalid"],
      [11, "url_invalid"],
    ]);
    for (const entry of result.failed) {
      expect(entry.url.length).toBeLessThanOrEqual(2048);
      expect(entry.url).not.toMatch(/\p{Cc}/u);
    }
    expect(await written()).toEqual(before);
  });

  it("makes titles plain text: control characters are removed, a huge title is cut to 300 characters, a script stays the characters it is, and a blank title is the host", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a } = await setup(world);
    const before = await written();
    const script = '<script>alert("x")</script><img src=x onerror=alert(1)>';

    const response = await json(world, a, [
      { url: "https://example.com/1", title: script },
      { url: "https://example.com/2", title: "Tab\tNul\u0000Bell\u0007Esc\u001bC1\u0085End" },
      { url: "https://example.com/3", title: "😀".repeat(100_000) },
      { url: "https://example.com/4", title: "\u0000\u0007 \n" },
      { url: "https://example.com/5", title: "x".repeat(1_000_000), description: "d".repeat(1_000_000) },
      // Skipped as duplicates of the first five, so that their titles are echoed whatever the file holds.
      { url: "https://example.com/1", title: script },
      { url: "https://example.com/2", title: "Tab\tNul\u0000Bell\u0007Esc\u001bC1\u0085End" },
      { url: "https://example.com/3", title: "😀".repeat(100_000) },
      { url: "https://example.com/4", title: "\u0000\u0007 \n" },
      { url: "https://example.com/5", title: "x".repeat(1_000_000) },
    ]);
    const result = ImportResultSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(result.created).toBe(5);
    expect(result.skipped.map((entry) => entry.position)).toEqual([6, 7, 8, 9, 10]);
    expect(result.skipped.map((entry) => entry.title)).toEqual([script, "TabNulBellEscC1End", "😀".repeat(300), "example.com", "x".repeat(300)]);
    expect(await written()).toEqual(before);
  });

  it("refuses prototype-pollution keys as fields the format does not declare, and pollutes nothing", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a } = await setup(world);
    const before = await written();
    const bodies = [
      '[{"url":"https://example.com/","__proto__":{"polluted":true}}]',
      '{"format":"slugbase-export","version":1,"bookmarks":[],"__proto__":{"polluted":true}}',
      '[{"url":"https://example.com/","constructor":{"prototype":{"polluted":true}}}]',
      '[{"url":"https://example.com/","folders":[],"tags":[],"prototype":{"polluted":true}}]',
      '{"__proto__":{"polluted":true},"bookmarks":[]}',
    ];

    for (const body of bodies) {
      const response = await raw(world, a, body, { [KEY_HEADER]: crypto.randomUUID() });
      expect(response.status, body).toBe(422);
      expect((await problemOf(response)).code).toBe("validation_failed");
    }

    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
    expect(await keyCount()).toBe(0);
    expect(await written()).toEqual(before);
  });

  it("reads folder and tag names named __proto__ as names, and not as a key", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a } = await setup(world);

    const response = await json(world, a, [{ url: "https://example.com/p", folders: ["__proto__", "constructor"], tags: ["__proto__"] }]);
    const result = ImportResultSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(result.detected).toEqual({ bookmarks: 1, folders: 2, tags: 1 });
    expect(({} as Record<string, unknown>)["__proto__"]).toBe(Object.prototype);
  });

  it("refuses a version newer than the one it reads with an error at version, also when the file carries fields this version does not know", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a } = await setup(world);

    const plain = await json(world, a, { format: "slugbase-export", version: 2, bookmarks: [] });
    const unknown = await json(world, a, {
      format: "slugbase-export",
      version: 2,
      exportedAt: "2027-01-01T00:00:00.000Z",
      groups: [{ name: "New in 2" }],
      bookmarks: [{ url: "https://example.com/", visits: 3, notes: { text: "x" } }],
    });

    expect(plain.status).toBe(422);
    expect((await problemOf(plain)).errors).toContainEqual({ path: "version", code: "too_big" });
    expect(unknown.status).toBe(422);
    const problem = await problemOf(unknown);
    expect(problem.code).toBe("validation_failed");
    expect(problem.errors).toContainEqual({ path: "version", code: "too_big" });
  });

  it("refuses a folder or tag name or a folder icon of 100 000 characters with 422 at the path of the value, and writes nothing", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a } = await setup(world);
    const before = await written();
    const url = "https://example.com/hostile";
    const huge = "n".repeat(100_000);
    const cases: { body: unknown; error: { path: string; code: string } }[] = [
      { body: [{ url, tags: [huge] }], error: { path: "0.tags.0", code: "too_big" } },
      { body: [{ url, folders: [huge] }], error: { path: "0.folders.0", code: "too_big" } },
      { body: { format: "slugbase-export", version: 1, tags: [huge], bookmarks: [] }, error: { path: "tags.0", code: "too_big" } },
      { body: { format: "slugbase-export", version: 1, folders: [{ name: "Fine" }, { name: huge }], bookmarks: [] }, error: { path: "folders.1.name", code: "too_big" } },
      { body: { format: "slugbase-export", version: 1, folders: [{ name: "Fine", icon: huge }], bookmarks: [] }, error: { path: "folders.0.icon", code: "too_big" } },
    ];

    for (const { body, error } of cases) {
      const response = await json(world, a, body, { [KEY_HEADER]: crypto.randomUUID() }, "/api/v1/import/json");
      const problem = await problemOf(response);
      expect(response.status, JSON.stringify(error)).toBe(422);
      expect(problem.code).toBe("validation_failed");
      expect(problem.errors).toContainEqual(error);
    }

    expect(await keyCount()).toBe(0);
    expect(await written()).toEqual(before);
  });

  it("refuses a file of 10 001 new names with 422 while another transaction holds the workspace row, in the dry run and in the write, and writes nothing; a file of exactly 10 000 imports", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, workspaceA } = await setup(world);
    const before = await written();
    const tags = (from: number, count: number) => Array.from({ length: count }, (_, index) => `tag-${String(from + index).padStart(6, "0")}`);
    const document = (names: { folders?: string[]; tags?: string[] }) => ({
      format: "slugbase-export",
      version: 1,
      ...(names.folders === undefined ? {} : { folders: names.folders.map((name) => ({ name })) }),
      ...(names.tags === undefined ? {} : { tags: names.tags }),
      bookmarks: [],
    });
    const refusals = [
      document({ tags: tags(0, IMPORT_MAX_NEW_NAMES + 1) }),
      document({ folders: tags(0, 5001).map((name) => `folder-${name}`), tags: tags(0, 5000) }),
      [{ url: "https://example.com/many", tags: tags(0, IMPORT_MAX_NEW_NAMES + 1) }],
    ];

    // Another transaction holds the workspace row as the import's `sys_bookmark_count_take_many` does (`FOR NO KEY UPDATE`, as the system role that sees the row), so a request that takes the lock waits for it: a refused request answers at once.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      const rows = await tx`SELECT id FROM workspaces WHERE id = ${workspaceA.workspaceId} FOR NO KEY UPDATE`;
      expect(rows).toHaveLength(1);
      locked();
      await held;
    });
    try {
      await lockTaken;
      for (const body of refusals) {
        for (const path of [IMPORT, "/api/v1/import/json"]) {
          const answered = await Promise.race([json(world, a, body, { [KEY_HEADER]: crypto.randomUUID() }, path), new Promise<null>((resolve) => {
              setTimeout(() => {
                resolve(null);
              }, 15_000);
            })]);
          expect(answered, path).not.toBeNull();
          const response = answered as Response;
          const problem = await problemOf(response);
          expect(response.status, path).toBe(422);
          expect(problem.code).toBe("validation_failed");
          expect(problem.errors).toEqual([{ path: "", code: "too_many_new_names" }]);
        }
      }
    } finally {
      release();
      await holder;
    }
    expect(await keyCount()).toBe(0);
    expect(await written()).toEqual(before);

    const exactly = await json(world, a, document({ tags: tags(0, IMPORT_MAX_NEW_NAMES) }), { [KEY_HEADER]: crypto.randomUUID() }, "/api/v1/import/json");
    const result = ImportResultSchema.parse(await exactly.json());

    expect(exactly.status).toBe(200);
    expect(result).toMatchObject({ created: 0, tagsCreated: IMPORT_MAX_NEW_NAMES, foldersCreated: 0 });
    const rows = await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      return tx<{ count: number }[]>`SELECT count(*)::int AS count FROM tags`;
    });
    expect(rows[0]?.count).toBe(IMPORT_MAX_NEW_NAMES);
  });

  it("counts only the names the caller does not have, compared as the database compares them, so a file whose names exist imports at any size", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a } = await setup(world);
    const names = (prefix: string, from: number, count: number) => Array.from({ length: count }, (_, index) => `${prefix}-${String(from + index).padStart(6, "0")}`);
    const send = (tags: string[], path = "/api/v1/import/json") => json(world, a, { format: "slugbase-export", version: 1, tags, bookmarks: [] }, {}, path);

    expect((await send(names("tag", 0, IMPORT_MAX_NEW_NAMES))).status).toBe(200);
    expect((await send(names("other", 0, IMPORT_MAX_NEW_NAMES))).status).toBe(200);
    const before = await written();

    // 20 000 names the caller has, written in capitals, and none new.
    const known = [...names("TAG", 0, IMPORT_MAX_NEW_NAMES), ...names("OTHER", 0, IMPORT_MAX_NEW_NAMES)];
    for (const path of [IMPORT, "/api/v1/import/json"]) {
      const response = await send(known, path);
      const result = ImportResultSchema.parse(await response.json());
      expect(response.status, path).toBe(200);
      expect(result).toMatchObject({ tagsCreated: 0, foldersCreated: 0, detected: { tags: 2 * IMPORT_MAX_NEW_NAMES } });
    }
    expect((await written() as { audit_events: number }).audit_events).toBe((before as { audit_events: number }).audit_events + 1);

    // The names the caller has do not use up the room of the new ones: 10 000 known and 10 000 new, then 10 000 known and 10 001 new.
    const room = await send([...names("tag", 0, IMPORT_MAX_NEW_NAMES), ...names("fresh", 0, IMPORT_MAX_NEW_NAMES)], IMPORT);
    expect(room.status).toBe(200);
    expect(ImportResultSchema.parse(await room.json()).tagsCreated).toBe(IMPORT_MAX_NEW_NAMES);
    const over = await send([...names("tag", 0, IMPORT_MAX_NEW_NAMES), ...names("fresh", 0, IMPORT_MAX_NEW_NAMES + 1)], IMPORT);
    expect(over.status).toBe(422);
    expect((await problemOf(over)).errors).toEqual([{ path: "", code: "too_many_new_names" }]);
  });

  it("finds no duplicate in, and touches no row of, another workspace", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a } = await setup(world);
    const before = await written();

    // B holds https://example.com/theirs, and A holds https://example.com/mine.
    const response = await json(world, a, [{ url: "https://example.com/theirs" }, { url: "https://example.com/mine" }]);
    const result = ImportResultSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(result.created).toBe(1);
    expect(result.skipped.map((entry) => [entry.url, entry.reason])).toEqual([["https://example.com/mine", "duplicate"]]);
    expect(await written()).toEqual(before);
  });
});
