import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bearer, HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// GET /api/v1/me/go-preferences, DELETE /api/v1/me/go-preferences/{slug} and the forgetting of a stale choice by the resolution (doc 04 section 10.3, doc 02 section
// 6.4, doc 05 section 2.6, doc 10 T1 and T2), through the whole chain over the migrated database. The failure scenario: a choice remembered for `mail` on bookmark X
// survives X being renamed to `post`, and `go mail` then resolves normally and the stale row is gone.

const TEST_TIMEOUT_MS = 60_000;
const BOOKMARKS = "/api/v1/bookmarks";
const RESOLVE = "/api/v1/go/resolve";
const CHOOSE = "/api/v1/go/choose";
const PREFERENCES = "/api/v1/me/go-preferences";

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
  await database().owner`TRUNCATE pgboss.job`;
});

interface Bookmark {
  readonly id: string;
}

interface Listed {
  readonly items: readonly { slug: string; bookmarkId: string; title: string; host: string; owner: { accountId: string; displayName: string } | null }[];
  readonly nextCursor: string | null;
}

async function setup(world: World) {
  const owner = await harness.person(world);
  const member = await harness.person(world);
  const stranger = await harness.person(world);
  const shared = await harness.workspaceOf([
    { person: owner, role: "owner" },
    { person: member, role: "member" },
  ]);
  const other = await harness.workspaceOf([{ person: stranger, role: "owner" }]);
  return { owner, member, stranger, shared, other };
}

async function created(world: World, as: Person, title: string, slug: string | undefined): Promise<Bookmark> {
  const response = await send(world, "POST", BOOKMARKS, { cookie: as.cookie }, { url: `https://example.com/${encodeURIComponent(title)}`, title, ...(slug === undefined ? {} : { slug }) });
  expect(response.status).toBe(201);
  return (await response.json()) as Bookmark;
}

async function remembered(world: World, as: Person, slug: string, bookmark: Bookmark): Promise<void> {
  expect((await send(world, "POST", CHOOSE, { cookie: as.cookie }, { slug, bookmarkId: bookmark.id, remember: true })).status).toBe(200);
}

const list = (world: World, as: Person, query = "") => send(world, "GET", `${PREFERENCES}${query}`, { cookie: as.cookie });
const forget = (world: World, as: Person, slug: string) => send(world, "DELETE", `${PREFERENCES}/${encodeURIComponent(slug)}`, { cookie: as.cookie });
const resolve = (world: World, as: Person, slug: string) => send(world, "POST", RESOLVE, { cookie: as.cookie }, { slug });

async function inDatabase(statement: string, params: string[] = []): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx.unsafe(statement, params);
  });
}

async function storedSlugs(): Promise<string[]> {
  return database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    const rows = await tx<{ slug: string }[]>`SELECT slug FROM slug_preferences ORDER BY slug`;
    return rows.map((row) => row.slug);
  });
}

describe("a remembered choice whose bookmark stopped being a candidate", () => {
  it(
    "survives the rename of its bookmark, and `go mail` then resolves normally and the stale row is gone",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);
      const renamed = await created(world, owner, "Old mail", "mail");
      await remembered(world, owner, "mail", renamed);
      expect((await send(world, "PATCH", `${BOOKMARKS}/${renamed.id}`, { cookie: owner.cookie }, { slug: "post" })).status).toBe(200);
      expect(await storedSlugs()).toEqual(["mail"]);

      const unclaimed = await resolve(world, owner, "mail");

      expect(unclaimed.status).toBe(200);
      expect(await unclaimed.json()).toEqual({ result: "none" });
      expect(await storedSlugs()).toEqual([]);
      const newMail = await created(world, owner, "New mail", "mail");
      expect(await (await resolve(world, owner, "mail")).json()).toMatchObject({ result: "single", bookmark: { id: newMail.id } });
      expect(await (await resolve(world, owner, "post")).json()).toMatchObject({ result: "single", bookmark: { id: renamed.id } });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "is ignored for the caller's other bookmark of the slug and deleted when forwarding was turned off, the slug cleared or the bookmark made unreadable",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);
      const first = await created(world, owner, "First", "mail");
      await remembered(world, owner, "mail", first);

      expect((await send(world, "PATCH", `${BOOKMARKS}/${first.id}`, { cookie: owner.cookie }, { forwarding: false })).status).toBe(200);
      expect(await storedSlugs()).toEqual(["mail"]);
      expect(await (await resolve(world, owner, "mail")).json()).toEqual({ result: "none" });
      expect(await storedSlugs()).toEqual([]);

      const second = await created(world, owner, "Second", "inbox");
      await remembered(world, owner, "inbox", second);
      await inDatabase("UPDATE bookmarks SET owner_id = NULL WHERE id = $1", [second.id]);
      expect(await (await resolve(world, owner, "inbox")).json()).toEqual({ result: "none" });
      expect(await storedSlugs()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "is kept, though ignored, while its bookmark is only plan-archived",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);
      const mail = await created(world, owner, "Mail", "mail");
      await remembered(world, owner, "mail", mail);
      await inDatabase("UPDATE bookmarks SET plan_archived_at = now() WHERE id = $1", [mail.id]);

      expect(await (await resolve(world, owner, "mail")).json()).toEqual({ result: "none" });

      expect(await storedSlugs()).toEqual(["mail"]);
      expect((await (await list(world, owner)).json()) as Listed).toEqual({ items: [], nextCursor: null });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "is removed with its bookmark when the bookmark is deleted",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);
      const mail = await created(world, owner, "Mail", "mail");
      await remembered(world, owner, "mail", mail);

      expect((await send(world, "DELETE", `${BOOKMARKS}/${mail.id}`, { cookie: owner.cookie })).status).toBe(204);

      expect(await storedSlugs()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("GET /me/go-preferences", () => {
  it(
    "lists the caller's choices in the order of the slugs, by bookmark identifier, title, host and owner, and never an address",
    async () => {
      const world = harness.serve();
      const { owner, member } = await setup(world);
      const mail = await created(world, owner, "Mail", "mail");
      const inbox = await created(world, owner, "Inbox", "inbox");
      const theirs = await created(world, member, "Theirs", "theirs");
      await remembered(world, owner, "mail", mail);
      await remembered(world, owner, "inbox", inbox);
      await remembered(world, member, "theirs", theirs);

      const response = await list(world, owner);

      expect(response.status).toBe(200);
      const body = (await response.json()) as Listed;
      expect(body).toEqual({
        items: [
          { slug: "inbox", bookmarkId: inbox.id, title: "Inbox", host: "example.com", owner: null },
          { slug: "mail", bookmarkId: mail.id, title: "Mail", host: "example.com", owner: null },
        ],
        nextCursor: null,
      });
      expect(JSON.stringify(body)).not.toContain("https://");
      expect(((await (await list(world, member)).json()) as Listed).items.map((item) => item.slug)).toEqual(["theirs"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "pages with the signed cursor, and refuses a cursor of another account, an altered one and a query it does not know",
    async () => {
      const world = harness.serve();
      const { owner, member } = await setup(world);
      for (const slug of ["a", "b", "c"]) {
        await remembered(world, owner, slug, await created(world, owner, slug, slug));
      }

      const first = (await (await list(world, owner, "?limit=2")).json()) as Listed;
      expect(first.items.map((item) => item.slug)).toEqual(["a", "b"]);
      const cursor = first.nextCursor ?? "";
      expect(cursor).not.toBe("");
      const second = (await (await list(world, owner, `?limit=2&cursor=${encodeURIComponent(cursor)}`)).json()) as Listed;
      expect(second).toMatchObject({ items: [{ slug: "c" }], nextCursor: null });

      for (const [as, bad] of [[member, cursor], [owner, `${cursor}x`], [owner, "garbage"]] as const) {
        const response = await list(world, as, `?cursor=${encodeURIComponent(bad)}`);
        expect(response.status, bad).toBe(400);
        expect(((await response.json()) as { code: string }).code).toBe("bad_request");
      }
      expect((await list(world, owner, "?limit=0")).status).toBe(422);
      expect((await list(world, owner, "?limit=101")).status).toBe(422);
      expect((await list(world, owner, "?sort=name")).status).toBe(422);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "needs a session or a token, and a token that may only read can list",
    async () => {
      const world = harness.serve();
      const { owner, shared } = await setup(world);
      const mail = await created(world, owner, "Mail", "mail");
      await remembered(world, owner, "mail", mail);
      const readOnly = await harness.token(shared.workspaceId, owner, "read");

      expect((await send(world, "GET", PREFERENCES, {})).status).toBe(401);
      const asToken = await send(world, "GET", PREFERENCES, bearer(readOnly));
      expect(asToken.status).toBe(200);
      expect(((await asToken.json()) as Listed).items.map((item) => item.slug)).toEqual(["mail"]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("DELETE /me/go-preferences/{slug}", () => {
  it(
    "forgets the caller's choice for the slug with 204, in any case of the slug, and leaves the bookmark and the other choices",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);
      const mail = await created(world, owner, "Mail", "mail");
      const inbox = await created(world, owner, "Inbox", "inbox");
      await remembered(world, owner, "mail", mail);
      await remembered(world, owner, "inbox", inbox);

      expect((await forget(world, owner, " MAIL ")).status).toBe(204);

      expect(await storedSlugs()).toEqual(["inbox"]);
      expect(await (await resolve(world, owner, "mail")).json()).toMatchObject({ result: "single", bookmark: { id: mail.id } });
      expect((await send(world, "GET", `${BOOKMARKS}/${mail.id}`, { cookie: owner.cookie })).status).toBe(200);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 404 for a choice the caller has not got: never remembered, forgotten before, outside the grammar, another member's and another workspace's",
    async () => {
      const world = harness.serve();
      const { owner, member, stranger } = await setup(world);
      const mine = await created(world, owner, "Mine", "mine");
      const theirs = await created(world, member, "Theirs", "theirs");
      const inB = await created(world, stranger, "In B", "in-b");
      await remembered(world, owner, "mine", mine);
      await remembered(world, member, "theirs", theirs);
      await remembered(world, stranger, "in-b", inB);
      expect((await forget(world, owner, "mine")).status).toBe(204);

      for (const slug of ["mine", "never", "theirs", "in-b", "not a slug", "-x", "a".repeat(65)]) {
        const response = await forget(world, owner, slug);
        expect(response.status, slug).toBe(404);
        expect(((await response.json()) as { code: string }).code, slug).toBe("not_found");
      }

      expect(await storedSlugs()).toEqual(["in-b", "theirs"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "needs a session or a token that may write, and is refused for a token that may only read",
    async () => {
      const world = harness.serve();
      const { owner, shared } = await setup(world);
      const mail = await created(world, owner, "Mail", "mail");
      await remembered(world, owner, "mail", mail);
      const readOnly = await harness.token(shared.workspaceId, owner, "read");
      const readWrite = await harness.token(shared.workspaceId, owner, "read-write");

      expect((await send(world, "DELETE", `${PREFERENCES}/mail`, {})).status).toBe(401);
      const refused = await send(world, "DELETE", `${PREFERENCES}/mail`, bearer(readOnly));
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { code: string }).code).toBe("token_scope");
      expect(await storedSlugs()).toEqual(["mail"]);

      expect((await send(world, "DELETE", `${PREFERENCES}/mail`, bearer(readWrite))).status).toBe(204);
      expect(await storedSlugs()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
