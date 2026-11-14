import { archiveBookmarks, restoreBookmarks } from "@slugbase/core";
import { bookmarkArchiveTransaction } from "@slugbase/db";
import { assertBookmarkCountMatches, useTestDatabase } from "@slugbase/testing/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "../../src/auth/uuidv7.ts";
import { tenantDatabase } from "../contract/support.ts";
import { bearer, HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// GET /api/v1/bookmarks/archived (doc 04 sections 6.1 and 10.6, doc 02 section 5.6, doc 03 section 3.6, Q42, doc 10 T1 and T2), through the whole chain over the migrated database. CE never
// archives a bookmark, so the archive service of doc 01 section 13.3 stands for the composition that does. The failure scenarios: another member's archived bookmark, another
// workspace's, or a bookmark that is not archived that appears in the page or the total; a bookmark that stays listed after its owner restored or deleted it; and a cursor issued to
// another member, for another workspace or by the list of all bookmarks that is opened instead of refused.

const TEST_TIMEOUT_MS = 60_000;
const BOOKMARKS = "/api/v1/bookmarks";
const ARCHIVED = `${BOOKMARKS}/archived`;

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

interface Listed {
  readonly items: readonly { readonly id: string; readonly title: string; readonly ownerId: string | null; readonly planArchivedAt: string; readonly pinned: boolean; readonly owner?: unknown }[];
  readonly nextCursor: string | null;
  readonly total: number | null;
  readonly totalAtLeast?: number;
}

const list = (world: World, as: Person, query = "") => send(world, "GET", `${ARCHIVED}${query === "" ? "" : `?${query}`}`, { cookie: as.cookie });

async function listed(world: World, as: Person, query = ""): Promise<Listed> {
  const response = await list(world, as, query);
  expect(response.status).toBe(200);
  return (await response.json()) as Listed;
}

const titles = (page: Listed): string[] => page.items.map((item) => item.title);

async function created(world: World, as: Person, title: string): Promise<string> {
  const response = await send(world, "POST", BOOKMARKS, { cookie: as.cookie }, { url: `https://example.com/${encodeURIComponent(title)}`, title });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

/** What a composition's job does: archive the bookmarks, or restore them, in a tenant transaction of the workspace. */
async function archive(workspaceId: string, as: Person, bookmarkIds: readonly string[]): Promise<void> {
  await tenantDatabase(database()).withTenant({ accountId: as.account.id, workspaceId, requestId: "fixture-archive" }, async (tx) => {
    await archiveBookmarks(bookmarkArchiveTransaction(tx, uuidv7), { workspaceId, bookmarkIds });
  });
}

async function restore(workspaceId: string, as: Person, bookmarkIds: readonly string[]): Promise<void> {
  await tenantDatabase(database()).withTenant({ accountId: as.account.id, workspaceId, requestId: "fixture-restore" }, async (tx) => {
    await restoreBookmarks(bookmarkArchiveTransaction(tx, uuidv7), { workspaceId, bookmarkIds });
  });
}

/** Switches the session of the person to the workspace. */
async function actIn(world: World, as: Person, workspaceId: string): Promise<void> {
  const switched = await send(world, "PUT", "/api/v1/session/active-workspace", { cookie: as.cookie }, { workspaceId });
  expect(switched.status).toBe(204);
}

/** An owner and a member of a shared workspace, a stranger with a workspace of their own that the owner is a member of too; the owner acts in the shared one. */
async function setup(world: World) {
  const owner = await harness.person(world);
  const member = await harness.person(world);
  const stranger = await harness.person(world);
  const shared = await harness.workspaceOf([{ person: owner, role: "owner" }, { person: member, role: "member" }]);
  const other = await harness.workspaceOf([{ person: stranger, role: "owner" }, { person: owner, role: "member" }]);
  await actIn(world, owner, shared.workspaceId);
  return { owner, member, stranger, shared, other };
}

/** Archives each bookmark in a transaction of its own, so each has its own instant: the order of the archiving is the order of the list, reversed. */
async function archiveInTurn(workspaceId: string, as: Person, bookmarkIds: readonly string[]): Promise<void> {
  for (const id of bookmarkIds) {
    await archive(workspaceId, as, [id]);
  }
}

describe("listArchivedBookmarks", () => {
  it(
    "lists the caller's own archived bookmarks of the workspace and no live one, no other member's and no other workspace's, and follows a restore and a deletion",
    async () => {
      const world = harness.serve();
      const { owner, member, stranger, shared, other } = await setup(world);
      const ownerKept = await created(world, owner, "owner live");
      const ownerOne = await created(world, owner, "owner archived 1");
      const ownerTwo = await created(world, owner, "owner archived 2");
      const memberKept = await created(world, member, "member live");
      const memberArchived = await created(world, member, "member archived");
      const strangerArchived = await created(world, stranger, "stranger archived");
      await archiveInTurn(shared.workspaceId, owner, [ownerOne, ownerTwo, memberArchived]);
      await archive(other.workspaceId, stranger, [strangerArchived]);

      const page = await listed(world, owner);
      expect(titles(page)).toEqual(["owner archived 2", "owner archived 1"]);
      expect(page).toMatchObject({ nextCursor: null, total: 2 });
      expect(page.items.every((item) => item.ownerId === owner.account.id && item.owner === null && !item.pinned)).toBe(true);
      expect(page.items.every((item) => !Number.isNaN(Date.parse(item.planArchivedAt)))).toBe(true);
      expect(page.items.map((item) => item.id)).not.toContain(ownerKept);
      expect(titles(await listed(world, member))).toEqual(["member archived"]);
      expect(await listed(world, stranger)).toMatchObject({ items: [{ title: "stranger archived" }], total: 1 });
      expect(memberKept).not.toBe("");

      // A bookmark restored through the archive service is gone from the next page.
      await restore(shared.workspaceId, owner, [ownerOne]);
      expect(await listed(world, owner)).toMatchObject({ items: [{ id: ownerTwo }], total: 1 });

      // So is one its owner deletes through the delete operation, and the other member's list is left alone.
      expect((await send(world, "DELETE", `${BOOKMARKS}/${ownerTwo}`, { cookie: owner.cookie })).status).toBe(204);
      expect(await listed(world, owner)).toEqual({ items: [], nextCursor: null, total: 0 });
      expect(titles(await listed(world, member))).toEqual(["member archived"]);
    },
    TEST_TIMEOUT_MS,
  );

  it("lists in the active workspace of the caller only: the other workspace's archived bookmarks of the same account are not in it", async () => {
    const world = harness.serve();
    const { owner, shared, other } = await setup(world);
    const here = await created(world, owner, "in the shared workspace");
    await archive(shared.workspaceId, owner, [here]);

    expect(titles(await listed(world, owner))).toEqual(["in the shared workspace"]);
    await actIn(world, owner, other.workspaceId);
    expect(await listed(world, owner)).toEqual({ items: [], nextCursor: null, total: 0 });
  });

  it("answers an empty page with a total of 0 when nothing is archived", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    await created(world, owner, "live");

    expect(await listed(world, owner)).toEqual({ items: [], nextCursor: null, total: 0 });
  });

  it("pages through the archived bookmarks, newest archived first and the identifier as the tiebreak, each exactly once, with the total of all pages", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    const inTurn: string[] = [];
    for (let n = 0; n < 4; n += 1) {
      inTurn.push(await created(world, owner, `turn ${String(n)}`));
    }
    const together: string[] = [];
    for (let n = 0; n < 5; n += 1) {
      together.push(await created(world, owner, `together ${String(n)}`));
    }
    await archiveInTurn(shared.workspaceId, owner, inTurn);
    await archive(shared.workspaceId, owner, together);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 20; pages += 1) {
      const page: Listed = await listed(world, owner, `limit=2${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`);
      expect(page.total).toBe(9);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      if (cursor === null) {
        break;
      }
    }

    expect(new Set(seen).size).toBe(9);
    // The five archived in one instant come first, the identifier descending among them; then the four archived in turn, the last archived first.
    expect(seen.slice(0, 5)).toEqual([...together].sort().reverse());
    expect(seen.slice(5)).toEqual([...inTurn].reverse());
    expect(await list(world, owner, "limit=0")).toHaveProperty("status", 422);
    expect(await list(world, owner, "limit=101")).toHaveProperty("status", 422);
    expect(await list(world, owner, "scope=all")).toHaveProperty("status", 422);
  }, TEST_TIMEOUT_MS);

  it("refuses a cursor issued to another member, for another workspace, by the list of all bookmarks, or altered, with 400 bad_request, and opens it again for its owner", async () => {
    const world = harness.serve();
    const { owner, member, shared, other } = await setup(world);
    const ownersIds: string[] = [];
    const membersIds: string[] = [];
    const elsewhere: string[] = [];
    for (let n = 0; n < 3; n += 1) {
      ownersIds.push(await created(world, owner, `owner ${String(n)}`));
      membersIds.push(await created(world, member, `member ${String(n)}`));
    }
    // Two live bookmarks, so that the list of all bookmarks has a cursor to offer.
    await created(world, owner, "owner live 1");
    await created(world, owner, "owner live 2");
    await archiveInTurn(shared.workspaceId, owner, ownersIds);
    await archiveInTurn(shared.workspaceId, member, membersIds);
    await actIn(world, owner, other.workspaceId);
    for (let n = 0; n < 3; n += 1) {
      elsewhere.push(await created(world, owner, `elsewhere ${String(n)}`));
    }
    await archiveInTurn(other.workspaceId, owner, elsewhere);
    await actIn(world, owner, shared.workspaceId);

    const first = await listed(world, owner, "limit=1");
    const cursor = encodeURIComponent(first.nextCursor ?? "");
    expect(first.nextCursor).not.toBeNull();
    const everyone = await send(world, "GET", `${BOOKMARKS}?scope=all&limit=1`, { cookie: owner.cookie });
    const ofTheList = ((await everyone.json()) as { nextCursor: string | null }).nextCursor ?? "";
    expect(ofTheList).not.toBe("");
    const issued = first.nextCursor ?? "";
    // The payload with its first character changed, under the signature of the original.
    const forged = `${issued.startsWith("A") ? "B" : "A"}${issued.slice(1)}`;

    expect((await list(world, member, `limit=1&cursor=${cursor}`)).status).toBe(400);
    expect((await list(world, owner, `limit=1&cursor=${encodeURIComponent(ofTheList)}`)).status).toBe(400);
    expect((await list(world, owner, `limit=1&cursor=${encodeURIComponent(forged)}`)).status).toBe(400);
    expect((await send(world, "GET", `${BOOKMARKS}?limit=1&cursor=${cursor}`, { cookie: owner.cookie })).status).toBe(400);
    const refused = await list(world, member, `cursor=${cursor}`);
    expect(refused.headers.get("content-type")).toContain("application/problem+json");
    expect(await refused.json()).toMatchObject({ code: "bad_request" });
    // In another workspace the same account is given another list, whose cursor this one does not open.
    await actIn(world, owner, other.workspaceId);
    expect((await list(world, owner, `limit=1&cursor=${cursor}`)).status).toBe(400);
    await actIn(world, owner, shared.workspaceId);
    const next = await listed(world, owner, `limit=1&cursor=${cursor}`);
    expect(next.items).toHaveLength(1);
    expect(next.items[0]?.ownerId).toBe(owner.account.id);
  }, TEST_TIMEOUT_MS);

  it("is refused without a session with 401 and to an account that acts in no workspace with 404, and a read-only token lists its own workspace's archived bookmarks", async () => {
    const world = harness.serve();
    const { owner, stranger, shared, other } = await setup(world);
    const homeless = await harness.person(world);
    const mine = await created(world, owner, "owner archived");
    await archive(shared.workspaceId, owner, [mine]);
    const readOnly = await harness.token(shared.workspaceId, owner, "read");
    const strangerToken = await harness.token(other.workspaceId, stranger, "read");

    expect((await send(world, "GET", ARCHIVED, {})).status).toBe(401);
    const noWorkspace = await list(world, homeless);
    expect(noWorkspace.status).toBe(404);
    expect(await noWorkspace.json()).toMatchObject({ code: "not_found" });
    expect(titles((await (await send(world, "GET", ARCHIVED, bearer(readOnly))).json()) as Listed)).toEqual(["owner archived"]);
    expect(((await (await send(world, "GET", ARCHIVED, bearer(strangerToken))).json()) as Listed).items).toEqual([]);
  });
});
