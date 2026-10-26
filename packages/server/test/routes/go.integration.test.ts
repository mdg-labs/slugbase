import { createUsageStore, type OpenCount } from "@slugbase/db";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createUsageBuffer, type UsageBuffer } from "../../src/usage/buffer.ts";
import { appUrl } from "../contract/support.ts";
import { recordingLogger } from "../support.ts";
import { ACTIVE_WORKSPACE, bearer, HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// POST /api/v1/go/resolve and POST /api/v1/go/choose (doc 04 section 10.8, doc 02 sections 6.2 to 6.4, Q25, doc 10 T1, T2 and T12), through the whole
// chain over the migrated database. The failure scenario: a member of workspace A resolves and chooses a slug that exists only in workspace B, a bookmark
// that does not forward, a plan-archived one and another member's private bookmark with the same slug, and every resolution answers none and every choice
// 404 slug_not_found, with no address named, no preference written and no use counted.

const TEST_TIMEOUT_MS = 60_000;
const BOOKMARKS = "/api/v1/bookmarks";
const RESOLVE = "/api/v1/go/resolve";
const CHOOSE = "/api/v1/go/choose";

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

/** A usage buffer over the test database that records what each flush wrote; its timer is never started, so a test flushes when it means to. */
function observedBuffer(): { readonly usage: UsageBuffer; readonly written: OpenCount[][]; readonly close: () => Promise<void> } {
  const store = createUsageStore({ url: appUrl(database()), poolSize: 2 });
  const written: OpenCount[][] = [];
  const usage = createUsageBuffer({
    store: {
      flush: (opens) => {
        written.push([...opens]);
        return store.flush(opens);
      },
      close: () => store.close(),
    },
    logger: recordingLogger(),
  });
  return { usage, written, close: () => store.close() };
}

const resolve = (world: World, as: Person, slug: string) => send(world, "POST", RESOLVE, { cookie: as.cookie }, { slug });
const choose = (world: World, as: Person, body: unknown) => send(world, "POST", CHOOSE, { cookie: as.cookie }, body);

async function created(world: World, as: Person, title: string, slug: string | undefined, forwarding?: boolean): Promise<Bookmark> {
  const response = await send(world, "POST", BOOKMARKS, { cookie: as.cookie }, { url: `https://example.com/${encodeURIComponent(title)}`, title, ...(slug === undefined ? {} : { slug }), ...(forwarding === undefined ? {} : { forwarding }) });
  expect(response.status).toBe(201);
  return (await response.json()) as Bookmark;
}

async function inDatabase(statement: string, params: string[] = []): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx.unsafe(statement, params);
  });
}

interface Preference {
  readonly workspace_id: string;
  readonly account_id: string;
  readonly slug: string;
  readonly bookmark_id: string;
}

async function preferences(): Promise<Preference[]> {
  return database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<Preference[]>`SELECT workspace_id, account_id, slug, bookmark_id FROM slug_preferences ORDER BY slug`;
  });
}

/** A workspace of an owner and a member, and one of a stranger. */
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

describe("POST /go/resolve", () => {
  it(
    "answers single for the caller's own forwarding bookmark, with what the caller needs to choose it and no address",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);
      const mail = await created(world, owner, "Mail", "mail");

      const response = await resolve(world, owner, "mail");

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ result: "single", bookmark: { id: mail.id, title: "Mail", host: "example.com", owner: null, sharedVia: null } });
      expect(JSON.stringify(body)).not.toContain("https://");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "trims and lower-cases the slug, and answers none for one that is not a slug",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);
      const mail = await created(world, owner, "Mail", "mail");

      expect(await (await resolve(world, owner, "  MAIL ")).json()).toMatchObject({ result: "single", bookmark: { id: mail.id } });
      for (const slug of ["", "   ", "-mail", "ma il", "mail/inbox", "mail?x=1", "a".repeat(65), "ä"]) {
        const response = await resolve(world, owner, slug);
        expect(response.status, JSON.stringify(slug)).toBe(200);
        expect(await response.json(), JSON.stringify(slug)).toEqual({ result: "none", otherWorkspaces: [] });
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers none for a slug that exists only in another workspace, does not forward, is plan-archived, or is another member's private bookmark",
    async () => {
      const world = harness.serve();
      const { owner, member, stranger } = await setup(world);
      await created(world, stranger, "Only in B", "only-in-b");
      await created(world, owner, "Paused", "paused", false);
      const archived = await created(world, owner, "Archived", "archived");
      await inDatabase("UPDATE bookmarks SET plan_archived_at = now() WHERE id = $1", [archived.id]);
      await created(world, member, "Private", "private");

      for (const slug of ["only-in-b", "paused", "archived", "private"]) {
        const response = await resolve(world, owner, slug);
        expect(response.status, slug).toBe(200);
        expect(await response.json(), slug).toEqual({ result: "none", otherWorkspaces: [] });
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "names, on a none, the member's other workspaces where the slug resolves for the member, and not one the member is no member of or where the slug is another member's private bookmark",
    async () => {
      const world = harness.serve();
      const owner = await harness.person(world);
      const member = await harness.person(world);
      const stranger = await harness.person(world);
      // Workspace B, of which the caller is a member, and C, of which the caller is not, and D, of which the caller is a member, hold the slug; D holds it as another member's bookmark.
      const b = await harness.workspaceOf([{ person: owner, role: "owner" }]);
      await created(world, owner, "Mail in B", "mail");
      await harness.workspaceOf([{ person: stranger, role: "owner" }]);
      await created(world, stranger, "Mail in C", "mail");
      await harness.workspaceOf([
        { person: owner, role: "member" },
        { person: member, role: "owner" },
      ]);
      await created(world, member, "Mail in D", "mail");
      await harness.workspaceOf([{ person: owner, role: "owner" }]);

      const response = await resolve(world, owner, "mail");

      expect(response.status).toBe(200);
      const body = (await response.json()) as { result: string; otherWorkspaces: { id: string; name: string }[] };
      expect(body.result).toBe("none");
      expect(body.otherWorkspaces.map((workspace) => workspace.id)).toEqual([b.workspaceId]);
      expect(Object.keys(body.otherWorkspaces[0] ?? {}).toSorted()).toEqual(["id", "name"]);
      expect(JSON.stringify(body)).not.toContain("https://");
      expect(JSON.stringify(body)).not.toContain("Mail in");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "names no other workspace to a token, which is bound to its workspace, where a session of the same account names one",
    async () => {
      const world = harness.serve();
      const owner = await harness.person(world);
      const b = await harness.workspaceOf([{ person: owner, role: "owner" }]);
      await created(world, owner, "Payroll in B", "payroll");
      const a = await harness.workspaceOf([{ person: owner, role: "owner" }]);
      const readWrite = await harness.token(a.workspaceId, owner, "read-write");

      const asSession = (await (await resolve(world, owner, "payroll")).json()) as { result: string; otherWorkspaces: { id: string }[] };
      expect(asSession.otherWorkspaces.map((workspace) => workspace.id)).toEqual([b.workspaceId]);
      const asToken = await send(world, "POST", RESOLVE, bearer(readWrite), { slug: "payroll" });
      expect(asToken.status).toBe(200);
      expect(await asToken.json()).toEqual({ result: "none", otherWorkspaces: [] });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "offers a workspace to switch to but never forwards across workspaces, and switching stays the explicit request",
    async () => {
      const world = harness.serve();
      const owner = await harness.person(world);
      const b = await harness.workspaceOf([{ person: owner, role: "owner" }]);
      const inB = await created(world, owner, "Mail in B", "mail");
      await harness.workspaceOf([{ person: owner, role: "owner" }]);

      const offered = (await (await resolve(world, owner, "mail")).json()) as { result: string; otherWorkspaces: { id: string }[] };
      expect(offered.result).toBe("none");
      expect(offered.otherWorkspaces.map((workspace) => workspace.id)).toEqual([b.workspaceId]);
      expect((await choose(world, owner, { slug: "mail", bookmarkId: inB.id })).status).toBe(404);

      expect((await send(world, "PUT", ACTIVE_WORKSPACE, { cookie: owner.cookie }, { workspaceId: b.workspaceId })).status).toBe(204);
      expect(await (await resolve(world, owner, "mail")).json()).toMatchObject({ result: "single", bookmark: { id: inB.id } });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "names no other workspace for a resolution that finds a bookmark, nor for a slug outside the grammar",
    async () => {
      const world = harness.serve();
      const owner = await harness.person(world);
      await harness.workspaceOf([{ person: owner, role: "owner" }]);
      await created(world, owner, "Mail in B", "mail");
      await harness.workspaceOf([{ person: owner, role: "owner" }]);
      const own = await created(world, owner, "Mail in A", "mail");

      expect(await (await resolve(world, owner, "mail")).json()).toEqual({ result: "single", bookmark: { id: own.id, title: "Mail in A", host: "example.com", owner: null, sharedVia: null } });
      expect(await (await resolve(world, owner, "ma il")).json()).toEqual({ result: "none", otherWorkspaces: [] });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps two members' bookmarks of one slug apart: each resolves their own",
    async () => {
      const world = harness.serve();
      const { owner, member } = await setup(world);
      const mine = await created(world, owner, "Owner mail", "mail");
      const theirs = await created(world, member, "Member mail", "mail");

      expect(await (await resolve(world, owner, "mail")).json()).toMatchObject({ result: "single", bookmark: { id: mine.id } });
      expect(await (await resolve(world, member, "mail")).json()).toMatchObject({ result: "single", bookmark: { id: theirs.id } });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers preferred once the caller has chosen the bookmark and asked to remember it",
    async () => {
      const { usage, close } = observedBuffer();
      const world = harness.serve({ usage });
      const { owner } = await setup(world);
      const mail = await created(world, owner, "Mail", "mail");

      expect((await choose(world, owner, { slug: "mail", bookmarkId: mail.id, remember: true })).status).toBe(200);

      expect(await (await resolve(world, owner, "mail")).json()).toEqual({ result: "preferred", bookmark: { id: mail.id, title: "Mail", host: "example.com", owner: null, sharedVia: null } });
      await usage.stop();
      await close();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "counts no use and writes nothing",
    async () => {
      const { usage, written, close } = observedBuffer();
      const world = harness.serve({ usage });
      const { owner } = await setup(world);
      await created(world, owner, "Mail", "mail");

      await resolve(world, owner, "mail");
      await usage.flush();

      expect(written).toEqual([]);
      expect(await preferences()).toEqual([]);
      await usage.stop();
      await close();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "needs a session or a token that may write (a POST takes the write scope though it writes nothing), and refuses a body that is not { slug }",
    async () => {
      const world = harness.serve();
      const { owner, shared } = await setup(world);
      await created(world, owner, "Mail", "mail");
      const readOnly = await harness.token(shared.workspaceId, owner, "read");
      const readWrite = await harness.token(shared.workspaceId, owner, "read-write");

      expect((await send(world, "POST", RESOLVE, {}, { slug: "mail" })).status).toBe(401);
      const refused = await send(world, "POST", RESOLVE, bearer(readOnly), { slug: "mail" });
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { code: string }).code).toBe("token_scope");
      const asToken = await send(world, "POST", RESOLVE, bearer(readWrite), { slug: "mail" });
      expect(asToken.status).toBe(200);
      expect(await asToken.json()).toMatchObject({ result: "single" });
      expect((await send(world, "POST", RESOLVE, { cookie: owner.cookie }, {})).status).toBe(422);
      expect((await send(world, "POST", RESOLVE, { cookie: owner.cookie }, { slug: "mail", extra: 1 })).status).toBe(422);
      expect((await send(world, "POST", RESOLVE, { cookie: owner.cookie }, { slug: 7 })).status).toBe(422);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("POST /go/choose", () => {
  it(
    "answers the destination and counts one use, remembering nothing unless asked",
    async () => {
      const { usage, written, close } = observedBuffer();
      const world = harness.serve({ usage });
      const { owner } = await setup(world);
      const mail = await created(world, owner, "Mail", "mail");

      const response = await choose(world, owner, { slug: "Mail", bookmarkId: mail.id, remember: false });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ url: "https://example.com/Mail" });
      expect((await choose(world, owner, { slug: "mail", bookmarkId: mail.id })).status).toBe(200);
      await usage.flush();
      expect(written.flat().map((entry) => [entry.bookmarkId, entry.count])).toEqual([[mail.id, 2]]);
      expect(await preferences()).toEqual([]);
      await usage.stop();
      await close();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "remembers the choice for the slug in lower case when asked, once however often it is repeated",
    async () => {
      const { usage, close } = observedBuffer();
      const world = harness.serve({ usage });
      const { owner, shared } = await setup(world);
      const mail = await created(world, owner, "Mail", "mail");

      for (let index = 0; index < 3; index += 1) {
        expect((await choose(world, owner, { slug: " MAIL", bookmarkId: mail.id, remember: true })).status).toBe(200);
      }

      expect(await preferences()).toEqual([{ workspace_id: shared.workspaceId, account_id: owner.account.id, slug: "mail", bookmark_id: mail.id }]);
      await usage.stop();
      await close();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 404 slug_not_found for a bookmark that is no current candidate of the slug, and remembers and counts nothing",
    async () => {
      const { usage, written, close } = observedBuffer();
      const world = harness.serve({ usage });
      const { owner, member, stranger } = await setup(world);
      const mail = await created(world, owner, "Mail", "mail");
      const inB = await created(world, stranger, "Only in B", "only-in-b");
      const paused = await created(world, owner, "Paused", "paused", false);
      const archived = await created(world, owner, "Archived", "archived");
      await inDatabase("UPDATE bookmarks SET plan_archived_at = now() WHERE id = $1", [archived.id]);
      const private_ = await created(world, member, "Private", "private");
      const attempts: readonly [string, string][] = [
        ["only-in-b", inB.id],
        ["paused", paused.id],
        ["archived", archived.id],
        ["private", private_.id],
        ["mail", private_.id],
        ["private", mail.id],
        ["other", mail.id],
        ["mail", "0192f3a0-ffff-7000-8000-000000000001"],
        ["not a slug", mail.id],
        ["", mail.id],
      ];

      for (const [slug, bookmarkId] of attempts) {
        for (const remember of [true, false]) {
          const response = await choose(world, owner, { slug, bookmarkId, remember });
          expect(response.status, `${slug} ${bookmarkId}`).toBe(404);
          expect(((await response.json()) as { code: string }).code, `${slug} ${bookmarkId}`).toBe("slug_not_found");
        }
      }

      await usage.flush();
      expect(written).toEqual([]);
      expect(await preferences()).toEqual([]);
      await usage.stop();
      await close();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "needs a session or a token that may write, and refuses a body that is not { slug, bookmarkId, remember }",
    async () => {
      const { usage, written, close } = observedBuffer();
      const world = harness.serve({ usage });
      const { owner, shared } = await setup(world);
      const mail = await created(world, owner, "Mail", "mail");
      const readOnly = await harness.token(shared.workspaceId, owner, "read");
      const readWrite = await harness.token(shared.workspaceId, owner, "read-write");
      const body = { slug: "mail", bookmarkId: mail.id, remember: true };

      expect((await send(world, "POST", CHOOSE, {}, body)).status).toBe(401);
      const refused = await send(world, "POST", CHOOSE, bearer(readOnly), body);
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { code: string }).code).toBe("token_scope");
      for (const bad of [{}, { slug: "mail" }, { slug: "mail", bookmarkId: "not-an-id" }, { ...body, remember: "yes" }, { ...body, extra: true }]) {
        expect((await choose(world, owner, bad)).status, JSON.stringify(bad)).toBe(422);
      }
      await usage.flush();
      expect(written).toEqual([]);
      expect(await preferences()).toEqual([]);

      expect((await send(world, "POST", CHOOSE, bearer(readWrite), body)).status).toBe(200);
      await usage.stop();
      await close();
    },
    TEST_TIMEOUT_MS,
  );
});

describe("the go rate bucket", () => {
  it(
    "is shared by both operations: calls beyond the account's limit are 429, whichever operation makes them",
    async () => {
      const { usage, written, close } = observedBuffer();
      const world = harness.serve({ usage, env: { RATE_LIMIT_GO_ACCOUNT: "2/min" } });
      const { owner } = await setup(world);
      const mail = await created(world, owner, "Mail", "mail");

      expect((await resolve(world, owner, "mail")).status).toBe(200);
      expect((await choose(world, owner, { slug: "mail", bookmarkId: mail.id, remember: false })).status).toBe(200);
      const limitedResolve = await resolve(world, owner, "mail");
      const limitedChoose = await choose(world, owner, { slug: "mail", bookmarkId: mail.id, remember: true });

      expect(limitedResolve.status).toBe(429);
      expect(limitedChoose.status).toBe(429);
      expect(limitedResolve.headers.get("retry-after")).not.toBeNull();
      await usage.flush();
      expect(written.flat().map((entry) => entry.count)).toEqual([1]);
      expect(await preferences()).toEqual([]);
      await usage.stop();
      await close();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "limits by address as well: the limit per IP is taken before the session is looked at",
    async () => {
      const world = harness.serve({ env: { RATE_LIMIT_GO_IP: "2/min" } });
      const { owner } = await setup(world);
      await created(world, owner, "Mail", "mail");

      expect((await resolve(world, owner, "mail")).status).toBe(200);
      expect((await resolve(world, owner, "mail")).status).toBe(200);
      expect((await resolve(world, owner, "mail")).status).toBe(429);
      expect((await send(world, "POST", RESOLVE, {}, { slug: "mail" })).status).toBe(429);
    },
    TEST_TIMEOUT_MS,
  );
});
