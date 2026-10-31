import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EntitlementCheck } from "@slugbase/core";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// Every way of losing access to a shared bookmark ends it on the next request, and forgets the remembered `go` choices that point at what the member can no longer read
// (doc 02 sections 3.6, 4, 6.4 and 8.3, doc 05 sections 2.5 and 2.6, doc 10 T2), through the whole chain over the migrated database. The failure scenario (T2): B has a remembered choice for
// `mail` on A's bookmark, shared through a team; B is removed from the team; the next `go mail` for B does not reach A's bookmark and the Forwarding page no longer lists the
// choice. Each row of the table is one way of losing the route, asserted twice: with no other route the choice is gone from the table the moment the change commits, before
// anything resolves or lists it (the resolution and the listing ignore a stale choice themselves), and `go mail` and the Forwarding page no longer reach the bookmark; with another
// route the member keeps both the access and the choice.

const TEST_TIMEOUT_MS = 90_000;
const BOOKMARKS = "/api/v1/bookmarks";
const FOLDERS = "/api/v1/folders";
const TEAMS = "/api/v1/teams";
const MEMBERS = "/api/v1/members";
const LEAVE = "/api/v1/workspace/leave";
const RESOLVE = "/api/v1/go/resolve";
const CHOOSE = "/api/v1/go/choose";
const PREFERENCES = "/api/v1/me/go-preferences";
const SLUG = "mail";
const OWNERS_URL = "https://example.com/Owner%20mail";
const GRANTED: EntitlementCheck = (entitlement) => entitlement === "sharing.members" || entitlement === "sharing.teams" || entitlement === "teams.manage";
const RELAXED = {
  RATE_LIMIT_BULK_IP: "10000/hour",
  RATE_LIMIT_BULK_ACCOUNT: "10000/hour",
  RATE_LIMIT_WRITE_IP: "10000/min",
  RATE_LIMIT_WRITE_ACCOUNT: "10000/min",
  RATE_LIMIT_READ_IP: "10000/min",
  RATE_LIMIT_READ_ACCOUNT: "10000/min",
};
const SHELL = "<!doctype html><html><head><title>SlugBase shell</title></head><body><div id=\"root\"></div></body></html>";

const database = useTestDatabase();
const harness = workspaceHarness(database);
let webRoot: string;

beforeAll(async () => {
  webRoot = mkdtempSync(join(tmpdir(), "slugbase-access-ending-"));
  writeFileSync(join(webRoot, "index.html"), SHELL);
  await harness.start();
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await harness.stop();
  rmSync(webRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
  await database().owner`TRUNCATE pgboss.job`;
});

const as = (person: Person): Record<string, string> => ({ cookie: person.cookie });

interface Cast {
  readonly world: World;
  /** The owner of the bookmark, and of the workspace. */
  readonly owner: Person;
  /** The member who has the remembered choice. */
  readonly member: Person;
  /** The bookmark with the slug, the owner's. */
  readonly bookmark: string;
  /** The first route the member was given. */
  readonly route: Route;
}

interface Route {
  /** Takes the route away, through the operation the case is about. */
  readonly end: () => Promise<void>;
}

interface Setup {
  /** Gives the member a route to the bookmark and answers how to take it away. */
  readonly give: (world: World, owner: Person, member: Person, bookmark: string) => Promise<Route>;
}

async function idOf(response: Promise<Response>): Promise<string> {
  const settled = await response;
  expect(settled.status).toBe(201);
  return ((await settled.json()) as { id: string }).id;
}

async function okay(response: Promise<Response>, ...statuses: number[]): Promise<void> {
  expect(statuses).toContain((await response).status);
}

async function teamOf(world: World, owner: Person, members: readonly Person[]): Promise<string> {
  const id = await idOf(send(world, "POST", TEAMS, as(owner), { name: `Team ${String(Math.random()).slice(2, 8)}` }));
  await okay(send(world, "PUT", `${TEAMS}/${id}/members`, as(owner), { accountIds: members.map((entry) => entry.account.id) }), 200);
  return id;
}

async function shareId(world: World, owner: Person, path: string, target: { accountId: string } | { teamId: string }): Promise<string> {
  const response = await send(world, "POST", `${path}/shares`, as(owner), target);
  expect([200, 201]).toContain(response.status);
  return ((await response.json()) as { id: string }).id;
}

async function folderOf(world: World, owner: Person, bookmark: string): Promise<string> {
  const id = await idOf(send(world, "POST", FOLDERS, as(owner), { name: `Folder ${String(Math.random()).slice(2, 8)}` }));
  await okay(send(world, "POST", `${FOLDERS}/${id}/bookmarks`, as(owner), { bookmarkIds: [bookmark] }), 200, 204);
  return id;
}

/** A share of the bookmark with the member: the route that revoking the share ends. */
const directShare: Setup = {
  give: async (world, owner, member, bookmark) => {
    const share = await shareId(world, owner, `${BOOKMARKS}/${bookmark}`, { accountId: member.account.id });
    return { end: async () => okay(send(world, "DELETE", `${BOOKMARKS}/${bookmark}/shares/${share}`, as(owner)), 204) };
  },
};

/** A share of the bookmark with a team the member is in: revoking the team's share ends it. */
const teamShare: Setup = {
  give: async (world, owner, member, bookmark) => {
    const team = await teamOf(world, owner, [member]);
    const share = await shareId(world, owner, `${BOOKMARKS}/${bookmark}`, { teamId: team });
    return { end: async () => okay(send(world, "DELETE", `${BOOKMARKS}/${bookmark}/shares/${share}`, as(owner)), 204) };
  },
};

/** The team the bookmark is shared with, which the member leaves through the replacement of its members. */
const teamMembership: Setup = {
  give: async (world, owner, member, bookmark) => {
    const team = await teamOf(world, owner, [member]);
    await shareId(world, owner, `${BOOKMARKS}/${bookmark}`, { teamId: team });
    return { end: async () => okay(send(world, "PUT", `${TEAMS}/${team}/members`, as(owner), { accountIds: [] }), 200) };
  },
};

/** The team the bookmark is shared with, which is deleted. */
const teamDeleted: Setup = {
  give: async (world, owner, member, bookmark) => {
    const team = await teamOf(world, owner, [member]);
    await shareId(world, owner, `${BOOKMARKS}/${bookmark}`, { teamId: team });
    return { end: async () => okay(send(world, "DELETE", `${TEAMS}/${team}`, as(owner)), 204) };
  },
};

/** A shared folder the bookmark is filed in, from which the bookmark is taken out. */
const folderBookmarkRemoved: Setup = {
  give: async (world, owner, member, bookmark) => {
    const folder = await folderOf(world, owner, bookmark);
    await shareId(world, owner, `${FOLDERS}/${folder}`, { accountId: member.account.id });
    return { end: async () => okay(send(world, "DELETE", `${FOLDERS}/${folder}/bookmarks`, as(owner), { bookmarkIds: [bookmark] }), 200) };
  },
};

/** A folder shared with a team the member is in, which is deleted with the bookmark filed in it. */
const folderDeleted: Setup = {
  give: async (world, owner, member, bookmark) => {
    const team = await teamOf(world, owner, [member]);
    const folder = await folderOf(world, owner, bookmark);
    await shareId(world, owner, `${FOLDERS}/${folder}`, { teamId: team });
    return { end: async () => okay(send(world, "DELETE", `${FOLDERS}/${folder}`, as(owner)), 204) };
  },
};

/** A shared folder the bookmark is filed in, whose share with the member is revoked. */
const folderShareRevoked: Setup = {
  give: async (world, owner, member, bookmark) => {
    const folder = await folderOf(world, owner, bookmark);
    const share = await shareId(world, owner, `${FOLDERS}/${folder}`, { accountId: member.account.id });
    return { end: async () => okay(send(world, "DELETE", `${FOLDERS}/${folder}/shares/${share}`, as(owner)), 204) };
  },
};

/** The bookmark itself, which its owner deletes, with the shares on it. */
const bookmarkDeleted: Setup = {
  give: async (world, owner, member, bookmark) => {
    await shareId(world, owner, `${BOOKMARKS}/${bookmark}`, { accountId: member.account.id });
    return { end: async () => okay(send(world, "DELETE", `${BOOKMARKS}/${bookmark}`, as(owner)), 204) };
  },
};

interface Path {
  readonly name: string;
  readonly setup: Setup;
  /** The route the member keeps in the case where the member has another one; undefined when taking the route ends the member's access wholesale. */
  readonly other?: Setup;
}

const PATHS: readonly Path[] = [
  { name: "DELETE /bookmarks/{id}/shares/{shareId} revokes a share with the member", setup: directShare, other: teamShare },
  { name: "DELETE /bookmarks/{id}/shares/{shareId} revokes a share with the member's team", setup: teamShare, other: directShare },
  { name: "PUT /teams/{id}/members takes the member out of the team", setup: teamMembership, other: directShare },
  { name: "DELETE /teams/{id} deletes the team", setup: teamDeleted, other: directShare },
  { name: "DELETE /folders/{id}/bookmarks takes the bookmark out of a shared folder", setup: folderBookmarkRemoved, other: directShare },
  { name: "DELETE /folders/{id} deletes a shared folder", setup: folderDeleted, other: directShare },
  { name: "DELETE /folders/{id}/shares/{shareId} revokes a folder share", setup: folderShareRevoked, other: teamShare },
  { name: "DELETE /bookmarks/{id} deletes the shared bookmark", setup: bookmarkDeleted },
];

async function stored(): Promise<{ account_id: string; bookmark_id: string }[]> {
  return database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ account_id: string; bookmark_id: string }[]>`SELECT account_id, bookmark_id FROM slug_preferences ORDER BY slug`;
  });
}

async function sharesTo(accountId: string): Promise<number> {
  return database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    const [bookmarks] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM bookmark_shares WHERE target_account_id = ${accountId}`;
    const [folders] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM folder_shares WHERE target_account_id = ${accountId}`;
    return (bookmarks?.n ?? 0) + (folders?.n ?? 0);
  });
}

async function memberships(accountId: string): Promise<number> {
  return database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    const [row] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM team_members WHERE account_id = ${accountId}`;
    return row?.n ?? 0;
  });
}

function visit(world: World, person: Person, path: string): Promise<Response> {
  return world.server.fetch(new Request(new URL(path, world.origin), { method: "GET", headers: { accept: "text/html", cookie: person.cookie } }));
}

/** An owner who has a bookmark with the slug, a member with no bookmark of their own, and the member's route to it, with a choice remembered through the route. */
async function cast(setups: readonly Setup[]): Promise<Cast> {
  const world = harness.serve({ entitlements: GRANTED, env: RELAXED, webRoot });
  const owner = await harness.person(world);
  const member = await harness.person(world);
  await harness.workspaceOf([
    { person: owner, role: "owner" },
    { person: member, role: "member" },
  ]);
  const bookmark = await idOf(send(world, "POST", BOOKMARKS, as(owner), { url: OWNERS_URL, title: "Owner mail", slug: SLUG }));
  const routes: Route[] = [];
  for (const setup of setups) {
    routes.push(await setup.give(world, owner, member, bookmark));
  }
  const [first] = routes;
  if (first === undefined) {
    throw new Error("a case gives the member a route");
  }
  expect((await send(world, "POST", CHOOSE, as(member), { slug: SLUG, bookmarkId: bookmark, remember: true })).status).toBe(200);
  expect((await stored()).map((row) => [row.account_id, row.bookmark_id])).toEqual([[member.account.id, bookmark]]);
  expect((await visit(world, member, `/go/${SLUG}`)).headers.get("location")).toBe(OWNERS_URL);
  return { world, owner, member, bookmark, route: first };
}

describe.each(PATHS)("$name", ({ setup, other }) => {
  it(
    "ends the member's access on the next request and deletes the choice in the same transaction, before anything resolves or lists it",
    async () => {
      const { route, world, member } = await cast([setup]);

      await route.end();

      expect(await stored()).toEqual([]);
      const forwarding = await visit(world, member, `/go/${SLUG}`);
      expect(forwarding.status).toBe(404);
      expect(forwarding.headers.get("location")).toBeNull();
      expect(await (await send(world, "POST", RESOLVE, as(member), { slug: SLUG })).json()).toEqual({ result: "none", otherWorkspaces: [] });
      const listed = await send(world, "GET", PREFERENCES, as(member));
      expect(listed.status).toBe(200);
      expect(((await listed.json()) as { items: unknown[] }).items).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  if (other !== undefined) {
    it(
      "keeps the choice and the access of a member who reads the bookmark by another route",
      async () => {
        const { route, world, member, bookmark } = await cast([setup, other]);

        await route.end();

        expect((await stored()).map((row) => [row.account_id, row.bookmark_id])).toEqual([[member.account.id, bookmark]]);
        expect((await visit(world, member, `/go/${SLUG}`)).headers.get("location")).toBe(OWNERS_URL);
        const listed = await send(world, "GET", PREFERENCES, as(member));
        expect(((await listed.json()) as { items: { bookmarkId: string }[] }).items.map((item) => item.bookmarkId)).toEqual([bookmark]);
      },
      TEST_TIMEOUT_MS,
    );
  }
});

describe("a member whose membership ends", () => {
  const ENDINGS = [
    {
      name: "DELETE /members/{accountId} removes the member",
      end: (world: World, owner: Person, member: Person) => send(world, "DELETE", `${MEMBERS}/${member.account.id}`, as(owner), { content: "transfer" }),
    },
    {
      name: "POST /workspace/leave lets the member leave",
      end: (world: World, _owner: Person, member: Person) => send(world, "POST", LEAVE, as(member), { content: "transfer" }),
    },
  ] as const;

  it.each(ENDINGS)(
    "$name: the choice, the shares the member received and the team memberships go with the membership, and go mail does not reach the bookmark",
    async ({ end }) => {
      const { world, owner, member } = await cast([teamShare, directShare]);
      expect(await sharesTo(member.account.id)).toBe(1);
      expect(await memberships(member.account.id)).toBe(1);

      expect((await end(world, owner, member)).status).toBe(200);

      expect(await stored()).toEqual([]);
      expect(await sharesTo(member.account.id)).toBe(0);
      expect(await memberships(member.account.id)).toBe(0);
      const forwarding = await visit(world, member, `/go/${SLUG}`);
      expect(forwarding.headers.get("location")).toBeNull();
      expect([404, 401]).toContain(forwarding.status);
      expect((await send(world, "GET", PREFERENCES, as(member))).status).not.toBe(200);
    },
    TEST_TIMEOUT_MS,
  );
});
