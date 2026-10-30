import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EntitlementCheck } from "@slugbase/core";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ACTIVE_WORKSPACE, HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// Bookmarks that others share with a member in /go, the suggestions and the search (doc 02 sections 6.2, 6.3, 8.2 and 9, Q25, doc 08 section 3.5 `go/resolution`, doc 10 T1, T2 and
// T12), through the whole chain over the migrated database. The failure scenario (T12): a bookmark with forwarding off, a plan-archived one and one shared with a team the caller is
// not in are never candidates of the caller's `/go/<slug>`, suggestions or search, `POST /go/resolve` answers none and `POST /go/choose` 404 for them, and the caller's `/go` never
// redirects to the address of a bookmark the caller cannot read, before a share or after it is revoked.

const TEST_TIMEOUT_MS = 90_000;
const BOOKMARKS = "/api/v1/bookmarks";
const FOLDERS = "/api/v1/folders";
const TAGS = "/api/v1/tags";
const TEAMS = "/api/v1/teams";
const RESOLVE = "/api/v1/go/resolve";
const CHOOSE = "/api/v1/go/choose";
const SUGGEST = "/api/v1/go/suggest";
const SEARCH = "/api/v1/search";
const SHELL = "<!doctype html><html><head><title>SlugBase shell</title></head><body><div id=\"root\"></div></body></html>";
const GRANTED: EntitlementCheck = (entitlement) => entitlement === "sharing.members" || entitlement === "sharing.teams" || entitlement === "teams.manage";
const RELAXED = {
  RATE_LIMIT_BULK_IP: "10000/hour",
  RATE_LIMIT_BULK_ACCOUNT: "10000/hour",
  RATE_LIMIT_WRITE_IP: "10000/min",
  RATE_LIMIT_WRITE_ACCOUNT: "10000/min",
  RATE_LIMIT_READ_IP: "10000/min",
  RATE_LIMIT_READ_ACCOUNT: "10000/min",
};

const database = useTestDatabase();
const harness = workspaceHarness(database);
let webRoot: string;

beforeAll(async () => {
  webRoot = mkdtempSync(join(tmpdir(), "slugbase-go-sharing-"));
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

const serve = () => harness.serve({ entitlements: GRANTED, env: RELAXED, webRoot });
const as = (person: Person): Record<string, string> => ({ cookie: person.cookie });

interface Choice {
  readonly id: string;
  readonly title: string;
  readonly host: string;
  readonly owner: { readonly accountId: string; readonly displayName: string } | null;
  readonly sharedVia: "direct" | "team" | "folder" | null;
}

type Resolution = { readonly result: "none" | "single" | "preferred"; readonly bookmark?: Choice; readonly otherWorkspaces?: unknown } | { readonly result: "multiple"; readonly candidates: readonly Choice[] };

/** An owner, two more members and a stranger of another workspace. */
async function setup(world: World) {
  const owner = await harness.person(world);
  const colleague = await harness.person(world);
  const member = await harness.person(world);
  const outsider = await harness.person(world);
  await harness.workspaceOf([
    { person: owner, role: "owner" },
    { person: colleague, role: "member" },
    { person: member, role: "member" },
  ]);
  await harness.workspaceOf([{ person: outsider, role: "owner" }]);
  return { owner, colleague, member, outsider };
}

async function created(world: World, person: Person, title: string, slug?: string, extra: Record<string, unknown> = {}): Promise<string> {
  const response = await send(world, "POST", BOOKMARKS, as(person), { url: `https://example.com/${encodeURIComponent(title)}`, title, ...(slug === undefined ? {} : { slug }), ...extra });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function idOf(response: Promise<Response>): Promise<string> {
  const settled = await response;
  expect(settled.status).toBe(201);
  return ((await settled.json()) as { id: string }).id;
}

async function teamOf(world: World, person: Person, name: string, members: readonly Person[]): Promise<string> {
  const id = await idOf(send(world, "POST", TEAMS, as(person), { name }));
  expect((await send(world, "PUT", `${TEAMS}/${id}/members`, as(person), { accountIds: members.map((entry) => entry.account.id) })).status).toBe(200);
  return id;
}

async function share(world: World, person: Person, path: string, target: { accountId: string } | { teamId: string }): Promise<void> {
  expect([200, 201]).toContain((await send(world, "POST", `${path}/shares`, as(person), target)).status);
}

async function shareThroughFolder(world: World, person: Person, bookmarkId: string, target: { accountId: string } | { teamId: string }): Promise<void> {
  const folderId = await idOf(send(world, "POST", FOLDERS, as(person), { name: `Folder of ${bookmarkId}` }));
  expect([200, 204]).toContain((await send(world, "POST", `${FOLDERS}/${folderId}/bookmarks`, as(person), { bookmarkIds: [bookmarkId] })).status);
  await share(world, person, `${FOLDERS}/${folderId}`, target);
}

async function inDatabase(statement: string, params: string[] = []): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx.unsafe(statement, params);
  });
}

async function preferenceCount(): Promise<number> {
  return database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    const [row] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM slug_preferences`;
    return row?.n ?? 0;
  });
}

async function resolved(world: World, person: Person, slug: string): Promise<Resolution> {
  const response = await send(world, "POST", RESOLVE, as(person), { slug });
  expect(response.status).toBe(200);
  return (await response.json()) as Resolution;
}

/** A navigation: a GET of the path, which a browser makes without a body, an origin or a content type. */
function visit(world: World, person: Person, path: string): Promise<Response> {
  return world.server.fetch(new Request(new URL(path, world.origin), { method: "GET", headers: { accept: "text/html", cookie: person.cookie } }));
}

async function suggested(world: World, person: Person, prefix: string): Promise<{ slug: string; bookmarkId: string; sharedVia: string | null }[]> {
  const response = await send(world, "GET", `${SUGGEST}?prefix=${encodeURIComponent(prefix)}`, as(person));
  expect(response.status).toBe(200);
  return ((await response.json()) as { suggestions: { slug: string; bookmarkId: string; sharedVia: string | null }[] }).suggestions;
}

async function found(world: World, person: Person, query: string): Promise<{ bookmarks: { id: string; pinned: boolean }[]; folders: { id: string }[]; tags: { id: string }[] }> {
  const response = await send(world, "GET", `${SEARCH}?q=${encodeURIComponent(query)}`, as(person));
  expect(response.status).toBe(200);
  return (await response.json()) as { bookmarks: { id: string; pinned: boolean }[]; folders: { id: string }[]; tags: { id: string }[] };
}

describe("POST /go/resolve and GET /go/<slug> with shared candidates (Q25)", () => {
  it(
    "keeps a shared `mail` from breaking the member's own `go mail`, and follows the one shared candidate when the member has none",
    async () => {
      const world = serve();
      const { owner, member } = await setup(world);
      const theirs = await created(world, owner, "Owner mail", "mail");
      await share(world, owner, `${BOOKMARKS}/${theirs}`, { accountId: member.account.id });

      const alone = await resolved(world, member, "mail");
      expect(alone).toEqual({ result: "single", bookmark: { id: theirs, title: "Owner mail", host: "example.com", owner: { accountId: owner.account.id, displayName: expect.any(String) as string }, sharedVia: "direct" } });
      expect((await visit(world, member, "/go/mail")).headers.get("location")).toBe("https://example.com/Owner%20mail");

      const mine = await created(world, member, "Member mail", "mail");
      expect(await resolved(world, member, "mail")).toEqual({ result: "single", bookmark: { id: mine, title: "Member mail", host: "example.com", owner: null, sharedVia: null } });
      const own = await visit(world, member, "/go/mail");
      expect(own.status).toBe(302);
      expect(own.headers.get("location")).toBe("https://example.com/Member%20mail");
      expect((await visit(world, owner, "/go/mail")).headers.get("location")).toBe("https://example.com/Owner%20mail");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "offers several shared candidates in the order of their titles with title, host, owner and how each is shared, serves the shell for the page that asks to choose, and forwards the choice",
    async () => {
      const world = serve();
      const { owner, colleague, member } = await setup(world);
      const team = await teamOf(world, owner, "Readers", [member]);
      const direct = await created(world, owner, "B direct", "mail");
      const viaTeam = await created(world, colleague, "A team", "mail");
      await share(world, owner, `${BOOKMARKS}/${direct}`, { accountId: member.account.id });
      await share(world, colleague, `${BOOKMARKS}/${viaTeam}`, { teamId: team });

      const answer = await resolved(world, member, "mail");

      expect(answer).toEqual({
        result: "multiple",
        candidates: [
          { id: viaTeam, title: "A team", host: "example.com", owner: { accountId: colleague.account.id, displayName: expect.any(String) as string }, sharedVia: "team" },
          { id: direct, title: "B direct", host: "example.com", owner: { accountId: owner.account.id, displayName: expect.any(String) as string }, sharedVia: "direct" },
        ],
      });
      const page = await visit(world, member, "/go/mail");
      expect(page.status).toBe(200);
      expect(page.headers.get("location")).toBeNull();
      expect(await page.text()).toBe(SHELL);

      const chosen = await send(world, "POST", CHOOSE, as(member), { slug: "mail", bookmarkId: direct, remember: true });
      expect(chosen.status).toBe(200);
      expect(await chosen.json()).toEqual({ url: "https://example.com/B%20direct" });
      expect(await resolved(world, member, "mail")).toMatchObject({ result: "preferred", bookmark: { id: direct, sharedVia: "direct" } });
      expect((await visit(world, member, "/go/mail")).headers.get("location")).toBe("https://example.com/B%20direct");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "resolves a bookmark shared through a folder and through a folder shared with a team",
    async () => {
      const world = serve();
      const { owner, colleague, member } = await setup(world);
      const team = await teamOf(world, owner, "Readers", [member]);
      const viaFolder = await created(world, owner, "Via folder", "folder-link");
      const viaTeamFolder = await created(world, colleague, "Via team folder", "team-folder-link");
      await shareThroughFolder(world, owner, viaFolder, { accountId: member.account.id });
      await shareThroughFolder(world, colleague, viaTeamFolder, { teamId: team });

      expect(await resolved(world, member, "folder-link")).toMatchObject({ result: "single", bookmark: { id: viaFolder, sharedVia: "folder" } });
      expect(await resolved(world, member, "team-folder-link")).toMatchObject({ result: "single", bookmark: { id: viaTeamFolder, sharedVia: "folder" } });
      expect((await visit(world, member, "/go/team-folder-link")).headers.get("location")).toBe("https://example.com/Via%20team%20folder");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "never names, forwards to or suggests a bookmark with forwarding off, never finds a plan-archived one, and never names, forwards to, suggests or finds one shared with a team the member is not in, and never redirects to an address the member cannot read (T12)",
    async () => {
      const world = serve();
      const { owner, colleague, member } = await setup(world);
      const otherTeam = await teamOf(world, owner, "Others", [colleague]);
      const paused = await created(world, owner, "Paused alpha", "paused", { forwarding: false });
      const archived = await created(world, owner, "Archived bravo", "archived");
      const forTeam = await created(world, owner, "Teamwork charlie", "team-only");
      const unshared = await created(world, owner, "Private delta", "private");
      const folded = await created(world, owner, "Folderish echo", "folder-only");
      await share(world, owner, `${BOOKMARKS}/${paused}`, { accountId: member.account.id });
      await share(world, owner, `${BOOKMARKS}/${archived}`, { accountId: member.account.id });
      await share(world, owner, `${BOOKMARKS}/${forTeam}`, { teamId: otherTeam });
      await shareThroughFolder(world, owner, folded, { teamId: otherTeam });
      await inDatabase("UPDATE bookmarks SET plan_archived_at = now() WHERE id = $1", [archived]);

      for (const [slug, id, title] of [["paused", paused, "Paused alpha"], ["archived", archived, "Archived bravo"], ["team-only", forTeam, "Teamwork charlie"], ["private", unshared, "Private delta"], ["folder-only", folded, "Folderish echo"]] as const) {
        expect(await resolved(world, member, slug), slug).toEqual({ result: "none", otherWorkspaces: [] });
        const visited = await visit(world, member, `/go/${slug}`);
        expect(visited.status, slug).toBe(404);
        expect(visited.headers.get("location"), slug).toBeNull();
        const chosen = await send(world, "POST", CHOOSE, as(member), { slug, bookmarkId: id, remember: true });
        expect(chosen.status, slug).toBe(404);
        expect(JSON.stringify(await chosen.json()), slug).not.toContain("example.com");
        expect(await suggested(world, member, slug), slug).toEqual([]);
        // Forwarding is no rule of the search: a shared bookmark that does not forward is readable, so it is found; the others are not readable or are archived.
        expect((await found(world, member, title)).bookmarks.map((hit) => hit.id), slug).toEqual(slug === "paused" ? [paused] : []);
      }
      expect(await preferenceCount()).toBe(0);
      // The colleague, who is in the team, resolves what was shared with it.
      expect(await resolved(world, colleague, "team-only")).toMatchObject({ result: "single", bookmark: { id: forTeam, sharedVia: "team" } });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "stops forwarding to a shared bookmark as soon as its share is revoked, and forgets the choice made for it",
    async () => {
      const world = serve();
      const { owner, member } = await setup(world);
      const theirs = await created(world, owner, "Owner mail", "mail");
      const mine = await created(world, member, "Member mail", "mail");
      await share(world, owner, `${BOOKMARKS}/${theirs}`, { accountId: member.account.id });
      expect((await send(world, "POST", CHOOSE, as(member), { slug: "mail", bookmarkId: theirs, remember: true })).status).toBe(200);
      expect((await visit(world, member, "/go/mail")).headers.get("location")).toBe("https://example.com/Owner%20mail");

      await inDatabase("DELETE FROM bookmark_shares WHERE bookmark_id = $1", [theirs]);

      const after = await visit(world, member, "/go/mail");
      expect(after.status).toBe(302);
      expect(after.headers.get("location")).toBe("https://example.com/Member%20mail");
      expect(await resolved(world, member, "mail")).toMatchObject({ result: "single", bookmark: { id: mine } });
      expect(await preferenceCount()).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "names the other workspaces in which the member reads a bookmark with the slug only through a share",
    async () => {
      const world = serve();
      const { owner, member } = await setup(world);
      const home = await send(world, "GET", "/api/v1/workspace", as(member));
      const homeId = ((await home.json()) as { id: string }).id;
      const otherOwner = await harness.person(world);
      const other = await harness.workspaceOf([
        { person: otherOwner, role: "owner" },
        { person: member, role: "member" },
      ]);
      const theirs = await created(world, otherOwner, "Elsewhere", "only-there");
      expect((await send(world, "PUT", ACTIVE_WORKSPACE, as(member), { workspaceId: homeId })).status).toBe(204);

      expect(await resolved(world, member, "only-there")).toEqual({ result: "none", otherWorkspaces: [] });
      await inDatabase(
        "INSERT INTO bookmark_shares (id, workspace_id, bookmark_id, target_account_id, granted_by) VALUES (gen_random_uuid(), $1, $2, $3, $4)",
        [other.workspaceId, theirs, member.account.id, otherOwner.account.id],
      );

      expect(await resolved(world, member, "only-there")).toEqual({ result: "none", otherWorkspaces: [{ id: other.workspaceId, name: expect.any(String) as string }] });
      expect(owner.account.id).not.toBe(member.account.id);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("GET /go/suggest and GET /search with shared bookmarks", () => {
  it(
    "suggests the member's own slugs first and then the shared ones, each with its owner and how it is shared",
    async () => {
      const world = serve();
      const { owner, member } = await setup(world);
      const own = await created(world, member, "Zz own", "go-zz");
      const direct = await created(world, owner, "Direct", "go-a");
      const viaFolder = await created(world, owner, "Folder", "go-b");
      await share(world, owner, `${BOOKMARKS}/${direct}`, { accountId: member.account.id });
      await shareThroughFolder(world, owner, viaFolder, { accountId: member.account.id });
      await created(world, owner, "Private", "go-c");

      const response = await send(world, "GET", `${SUGGEST}?prefix=go-`, as(member));
      const body = (await response.json()) as { suggestions: unknown };

      expect(body.suggestions).toEqual([
        { slug: "go-zz", bookmarkId: own, title: "Zz own", host: "example.com", owner: null, sharedVia: null },
        { slug: "go-a", bookmarkId: direct, title: "Direct", host: "example.com", owner: { accountId: owner.account.id, displayName: expect.any(String) as string }, sharedVia: "direct" },
        { slug: "go-b", bookmarkId: viaFolder, title: "Folder", host: "example.com", owner: { accountId: owner.account.id, displayName: expect.any(String) as string }, sharedVia: "folder" },
      ]);
      expect(JSON.stringify(body)).not.toContain("https://");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "finds the bookmarks shared with the member, never pinned for them, and searches only the member's own folders and tags",
    async () => {
      const world = serve();
      const { owner, member } = await setup(world);
      const team = await teamOf(world, owner, "Readers", [member]);
      const direct = await created(world, owner, "Quokka direct", undefined, { pinned: true });
      const viaTeam = await created(world, owner, "Quokka team");
      const mine = await created(world, member, "Quokka mine", undefined, { pinned: true });
      const unshared = await created(world, owner, "Quokka private");
      await share(world, owner, `${BOOKMARKS}/${direct}`, { accountId: member.account.id });
      await share(world, owner, `${BOOKMARKS}/${viaTeam}`, { teamId: team });
      await idOf(send(world, "POST", FOLDERS, as(owner), { name: "Quokka folder" }));
      await idOf(send(world, "POST", TAGS, as(owner), { name: "quokka-tag" }));

      const hits = await found(world, member, "quokka");

      expect(hits.bookmarks.map((hit) => [hit.id, hit.pinned]).toSorted()).toEqual([[direct, false], [viaTeam, false], [mine, true]].toSorted());
      expect(hits.folders).toEqual([]);
      expect(hits.tags).toEqual([]);
      expect((await found(world, owner, "quokka private")).bookmarks.map((hit) => hit.id)).toContain(unshared);
      expect(hits.bookmarks.map((hit) => hit.id)).not.toContain(unshared);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("GET /bookmarks with a text query and shared bookmarks", () => {
  it(
    "lists the bookmarks shared with the member that the text matches in the scopes `all` and `shared_with_me`, as the search finds them, and never in `mine`",
    async () => {
      const world = serve();
      const { owner, member } = await setup(world);
      const team = await teamOf(world, owner, "Planners", [member]);
      const direct = await created(world, owner, "Zebra planner direct");
      const viaTeam = await created(world, owner, "Zebra planner team");
      const viaFolder = await created(world, owner, "Zebra planner folder");
      const mine = await created(world, member, "Zebra planner mine");
      const unshared = await created(world, owner, "Zebra planner private");
      await share(world, owner, `${BOOKMARKS}/${direct}`, { accountId: member.account.id });
      await share(world, owner, `${BOOKMARKS}/${viaTeam}`, { teamId: team });
      await shareThroughFolder(world, owner, viaFolder, { accountId: member.account.id });
      const listed = async (scope: string): Promise<{ ids: string[]; total: number | null }> => {
        const response = await send(world, "GET", `${BOOKMARKS}?q=zebra&scope=${scope}`, as(member));
        expect(response.status).toBe(200);
        const page = (await response.json()) as { items: { id: string }[]; total: number | null };
        return { ids: page.items.map((item) => item.id).toSorted(), total: page.total };
      };

      const everything = [direct, viaTeam, viaFolder, mine].toSorted();
      expect(await listed("all")).toEqual({ ids: everything, total: 4 });
      expect(await listed("shared_with_me")).toEqual({ ids: [direct, viaTeam, viaFolder].toSorted(), total: 3 });
      expect(await listed("mine")).toEqual({ ids: [mine], total: 1 });
      expect((await found(world, member, "zebra")).bookmarks.map((hit) => hit.id).toSorted()).toEqual(everything);
      expect((await listed("all")).ids).not.toContain(unshared);
    },
    TEST_TIMEOUT_MS,
  );
});
