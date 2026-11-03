import { randomUUID } from "node:crypto";
import { ExportDocumentSchema, ImportResultSchema } from "@slugbase/contracts";
import type { EntitlementCheck } from "@slugbase/core";
import { assertBookmarkCountMatches, useTestDatabase } from "@slugbase/testing/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// The remembered slug choices in the export and the import (doc 02 sections 6.4 and 13.2, doc 04 section 10.9, doc 10 T2 and T13), through the whole chain over the migrated database. The failure scenario: a choice
// whose bookmark lost its slug to a conflict, was skipped as a duplicate or failed, a choice with a ref no bookmark has or a slug outside the grammar, restores nothing and fails nothing; no choice of another member or
// workspace changes; a dry run writes no choice and a repeat with the same Idempotency-Key restores none twice.

const TEST_TIMEOUT_MS = 120_000;
const EXPORT = "/api/v1/export/json";
const IMPORT = "/api/v1/import/json";
const BOOKMARKS = "/api/v1/bookmarks";
const CHOOSE = "/api/v1/go/choose";
const PREFERENCES = "/api/v1/me/go-preferences";
const GRANTED: EntitlementCheck = (entitlement) => entitlement === "sharing.members" || entitlement === "sharing.teams" || entitlement === "teams.manage";
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

afterEach(() => assertBookmarkCountMatches(database()));

const asPerson = (as: Person): Record<string, string> => ({ cookie: as.cookie });

async function asSystem<T>(work: (tx: ReturnType<typeof database>["owner"]) => Promise<T>): Promise<T> {
  return database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return work(tx as unknown as ReturnType<typeof database>["owner"]);
  }) as Promise<T>;
}

interface Stored {
  readonly account_id: string;
  readonly slug: string;
  readonly bookmark_id: string;
}

/** Every remembered choice of the workspace as stored, so two readings compare as lists. */
const stored = (workspaceId: string) =>
  asSystem((tx) => tx<Stored[]>`SELECT account_id, slug, bookmark_id FROM slug_preferences WHERE workspace_id = ${workspaceId} ORDER BY account_id, slug`);

async function setup(world: World) {
  const a = await harness.person(world);
  const b = await harness.person(world);
  const c = await harness.person(world);
  const shared = await harness.workspaceOf([
    { person: a, role: "owner" },
    { person: b, role: "member" },
  ]);
  const elsewhere = await harness.workspaceOf([{ person: c, role: "owner" }]);
  return { a, b, c, shared, elsewhere };
}

async function create(world: World, as: Person, title: string, slug?: string): Promise<string> {
  const response = await send(world, "POST", BOOKMARKS, asPerson(as), { url: `https://example.com/${encodeURIComponent(title)}`, title, ...(slug === undefined ? {} : { slug, forwarding: true }) });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function remember(world: World, as: Person, slug: string, bookmarkId: string): Promise<void> {
  expect((await send(world, "POST", CHOOSE, asPerson(as), { slug, bookmarkId, remember: true })).status).toBe(200);
}

async function exported(world: World, as: Person) {
  const response = await send(world, "GET", EXPORT, asPerson(as));
  expect(response.status).toBe(200);
  return ExportDocumentSchema.parse(await response.json());
}

async function importAs(world: World, headers: Record<string, string>, file: unknown, query = "") {
  const response = await send(world, "POST", `${IMPORT}${query}`, headers, file);
  const body: unknown = await response.json();
  return { response, status: response.status, body };
}

async function imported(world: World, as: Person, file: unknown, query = "") {
  const answer = await importAs(world, asPerson(as), file, query);
  expect(answer.status).toBe(200);
  return ImportResultSchema.parse(answer.body);
}

const envelope = (bookmarks: object[], goPreferences?: unknown[]) => ({ format: "slugbase-export", version: 1, bookmarks, ...(goPreferences === undefined ? {} : { goPreferences }) });
const link = (ref: string, slug?: string, extra: Record<string, unknown> = {}) => ({ ref, url: `https://example.com/${ref}`, ...(slug === undefined ? {} : { slug, forwarding: true }), ...extra });

describe("GET /export/json, goPreferences", { timeout: TEST_TIMEOUT_MS }, () => {
  it("holds the caller's choices for their own bookmarks as the slug and the ref of the bookmark in the same document, in the order of the slugs, and none for another member's bookmark, another member's choice or another workspace", async () => {
    const world = harness.serve({ entitlements: GRANTED, env: RELAXED });
    const { a, b, c, shared, elsewhere } = await setup(world);
    const first = await create(world, a, "First", "zebra");
    const second = await create(world, a, "Second", "alpha");
    await create(world, a, "Plain");
    const theirs = await create(world, b, "Theirs", "wiki");
    const bsOwn = await create(world, b, "B own", "bee");
    const abroad = await create(world, c, "Abroad", "far");
    expect((await send(world, "POST", `${BOOKMARKS}/${theirs}/shares`, asPerson(b), { accountId: a.account.id })).status).toBeLessThan(300);
    await remember(world, a, "zebra", first);
    await remember(world, a, "alpha", second);
    await remember(world, a, "wiki", theirs);
    await remember(world, b, "bee", bsOwn);
    await remember(world, c, "far", abroad);
    expect((await stored(shared.workspaceId)).map((row) => row.slug).sort()).toEqual(["alpha", "bee", "wiki", "zebra"]);

    const document = await exported(world, a);

    expect(document.bookmarks.map((entry) => [entry.ref, entry.slug])).toEqual([["b1", "zebra"], ["b2", "alpha"], ["b3", null]]);
    expect(document.goPreferences).toEqual([
      { slug: "alpha", bookmarkRef: "b2" },
      { slug: "zebra", bookmarkRef: "b1" },
    ]);
    expect((await exported(world, b)).goPreferences).toEqual([{ slug: "bee", bookmarkRef: "b2" }]);
    expect((await exported(world, c)).goPreferences).toEqual([{ slug: "far", bookmarkRef: "b1" }]);
    expect(elsewhere.workspaceId).not.toBe(shared.workspaceId);
  });

  it("is empty for a member who remembered nothing, and leaves out the choice of a bookmark that stopped forwarding", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a } = await setup(world);
    const id = await create(world, a, "One", "one");
    expect((await exported(world, a)).goPreferences).toEqual([]);
    await remember(world, a, "one", id);
    expect((await exported(world, a)).goPreferences).toEqual([{ slug: "one", bookmarkRef: "b1" }]);
    expect((await send(world, "PATCH", `${BOOKMARKS}/${id}`, asPerson(a), { forwarding: false })).status).toBe(200);

    expect((await exported(world, a)).goPreferences).toEqual([]);
  });
});

describe("POST /import/json, goPreferences", { timeout: TEST_TIMEOUT_MS }, () => {
  it("round-trips a member's export into another workspace: each choice comes back for the new bookmark that has the slug", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, c, shared, elsewhere } = await setup(world);
    const one = await create(world, a, "One", "one");
    const two = await create(world, a, "Two", "two");
    await remember(world, a, "one", one);
    await remember(world, a, "two", two);
    const document = await exported(world, a);
    expect(document.goPreferences).toHaveLength(2);

    const result = await imported(world, c, document);

    expect(result).toMatchObject({ created: 2, slugsDropped: 0 });
    const idsBySlug = new Map((await asSystem((tx) => tx<{ id: string; slug: string }[]>`SELECT id, slug FROM bookmarks WHERE workspace_id = ${elsewhere.workspaceId} AND owner_id = ${c.account.id}`)).map((row) => [row.slug, row.id]));
    expect(await stored(elsewhere.workspaceId)).toEqual([
      { account_id: c.account.id, slug: "one", bookmark_id: idsBySlug.get("one") },
      { account_id: c.account.id, slug: "two", bookmark_id: idsBySlug.get("two") },
    ]);
    expect((await exported(world, c)).goPreferences).toEqual(document.goPreferences);
    expect(await stored(shared.workspaceId)).toEqual([
      { account_id: a.account.id, slug: "one", bookmark_id: one },
      { account_id: a.account.id, slug: "two", bookmark_id: two },
    ].sort((x, y) => x.slug.localeCompare(y.slug)));
  });

  it("restores nothing and fails nothing for a bookmark that lost its slug to a conflict, was skipped as a duplicate or failed, for an unknown ref, an ambiguous ref and a slug outside the grammar", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);
    await create(world, a, "Mine", "taken");
    await create(world, a, "Existing");
    const file = envelope(
      [
        link("b1", "taken"),
        link("b2", "twice"),
        link("b3", "twice"),
        { ref: "b4", url: "https://example.com/Existing", slug: "dup-slug", forwarding: true },
        { ref: "b5", url: "javascript:alert(1)", slug: "bad-slug", forwarding: true },
        link("b6", "quiet", { forwarding: false }),
        link("b7", "one", { url: "https://example.com/same-1" }),
        link("b7", "two", { url: "https://example.com/same-2" }),
      ],
      [
        { slug: "taken", bookmarkRef: "b1" },
        { slug: "twice", bookmarkRef: "b3" },
        { slug: "dup-slug", bookmarkRef: "b4" },
        { slug: "bad-slug", bookmarkRef: "b5" },
        { slug: "quiet", bookmarkRef: "b6" },
        { slug: "one", bookmarkRef: "b7" },
        { slug: "two", bookmarkRef: "b7" },
        { slug: "nothing", bookmarkRef: "b99" },
        { slug: "Not A Slug!", bookmarkRef: "b2" },
        { slug: "", bookmarkRef: "b2" },
        { slug: "twice", bookmarkRef: "" },
      ],
    );
    const before = await stored(shared.workspaceId);

    const result = await imported(world, a, file, "?skipDuplicates=true");

    expect(result.failed.map((entry) => entry.position)).toEqual([5]);
    expect(result.skipped.map((entry) => [entry.position, entry.reason])).toEqual([[4, "duplicate"]]);
    expect(result.droppedSlugs.map((entry) => entry.slug).sort()).toEqual(["taken", "twice"]);
    expect(await stored(shared.workspaceId)).toEqual(before);
  });

  it("changes no choice of another member or of another workspace, whatever slug the file chooses for", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, b, c, shared, elsewhere } = await setup(world);
    const bsMail = await create(world, b, "B mail", "mail");
    const csMail = await create(world, c, "C mail", "mail");
    await remember(world, b, "mail", bsMail);
    await remember(world, c, "mail", csMail);
    const beforeShared = await stored(shared.workspaceId);
    const beforeElsewhere = await stored(elsewhere.workspaceId);

    const result = await imported(world, a, envelope([link("b1", "mail")], [{ slug: "mail", bookmarkRef: "b1" }]));

    expect(result).toMatchObject({ created: 1 });
    const mine = (await asSystem((tx) => tx<{ id: string }[]>`SELECT id FROM bookmarks WHERE workspace_id = ${shared.workspaceId} AND owner_id = ${a.account.id}`))[0]?.id;
    expect(await stored(shared.workspaceId)).toEqual([...beforeShared, { account_id: a.account.id, slug: "mail", bookmark_id: mine }].sort((x, y) => x.account_id.localeCompare(y.account_id) || x.slug.localeCompare(y.slug)));
    expect(await stored(elsewhere.workspaceId)).toEqual(beforeElsewhere);
  });

  it("replaces the choice the caller had for the slug with the one of the file", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);
    const old = await create(world, a, "Old", "docs");
    await remember(world, a, "docs", old);
    expect((await send(world, "PATCH", `${BOOKMARKS}/${old}`, asPerson(a), { slug: "old-docs" })).status).toBe(200);

    await imported(world, a, envelope([link("b1", "docs")], [{ slug: "docs", bookmarkRef: "b1" }]));

    const created = (await asSystem((tx) => tx<{ id: string }[]>`SELECT id FROM bookmarks WHERE workspace_id = ${shared.workspaceId} AND slug = 'docs'`))[0]?.id;
    expect(await stored(shared.workspaceId)).toEqual([{ account_id: a.account.id, slug: "docs", bookmark_id: created }]);
  });

  it("writes no choice in a dry run, and the import that follows restores them", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);
    const file = envelope([link("b1", "xs"), link("b2", "ys")], [{ slug: "xs", bookmarkRef: "b1" }, { slug: "ys", bookmarkRef: "b2" }]);

    const previewed = await imported(world, a, file, "?dryRun=true");

    expect(await stored(shared.workspaceId)).toEqual([]);
    expect(previewed).toMatchObject({ created: 2 });
    expect(await imported(world, a, file)).toEqual(previewed);
    expect((await stored(shared.workspaceId)).map((row) => row.slug)).toEqual(["xs", "ys"]);
  });

  it("restores nothing twice for a repeat with the same Idempotency-Key: the answer is replayed and a choice the member has forgotten since stays forgotten", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);
    const key = randomUUID();
    const file = envelope([link("b1", "xs")], [{ slug: "xs", bookmarkRef: "b1" }]);

    const first = await importAs(world, { ...asPerson(a), "idempotency-key": key }, file);
    expect(first.status).toBe(200);
    expect(await stored(shared.workspaceId)).toHaveLength(1);
    expect((await send(world, "DELETE", `${PREFERENCES}/xs`, asPerson(a))).status).toBe(204);

    const repeat = await importAs(world, { ...asPerson(a), "idempotency-key": key }, file);

    expect(repeat.response.headers.get("idempotency-replayed")).toBe("true");
    expect(repeat.body).toEqual(first.body);
    expect(await stored(shared.workspaceId)).toEqual([]);
    expect(await asSystem((tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM bookmarks WHERE workspace_id = ${shared.workspaceId}`)).toEqual([{ n: 1 }]);
  });

  it("still imports a file from before the field and one with an empty list, and a plain array of bookmarks", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);

    expect(await imported(world, a, envelope([link("b1", "xs")]))).toMatchObject({ created: 1 });
    expect(await imported(world, a, envelope([link("b2", "ys")], []))).toMatchObject({ created: 1 });
    expect(await imported(world, a, [link("b3", "zs")])).toMatchObject({ created: 1 });
    expect(await stored(shared.workspaceId)).toEqual([]);
  });

  it("refuses an entry that is not the format as the whole file, 422, and writes nothing", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);

    for (const goPreferences of [[{ slug: "xs" }], [{ slug: "xs", bookmarkRef: "b1", extra: 1 }], [{ slug: 1, bookmarkRef: "b1" }], ["xs"], [{ slug: "s".repeat(1001), bookmarkRef: "b1" }]]) {
      const answer = await importAs(world, asPerson(a), envelope([link("b1", "xs")], goPreferences));
      expect(answer.status, JSON.stringify(goPreferences)).toBe(422);
    }
    expect(await asSystem((tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM bookmarks WHERE workspace_id = ${shared.workspaceId}`)).toEqual([{ n: 0 }]);
  });

  it("restores the choices of the largest file in one request: one choice for each bookmark that kept a slug, however often the file repeats them", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);
    const count = 5000;
    const bookmarks = Array.from({ length: count }, (_, index) => link(`b${String(index + 1)}`, `slug-${String(index + 1)}`));
    const entries = bookmarks.map((entry) => ({ slug: entry.slug, bookmarkRef: entry.ref }));

    const result = await imported(world, a, envelope(bookmarks, entries));

    expect(result.created).toBe(count);
    expect(await stored(shared.workspaceId)).toHaveLength(count);
  });
});
