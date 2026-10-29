import { createHandlers, createResolverHandlers } from "@slugbase/testing/msw";
import { createMockServer, readOpenApiDocument } from "@slugbase/testing/msw/node";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp, type WebExtension } from "../src/index.ts";
import { ACCOUNT_BODY, WORKSPACE_ID, WORKSPACE_LIST_BODY, allowSlowRender, json, problem, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The share dialog and the sharing line of the bookmark modal (doc 03 sections 4 and 5, doc 02 section 8.3) against the handlers
// generated from openapi.json, through the app's own API client, with shares kept the way the API keeps them: a grant answered 201
// or, when it exists, 200 with the share; an audience that counts the members of the shared teams once and leaves the owner out;
// a search over the members other than the caller and the teams, for the kinds the workspace may share with. The failure scenarios
// are an entry point on a bookmark or folder of another member, one offered where the workspace has no sharing entitlement, a
// grant that is shown as made when the API refused it, a row that is removed from the list when its revocation failed, a list that
// failed shown as "not shared with anyone", a summary that says "Private" for a bookmark whose shares could not be read, and a
// dialog that lists the owner or an existing grant as someone to share with.

const server = createMockServer();
const document_ = readOpenApiDocument();

const ADA = ACCOUNT_BODY.id;
const GRACE = "0192f3a0-bbbb-7000-8000-000000000002";
const ALAN = "0192f3a0-bbbb-7000-8000-000000000003";
const PLATFORM = "0192f3a0-ffff-7000-8000-000000000001";
const DESIGN = "0192f3a0-ffff-7000-8000-000000000002";
const REPORT = "0192f3a0-aaaa-7000-8000-000000000001";
const FOREIGN = "0192f3a0-aaaa-7000-8000-000000000002";
const OWN_FOLDER = "0192f3a0-dddd-7000-8000-000000000001";
const FOREIGN_FOLDER = "0192f3a0-dddd-7000-8000-000000000002";
const STAMP = "2026-10-01T08:00:00.000Z";

interface Person {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

const PEOPLE: readonly Person[] = [
  { id: ADA, name: "Ada Lovelace", email: "ada@example.org" },
  { id: GRACE, name: "Grace Hopper", email: "grace@example.org" },
  { id: ALAN, name: "Alan Turing", email: "alan@example.org" },
];

const TEAMS: readonly { readonly id: string; readonly name: string; readonly memberIds: readonly string[] }[] = [
  { id: PLATFORM, name: "Platform", memberIds: [ADA, GRACE, ALAN] },
  { id: DESIGN, name: "Design", memberIds: [ADA, ALAN] },
];

interface Grant {
  readonly id: string;
  readonly kind: "member" | "team";
  readonly targetId: string;
}

interface Received {
  readonly method: string;
  readonly path: string;
  readonly search: URLSearchParams;
  readonly body: unknown;
}

interface World {
  /** The grants by subject, `bookmark:<id>` or `folder:<id>`. */
  grants: Map<string, Grant[]>;
  sharingMembers: boolean;
  sharingTeams: boolean;
  received: Received[];
  /** operationId to the answer that replaces the operation's own for as long as it returns one; `call` counts from 1. */
  refuse: Map<string, (call: number) => Response | undefined>;
  calls: Map<string, number>;
  made: number;
}

let world: World;

function newWorld(): World {
  return { grants: new Map(), sharingMembers: true, sharingTeams: true, received: [], refuse: new Map(), calls: new Map(), made: 0 };
}

function bookmarkOf(id: string, title: string, ownerId: string) {
  return {
    id,
    ownerId,
    url: `https://example.com/${title.toLowerCase().replaceAll(" ", "-")}`,
    host: "example.com",
    title,
    description: null,
    slug: null,
    forwarding: false,
    pinned: false,
    openCount: 0,
    lastOpenedAt: null,
    folders: [],
    tags: [],
    version: 3,
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

function folderOf(id: string, name: string, ownerId: string) {
  return { id, ownerId, name, icon: "folder", color: 1, bookmarkCount: 0, version: 1, createdAt: STAMP, updatedAt: STAMP };
}

const BOOKMARKS = [bookmarkOf(REPORT, "Quarterly report", ADA), bookmarkOf(FOREIGN, "Roadmap", GRACE)];
const FOLDERS = [folderOf(OWN_FOLDER, "Design", ADA), folderOf(FOREIGN_FOLDER, "Archive", GRACE)];

function entitlementsBody() {
  return {
    entitlements: {
      "bookmarks.max": "unlimited",
      "seats.max": "unlimited",
      "workspaces.ownMax": "unlimited",
      "ai.suggestions": true,
      "sharing.members": world.sharingMembers,
      "sharing.teams": world.sharingTeams,
      "members.invite": true,
      "teams.manage": true,
      "audit.log": true,
    },
    usage: { "bookmarks.used": 2, "seats.used": 3, "workspaces.owned": 1 },
    upgradeAvailable: true,
  };
}

function steered(operationId: string): Response | undefined {
  const call = (world.calls.get(operationId) ?? 0) + 1;
  world.calls.set(operationId, call);
  return world.refuse.get(operationId)?.(call);
}

function grantsOf(key: string): Grant[] {
  let found = world.grants.get(key);
  if (found === undefined) {
    found = [];
    world.grants.set(key, found);
  }
  return found;
}

function shareOf(grant: Grant) {
  const person = PEOPLE.find(({ id }) => id === grant.targetId);
  const team = TEAMS.find(({ id }) => id === grant.targetId);
  return {
    id: grant.id,
    kind: grant.kind,
    accountId: grant.kind === "member" ? grant.targetId : null,
    teamId: grant.kind === "team" ? grant.targetId : null,
    name: (grant.kind === "member" ? person?.name : team?.name) ?? "",
    email: grant.kind === "member" ? (person?.email ?? null) : null,
    createdAt: STAMP,
  };
}

function listOf(key: string) {
  const grants = grantsOf(key);
  const readers = new Set<string>();
  for (const grant of grants) {
    for (const member of grant.kind === "member" ? [grant.targetId] : (TEAMS.find(({ id }) => id === grant.targetId)?.memberIds ?? [])) {
      readers.add(member);
    }
  }
  readers.delete(ADA);
  return { items: grants.map(shareOf), audienceSize: readers.size };
}

/** The subject and the share a request names: `/api/v1/<bookmarks|folders>/<id>/shares[/<shareId>]`. */
function subjectOf(url: string): { key: string; shareId: string | undefined } {
  const [, , , owner, id, , shareId] = new URL(url).pathname.split("/");
  return { key: `${owner === "bookmarks" ? "bookmark" : "folder"}:${id ?? ""}`, shareId };
}

function record(request: Request, body: unknown): void {
  const url = new URL(request.url);
  world.received.push({ method: request.method, path: url.pathname, search: url.searchParams, body });
}

/** The three share operations of a bookmark or a folder, over the grants of the subject the request names. */
function shareResolvers(prefix: "Bookmark" | "Folder") {
  return {
    list: (request: Request): Response => {
      record(request, undefined);
      return steered(`list${prefix}Shares`) ?? json(listOf(subjectOf(request.url).key));
    },
    create: async (request: Request): Promise<Response> => {
      const body = (await request.json()) as { accountId?: string; teamId?: string };
      record(request, body);
      const steer = steered(`create${prefix}Share`);
      if (steer !== undefined) {
        return steer;
      }
      const grants = grantsOf(subjectOf(request.url).key);
      const target = body.accountId ?? body.teamId ?? "";
      const member = body.accountId !== undefined;
      if (member ? !world.sharingMembers : !world.sharingTeams) {
        return problem(403, "entitlement_required", "req-403");
      }
      if (body.accountId === ADA) {
        return problem(422, "validation_failed", "req-422");
      }
      if (member ? !PEOPLE.some(({ id }) => id === target) : !TEAMS.some(({ id }) => id === target)) {
        return problem(422, member ? "unknown_member" : "unknown_team", "req-422");
      }
      const existing = grants.find((grant) => grant.targetId === target);
      if (existing !== undefined) {
        return json(shareOf(existing));
      }
      world.made += 1;
      const made: Grant = { id: `0192f3a0-eeee-7000-8000-${String(world.made).padStart(12, "0")}`, kind: member ? "member" : "team", targetId: target };
      grants.push(made);
      return json(shareOf(made), { status: 201 });
    },
    remove: (request: Request): Response => {
      record(request, undefined);
      const steer = steered(`delete${prefix}Share`);
      if (steer !== undefined) {
        return steer;
      }
      const { key, shareId } = subjectOf(request.url);
      const grants = grantsOf(key);
      const found = grants.find((grant) => grant.id === shareId);
      if (found === undefined) {
        return problem(404, "not_found", "req-404");
      }
      grants.splice(grants.indexOf(found), 1);
      return new Response(null, { status: 204 });
    },
  };
}

function serve(): void {
  const bookmarkShares = shareResolvers("Bookmark");
  const folderShares = shareResolvers("Folder");
  server.use(
    ...createResolverHandlers(document_, {
      getMe: () => json({ account: ACCOUNT_BODY, memberships: [{ workspaceId: WORKSPACE_ID, name: "Ada's Workspace", role: "owner" }], activeWorkspaceId: WORKSPACE_ID }),
      getEntitlements: () => json(entitlementsBody()),
      listBookmarks: () => json({ items: BOOKMARKS, nextCursor: null, total: BOOKMARKS.length }),
      getBookmark: (request) => {
        const found = BOOKMARKS.find(({ id }) => new URL(request.url).pathname.endsWith(id));
        return found === undefined ? problem(404, "not_found", "req-404") : json(found, { headers: { ETag: '"3"' } });
      },
      listFolders: () => json({ items: FOLDERS, nextCursor: null, total: FOLDERS.length }),
      getTeam: (request) => {
        const team = TEAMS.find(({ id }) => new URL(request.url).pathname.endsWith(id));
        if (team === undefined) {
          return problem(404, "not_found", "req-404");
        }
        const members = PEOPLE.filter(({ id }) => team.memberIds.includes(id)).map(({ id, name, email }) => ({ accountId: id, displayName: name, email }));
        return json({ id: team.id, name: team.name, description: "", memberCount: members.length, version: 1, createdAt: STAMP, updatedAt: STAMP, members });
      },
      listShareTargets: (request) => {
        record(request, undefined);
        const q = new URL(request.url).searchParams.get("q")?.toLowerCase();
        const matches = (...texts: (string | null)[]): boolean => q === undefined || texts.some((text) => text?.toLowerCase().includes(q) === true);
        const items = [
          ...(world.sharingMembers ? PEOPLE.filter(({ id }) => id !== ADA).filter(({ name, email }) => matches(name, email)).map(({ id, name, email }) => ({ kind: "member", id, name, email })) : []),
          ...(world.sharingTeams ? TEAMS.filter(({ name }) => matches(name)).map(({ id, name }) => ({ kind: "team", id, name, email: null })) : []),
        ].sort((a, b) => a.name.localeCompare(b.name));
        return steered("listShareTargets") ?? json({ items });
      },
      listBookmarkShares: bookmarkShares.list,
      createBookmarkShare: bookmarkShares.create,
      deleteBookmarkShare: bookmarkShares.remove,
      listFolderShares: folderShares.list,
      createFolderShare: folderShares.create,
      deleteFolderShare: folderShares.remove,
    }),
    ...createHandlers(document_, { scenario: { name: "sharing", fixtures: { listWorkspaces: WORKSPACE_LIST_BODY } } }),
  );
}

function calls(method: string, path: string): Received[] {
  return world.received.filter((call) => call.method === method && call.path === path);
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

let restoreWait: () => void = () => undefined;

beforeAll(() => {
  restoreWait = allowSlowRender();
});

afterAll(() => {
  restoreWait();
});

beforeEach(() => {
  world = newWorld();
  stubBrowserApis();
  stubMatchMedia(false);
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("lang");
});

async function openApp(path: string, extensions: readonly WebExtension[] = []): Promise<void> {
  serve();
  window.history.replaceState(null, "", path);
  const App = createWebApp({ extensions });
  await renderApp(<App />);
}

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

async function typeInto(input: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(input, { target: { value } });
    await Promise.resolve();
  });
}

async function openBookmarkDialog(): Promise<HTMLElement> {
  await press(await screen.findByRole("button", { name: "Actions for Quarterly report" }));
  await press(await screen.findByRole("menuitem", { name: "Share" }));
  return screen.findByRole("dialog", { name: "Share “Quarterly report”" });
}

async function openFolderDialog(): Promise<HTMLElement> {
  await press(await screen.findByRole("button", { name: "Actions for Design" }));
  await press(await screen.findByRole("menuitem", { name: "Share settings" }));
  return screen.findByRole("dialog", { name: "Share the folder “Design”" });
}

async function openPicker(dialog: HTMLElement): Promise<HTMLElement> {
  const input = await within(dialog).findByRole("combobox", { name: "Share with" });
  await waitFor(() => {
    expect((input as HTMLInputElement).disabled).toBe(false);
  });
  await act(async () => {
    fireEvent.pointerDown(input);
    fireEvent.mouseDown(input);
    fireEvent.click(input);
    await Promise.resolve();
  });
  return input;
}

async function share(dialog: HTMLElement, option: RegExp): Promise<void> {
  await openPicker(dialog);
  await press(await screen.findByRole("option", { name: option }));
}

describe("the share dialog of a bookmark", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("opens from the row action and names the bookmark in its header", async () => {
    await openApp("/bookmarks");
    const dialog = await openBookmarkDialog();

    expect(within(dialog).getByText("Choose the members and teams who can read this bookmark.")).toBeTruthy();
    expect(await within(dialog).findByText("Not shared with anyone yet.")).toBeTruthy();
    expect(calls("GET", `/api/v1/bookmarks/${REPORT}/shares`)).toHaveLength(1);
  });

  it("lists the members and the teams in groups, without the owner, and narrows them by what is typed", async () => {
    await openApp("/bookmarks");
    const dialog = await openBookmarkDialog();
    const input = await openPicker(dialog);

    expect(await screen.findByText("Members")).toBeTruthy();
    expect(screen.getByText("Teams")).toBeTruthy();
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
      "Alan Turingalan@example.org",
      "Grace Hoppergrace@example.org",
      "Design",
      "Platform",
    ]);
    expect(screen.queryByRole("option", { name: /Ada Lovelace/ })).toBeNull();

    await typeInto(input, "plat");

    await waitFor(() => {
      expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Platform"]);
    });
    // The search is asked for after a pause, and its answer must not undo what was typed.
    await waitFor(() => {
      expect(world.received.some((call) => call.path === "/api/v1/share-targets" && call.search.get("q") === "plat")).toBe(true);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect((input as HTMLInputElement).value).toBe("plat");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Platform"]);
  });

  it("shares with a member at once, says so in a toast and shows the grant and the audience", async () => {
    await openApp("/bookmarks");
    const dialog = await openBookmarkDialog();

    await share(dialog, /Grace Hopper/);

    expect(await screen.findByText("Shared with Grace Hopper")).toBeTruthy();
    expect(calls("POST", `/api/v1/bookmarks/${REPORT}/shares`).map((call) => call.body)).toEqual([{ accountId: GRACE }]);
    const grants = await within(dialog).findByRole("list", { name: "Current shares" });
    expect(within(grants).getByText("Grace Hopper")).toBeTruthy();
    expect(within(grants).getByText("grace@example.org")).toBeTruthy();
    expect(within(grants).getByText("Member")).toBeTruthy();
    expect(await within(dialog).findByText("Visible to 1 member")).toBeTruthy();
    expect(within(dialog).getByRole("img", { name: "Members who can read it: Grace Hopper" })).toBeTruthy();
    // The picker is ready for the next grant and does not keep the name of the last one.
    expect(within(dialog).getByRole<HTMLInputElement>("combobox", { name: "Share with" }).value).toBe("");
  });

  it("does not offer a grant again once it is made", async () => {
    await openApp("/bookmarks");
    const dialog = await openBookmarkDialog();
    await share(dialog, /Grace Hopper/);
    await within(dialog).findByRole("list", { name: "Current shares" });

    await openPicker(dialog);

    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Alan Turingalan@example.org", "Design", "Platform"]);
  });

  it("shares with a team and counts the members of the team once in the audience", async () => {
    await openApp("/bookmarks");
    const dialog = await openBookmarkDialog();

    await share(dialog, /Platform/);
    await share(dialog, /Alan Turing/);

    const grants = await within(dialog).findByRole("list", { name: "Current shares" });
    await waitFor(() => {
      expect(within(grants).getAllByRole("listitem")).toHaveLength(2);
    });
    expect(within(grants).getByText("Platform")).toBeTruthy();
    expect(within(grants).getByText("Team")).toBeTruthy();
    expect(calls("POST", `/api/v1/bookmarks/${REPORT}/shares`).map((call) => call.body)).toEqual([{ teamId: PLATFORM }, { accountId: ALAN }]);
    // Grace and Alan are in Platform, and Alan is shared with as well: two members, and the owner is not counted.
    expect(await within(dialog).findByText("Visible to 2 members")).toBeTruthy();
    expect(await within(dialog).findByRole("img", { name: /Members who can read it: .*Grace Hopper/ })).toBeTruthy();
  });

  it("removes a grant at once, says so in a toast and drops the audience", async () => {
    grantsOf(`bookmark:${REPORT}`).push({ id: "0192f3a0-eeee-7000-8000-000000000a01", kind: "member", targetId: GRACE });
    await openApp("/bookmarks");
    const dialog = await openBookmarkDialog();
    expect(await within(dialog).findByText("Visible to 1 member")).toBeTruthy();

    await press(within(dialog).getByRole("button", { name: "Stop sharing with Grace Hopper" }));

    expect(await screen.findByText("Stopped sharing with Grace Hopper")).toBeTruthy();
    expect(calls("DELETE", `/api/v1/bookmarks/${REPORT}/shares/0192f3a0-eeee-7000-8000-000000000a01`)).toHaveLength(1);
    expect(await within(dialog).findByText("Not shared with anyone yet.")).toBeTruthy();
    expect(within(dialog).getByText("Not shared with anyone")).toBeTruthy();
  });

  it("states that sharing is read-only", async () => {
    await openApp("/bookmarks");
    const dialog = await openBookmarkDialog();

    expect(within(dialog).getByRole("note").textContent).toContain("Sharing is read-only.");
  });

  it("has no accessibility violations", async () => {
    grantsOf(`bookmark:${REPORT}`).push({ id: "0192f3a0-eeee-7000-8000-000000000a01", kind: "team", targetId: PLATFORM });
    await openApp("/bookmarks");
    const dialog = await openBookmarkDialog();
    await within(dialog).findByRole("list", { name: "Current shares" });

    const results = await axe(document.body, { rules: { region: { enabled: false } } });

    expect(results.violations.map(({ id }) => id)).toEqual([]);
  });
});

describe("a grant or a revocation that fails", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("is told in a toast when the member was removed from the workspace meanwhile, and nothing is listed as shared", async () => {
    world.refuse.set("createBookmarkShare", () => problem(422, "unknown_member", "req-422"));
    await openApp("/bookmarks");
    const dialog = await openBookmarkDialog();

    await share(dialog, /Grace Hopper/);

    // An error is announced as well, so the text is in the toast and in its live region.
    expect(await screen.findAllByText("Grace Hopper is no longer in the workspace. The list is up to date now.")).not.toHaveLength(0);
    expect(await within(dialog).findByText("Not shared with anyone yet.")).toBeTruthy();
    expect(within(dialog).queryByRole("list", { name: "Current shares" })).toBeNull();
    expect(screen.queryByText("Shared with Grace Hopper")).toBeNull();
  });

  it("is told in a toast that the bookmark is gone when the grant answers 404", async () => {
    world.refuse.set("createBookmarkShare", () => problem(404, "not_found", "req-404"));
    await openApp("/bookmarks");
    const dialog = await openBookmarkDialog();

    await share(dialog, /Alan Turing/);

    expect(await screen.findAllByText("This bookmark no longer exists.")).not.toHaveLength(0);
    expect(screen.queryByText("Shared with Alan Turing")).toBeNull();
  });

  it("keeps the row and says the change failed when a revocation fails", async () => {
    grantsOf(`bookmark:${REPORT}`).push({ id: "0192f3a0-eeee-7000-8000-000000000a01", kind: "member", targetId: GRACE });
    world.refuse.set("deleteBookmarkShare", () => problem(503, "unavailable", "req-503"));
    await openApp("/bookmarks");
    const dialog = await openBookmarkDialog();
    await within(dialog).findByRole("list", { name: "Current shares" });

    await press(within(dialog).getByRole("button", { name: "Stop sharing with Grace Hopper" }));

    expect(await screen.findAllByText(/req-503/)).not.toHaveLength(0);
    expect(screen.queryByText("Stopped sharing with Grace Hopper")).toBeNull();
    expect(within(dialog).getByRole("list", { name: "Current shares" })).toBeTruthy();
    expect(within(dialog).getByText("Grace Hopper")).toBeTruthy();
  });

  it("treats a revocation of a share that is gone as done and reads the list again", async () => {
    grantsOf(`bookmark:${REPORT}`).push({ id: "0192f3a0-eeee-7000-8000-000000000a01", kind: "member", targetId: GRACE });
    world.refuse.set("deleteBookmarkShare", (call) => {
      if (call === 1) {
        // Someone else revoked it first.
        world.grants.set(`bookmark:${REPORT}`, []);
        return problem(404, "not_found", "req-404");
      }
      return undefined;
    });
    await openApp("/bookmarks");
    const dialog = await openBookmarkDialog();
    await within(dialog).findByRole("list", { name: "Current shares" });

    await press(within(dialog).getByRole("button", { name: "Stop sharing with Grace Hopper" }));

    expect(await screen.findByText("Grace Hopper did not have access any more.")).toBeTruthy();
    expect(await within(dialog).findByText("Not shared with anyone yet.")).toBeTruthy();
  });
});

describe("the lists of the dialog that fail to load", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("says the shares could not be loaded instead of saying there are none, and reads them again on retry", async () => {
    grantsOf(`bookmark:${REPORT}`).push({ id: "0192f3a0-eeee-7000-8000-000000000a01", kind: "member", targetId: GRACE });
    // The first read and the two the client repeats on a 5xx fail; the one a retry asks for is answered.
    world.refuse.set("listBookmarkShares", (call) => (call <= 3 ? problem(503, "unavailable", "req-503") : undefined));
    await openApp("/bookmarks");
    await press(await screen.findByRole("button", { name: "Actions for Quarterly report" }));
    await press(await screen.findByRole("menuitem", { name: "Share" }));
    const dialog = await screen.findByRole("dialog", { name: "Share “Quarterly report”" });

    expect(await within(dialog).findByText("The shares could not be loaded.", undefined, { timeout: 8000 })).toBeTruthy();
    expect(within(dialog).queryByText("Not shared with anyone yet.")).toBeNull();
    expect(within(dialog).getByRole<HTMLInputElement>("combobox", { name: "Share with" }).disabled).toBe(true);
    await press(within(dialog).getByRole("button", { name: "Try again" }));

    expect(await within(dialog).findByRole("list", { name: "Current shares" })).toBeTruthy();
    expect(within(dialog).getByText("Grace Hopper")).toBeTruthy();
  });

  it("says in the picker that the members and teams could not be loaded instead of saying there are none", async () => {
    world.refuse.set("listShareTargets", () => problem(503, "unavailable", "req-503"));
    await openApp("/bookmarks");
    const dialog = await openBookmarkDialog();
    await within(dialog).findByText("Not shared with anyone yet.");

    await openPicker(dialog);

    expect(await screen.findByText("Members and teams could not be loaded.", undefined, { timeout: 8000 })).toBeTruthy();
    expect(screen.queryByText("No member or team matches.")).toBeNull();
  });

  it("says in the picker that nobody matches when the workspace has no one else to share with", async () => {
    world.refuse.set("listShareTargets", () => json({ items: [] }));
    await openApp("/bookmarks");
    const dialog = await openBookmarkDialog();
    await within(dialog).findByText("Not shared with anyone yet.");

    await openPicker(dialog);

    expect(await screen.findByText("No member or team matches.")).toBeTruthy();
  });
});

describe("the entry points", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("offers Share on a bookmark of the caller and not on one of another member", async () => {
    await openApp("/bookmarks");

    await press(await screen.findByRole("button", { name: "Actions for Roadmap" }));
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(["Edit", "Pin", "Delete"]);
  });

  it("offers Share where the workspace holds only the teams entitlement", async () => {
    world.sharingMembers = false;
    await openApp("/bookmarks");

    await press(await screen.findByRole("button", { name: "Actions for Quarterly report" }));
    expect(await screen.findByRole("menuitem", { name: "Share" })).toBeTruthy();
  });

  it("offers no Share where the workspace holds neither sharing entitlement", async () => {
    world.sharingMembers = false;
    world.sharingTeams = false;
    await openApp("/bookmarks");

    await press(await screen.findByRole("button", { name: "Actions for Quarterly report" }));
    await waitFor(() => {
      expect(screen.queryByRole("menuitem", { name: "Share" })).toBeNull();
    });
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(["Edit", "Pin", "Delete"]);
  });

  it("opens from Manage in the bookmark modal and over it", async () => {
    await openApp(`/bookmarks?bookmark=${REPORT}`);
    const modal = await screen.findByRole("dialog", { name: "Edit bookmark" });

    await press(await within(modal).findByRole("button", { name: "Manage" }));

    const dialog = await screen.findByRole("dialog", { name: "Share “Quarterly report”" });
    expect(await within(dialog).findByText("Not shared with anyone yet.")).toBeTruthy();
    await press(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Share “Quarterly report”" })).toBeNull();
    });
    expect(screen.getByRole("dialog", { name: "Edit bookmark" })).toBeTruthy();
  });
});

describe("the folder's Share settings", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("opens the dialog of an own folder, names the folder and shares it with a team", async () => {
    await openApp("/folders");
    const dialog = await openFolderDialog();

    expect(within(dialog).getByText(/every bookmark filed in it, now and later/)).toBeTruthy();
    await share(dialog, /Design/);

    expect(await screen.findByText("Shared with Design")).toBeTruthy();
    expect(calls("POST", `/api/v1/folders/${OWN_FOLDER}/shares`).map((call) => call.body)).toEqual([{ teamId: DESIGN }]);
    expect(await within(dialog).findByText("Visible to 1 member")).toBeTruthy();
    expect(within(dialog).getByRole("note").textContent).toContain("bookmarks in it");
  });

  it("removes a grant of the folder", async () => {
    grantsOf(`folder:${OWN_FOLDER}`).push({ id: "0192f3a0-eeee-7000-8000-000000000b01", kind: "member", targetId: ALAN });
    await openApp("/folders");
    const dialog = await openFolderDialog();

    await press(await within(dialog).findByRole("button", { name: "Stop sharing with Alan Turing" }));

    expect(await screen.findByText("Stopped sharing with Alan Turing")).toBeTruthy();
    expect(calls("DELETE", `/api/v1/folders/${OWN_FOLDER}/shares/0192f3a0-eeee-7000-8000-000000000b01`)).toHaveLength(1);
  });

  it("offers Share settings on an own folder only, and only where the workspace may share", async () => {
    await openApp("/folders");
    await press(await screen.findByRole("button", { name: "Actions for Archive" }));
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(["Open in Bookmarks", "Rename", "Change icon and colour", "Delete"]);
  });

  it("offers no Share settings where the workspace holds neither sharing entitlement", async () => {
    world.sharingMembers = false;
    world.sharingTeams = false;
    await openApp("/folders");

    await press(await screen.findByRole("button", { name: "Actions for Design" }));
    await waitFor(() => {
      expect(screen.queryByRole("menuitem", { name: "Share settings" })).toBeNull();
    });
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(["Open in Bookmarks", "Rename", "Change icon and colour", "Delete"]);
  });
});

describe("the sharing line of the bookmark modal", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  async function openModal(id: string = REPORT, extensions: readonly WebExtension[] = []): Promise<HTMLElement> {
    await openApp(`/bookmarks?bookmark=${id}`, extensions);
    return screen.findByRole("dialog", { name: "Edit bookmark" });
  }

  it("reads Private for a bookmark that is shared with no one", async () => {
    const modal = await openModal();

    const line = await within(modal).findByRole("group", { name: "Sharing" });
    expect(await within(line).findByText("Private")).toBeTruthy();
  });

  it("names the teams and counts the members", async () => {
    grantsOf(`bookmark:${REPORT}`).push(
      { id: "0192f3a0-eeee-7000-8000-000000000c01", kind: "team", targetId: PLATFORM },
      { id: "0192f3a0-eeee-7000-8000-000000000c02", kind: "member", targetId: GRACE },
      { id: "0192f3a0-eeee-7000-8000-000000000c03", kind: "member", targetId: ALAN },
    );
    const modal = await openModal();

    const line = await within(modal).findByRole("group", { name: "Sharing" });
    expect(await within(line).findByText("Shared with Platform team and 2 members")).toBeTruthy();
  });

  it("follows the changes made in the dialog", async () => {
    const modal = await openModal();
    const line = await within(modal).findByRole("group", { name: "Sharing" });
    await within(line).findByText("Private");

    await press(within(line).getByRole("button", { name: "Manage" }));
    const dialog = await screen.findByRole("dialog", { name: "Share “Quarterly report”" });
    await share(dialog, /Design/);

    await within(dialog).findByRole("list", { name: "Current shares" });
    await press(within(dialog).getByRole("button", { name: "Done" }));
    expect(await within(line).findByText("Shared with Design team")).toBeTruthy();
  });

  it("says the shares could not be read instead of saying Private", async () => {
    world.refuse.set("listBookmarkShares", () => problem(503, "unavailable", "req-503"));
    const modal = await openModal();

    const line = await within(modal).findByRole("group", { name: "Sharing" });

    expect(await within(line).findByText("Sharing could not be loaded.", undefined, { timeout: 8000 })).toBeTruthy();
    expect(within(line).queryByText("Private")).toBeNull();
  });

  it("is not shown for a bookmark of another member", async () => {
    await openModal(FOREIGN);
    await screen.findByRole("textbox", { name: "Title" });
    expect(screen.queryByRole("group", { name: "Sharing" })).toBeNull();
    expect(calls("GET", `/api/v1/bookmarks/${FOREIGN}/shares`)).toHaveLength(0);
  });

  it("is not shown for a new bookmark", async () => {
    await openApp("/bookmarks?new=1");
    await screen.findByRole("dialog", { name: "New bookmark" });

    expect(screen.queryByRole("group", { name: "Sharing" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Manage" })).toBeNull();
  });

  it("shows the upgrade affordance in its place where the workspace has no sharing entitlement", async () => {
    world.sharingMembers = false;
    world.sharingTeams = false;
    const upgrade: WebExtension = { id: "upgrade", slots: { "entitlement.upgradeAction": () => <a href="/settings/billing">Upgrade plan</a> } };
    const modal = await openModal(REPORT, [upgrade]);

    expect(await within(modal).findByRole("link", { name: "Upgrade plan" })).toBeTruthy();
    expect(within(modal).queryByRole("group", { name: "Sharing" })).toBeNull();
    expect(within(modal).queryByRole("button", { name: "Manage" })).toBeNull();
    expect(calls("GET", `/api/v1/bookmarks/${REPORT}/shares`)).toHaveLength(0);
  });

  it("shows nothing where the workspace has no sharing entitlement and nothing fills the upgrade slot", async () => {
    world.sharingMembers = false;
    world.sharingTeams = false;
    const modal = await openModal();
    await within(modal).findByRole("textbox", { name: "Title" });

    await waitFor(() => {
      expect(within(modal).queryByRole("group", { name: "Sharing" })).toBeNull();
    });
    expect(within(modal).queryByRole("link", { name: "Upgrade plan" })).toBeNull();
    expect(calls("GET", `/api/v1/bookmarks/${REPORT}/shares`)).toHaveLength(0);
  });
});
