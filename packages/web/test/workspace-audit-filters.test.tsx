import type { ComponentTypes } from "@slugbase/contracts";
import { createHandlers, createResolverHandlers } from "@slugbase/testing/msw";
import { createMockServer, readOpenApiDocument } from "@slugbase/testing/msw/node";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp } from "../src/index.ts";
import { validateAuditSearch } from "../src/audit/audit-search.ts";
import { ACCOUNT_BODY, WORKSPACE_ID, allowSlowRender, json, problem, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The filters of /settings/workspace/audit (doc 03 sections 3.1 and 11.9) against the handlers generated from openapi.json. The server here applies the filters it is
// sent, so the failure scenarios are a filter the list ignores, a change of filter that keeps the previous filter's pages or its cursor, a member who left shown under the
// wrong name or dropped from the filter, a failed list shown as "no events match", and a failed members list that blocks the table.

type AuditEvent = ComponentTypes["schemas"]["AuditEvent"];

const server = createMockServer();
const document_ = readOpenApiDocument();

const ADA = ACCOUNT_BODY.id;
const GRACE = "0192f3a0-bbbb-7000-8000-000000000002";
const FORMER = "0192f3a0-bbbb-7000-8000-000000000009";
const STAMP = "2026-10-01T08:00:00.000Z";
const PAGE = 2;

const PEOPLE = [
  { accountId: ADA, displayName: "Ada Lovelace", email: "ada@example.org" },
  { accountId: GRACE, displayName: "Grace Hopper", email: "grace@example.org" },
] as const;

const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString();

function event(n: number, actor: { accountId: string; label: string }, action: string, category: AuditEvent["category"]): AuditEvent {
  return {
    id: `0192f3a0-eeee-7000-8000-${String(n).padStart(12, "0")}`,
    createdAt: hoursAgo(n),
    actor: { type: "account", ...actor },
    action,
    category,
    entity: null,
    metadata: {},
  };
}

const ADA_LABEL = { accountId: ADA, label: "Ada Lovelace" };
const GRACE_LABEL = { accountId: GRACE, label: "Grace Hopper" };
const FORMER_LABEL = { accountId: FORMER, label: "Hedy Lamarr" };

// Newest first. Ada: 1, 3, 5, 7; Grace: 2, 6; the former member: 4, 8.
const EVENTS: AuditEvent[] = [
  event(1, ADA_LABEL, "team.created", "team"),
  event(2, GRACE_LABEL, "member.removed", "member"),
  event(3, ADA_LABEL, "share.granted", "share"),
  event(4, FORMER_LABEL, "team.deleted", "team"),
  event(5, ADA_LABEL, "team.updated", "team"),
  event(6, GRACE_LABEL, "share.revoked", "share"),
  event(7, ADA_LABEL, "member.joined", "member"),
  event(8, FORMER_LABEL, "member.left", "member"),
];

interface World {
  entitled: boolean;
  /** Fails the members list. */
  membersFail: boolean;
  /** Serves the members in two pages, the second held back until this promise settles. */
  membersSecondPage: Promise<void> | undefined;
  /** Replaces the answer to the audit list while it returns one. */
  refuse: (url: URL) => Response | undefined;
  received: URL[];
  memberRequests: number;
}

let world: World;

function newWorld(): World {
  return { entitled: true, membersFail: false, membersSecondPage: undefined, refuse: () => undefined, received: [], memberRequests: 0 };
}

function serve(): void {
  server.use(
    ...createResolverHandlers(document_, {
      getMe: () =>
        json({
          account: { ...ACCOUNT_BODY, locale: globalThis.navigator.languages.some((language) => language.startsWith("de")) ? "de" : "en" },
          memberships: [{ workspaceId: WORKSPACE_ID, name: "Ada's Workspace", role: "owner" }],
          activeWorkspaceId: WORKSPACE_ID,
        }),
      getWorkspace: () =>
        json({ id: WORKSPACE_ID, name: "Ada's Workspace", role: "owner", memberCount: 2, createdAt: STAMP, version: 1 }, { headers: { ETag: '"1"' } }),
      getEntitlements: () =>
        json({
          entitlements: {
            "bookmarks.max": "unlimited",
            "seats.max": "unlimited",
            "workspaces.ownMax": "unlimited",
            "ai.suggestions": true,
            "sharing.members": true,
            "sharing.teams": true,
            "members.invite": true,
            "teams.manage": true,
            "audit.log": world.entitled,
          },
          usage: { "bookmarks.used": 0, "seats.used": 2, "workspaces.owned": 1 },
          upgradeAvailable: true,
        }),
      listMembers: async (request) => {
        world.memberRequests += 1;
        if (world.membersFail) {
          return problem(500, "internal", "req-500");
        }
        const member = (person: (typeof PEOPLE)[number]) => ({ ...person, role: "member", joinedAt: STAMP, lastActiveAt: null, teams: [] });
        if (world.membersSecondPage === undefined) {
          return json({ items: PEOPLE.map(member), nextCursor: null });
        }
        if (new URL(request.url).searchParams.get("cursor") === null) {
          return json({ items: [member(PEOPLE[0])], nextCursor: "page-2" });
        }
        await world.membersSecondPage;
        return json({ items: [member(PEOPLE[1])], nextCursor: null });
      },
      listAuditEvents: (request) => {
        const url = new URL(request.url);
        world.received.push(url);
        const steered = world.refuse(url);
        if (steered !== undefined) {
          return steered;
        }
        const actor = url.searchParams.get("actorAccountId");
        const categories = url.searchParams.getAll("category");
        const matching = EVENTS.filter((candidate) => (actor === null || candidate.actor.accountId === actor) && (categories.length === 0 || categories.includes(candidate.category ?? "")));
        const cursor = url.searchParams.get("cursor");
        const offset = cursor === null ? 0 : Number(cursor.replace("offset-", ""));
        const items = matching.slice(offset, offset + PAGE);
        return json({ items, nextCursor: offset + PAGE < matching.length ? `offset-${String(offset + PAGE)}` : null });
      },
    }),
    ...createHandlers(document_, { scenario: { name: "audit-filters", fixtures: {} } }),
  );
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
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("lang");
});

async function open(path: string): Promise<void> {
  serve();
  window.history.replaceState(null, "", path);
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
}

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.pointerDown(element);
    fireEvent.mouseDown(element);
    fireEvent.click(element);
    await Promise.resolve();
  });
}

async function key(init: KeyboardEventInit, target: Element): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(target, init);
    await Promise.resolve();
  });
}

async function type(input: HTMLElement, text: string): Promise<void> {
  await act(async () => {
    fireEvent.change(input, { target: { value: text } });
    await Promise.resolve();
  });
}

async function noViolations(): Promise<void> {
  const results = await axe(document.body, { rules: { region: { enabled: false } } });
  expect(results.violations.map(({ id }) => id)).toEqual([]);
}

async function table(): Promise<HTMLElement> {
  return screen.findByRole("table", { name: "Audit log" });
}

/** The actions listed, in the order shown. */
function listed(): string[] {
  return within(screen.getByRole("table", { name: "Audit log" }))
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[2]?.querySelector("button")?.textContent ?? "");
}

function asked(): string[] {
  return world.received.map((url) => `${url.searchParams.get("actorAccountId") ?? ""}|${url.searchParams.getAll("category").join(",")}|${url.searchParams.get("cursor") ?? ""}`);
}

async function chooseActor(name: string): Promise<void> {
  const input = await screen.findByRole("combobox", { name: "Actor" });
  await press(input);
  await press(await screen.findByRole("option", { name: new RegExp(`^${name}`), hidden: true }));
}

async function chooseCategory(name: string): Promise<void> {
  const input = await screen.findByRole("combobox", { name: "Action category" });
  await press(input);
  await press(await screen.findByRole("option", { name: new RegExp(`^${name}$`), hidden: true }));
  await key({ key: "Escape" }, input);
  await waitFor(() => {
    expect(screen.queryByRole("listbox", { hidden: true })).toBeNull();
  });
}

describe("the address", () => {
  it("keeps a valid actor and the known categories, and drops everything else", () => {
    expect(validateAuditSearch({})).toEqual({});
    expect(validateAuditSearch({ actor: GRACE, category: ["team", "share"] })).toEqual({ actor: GRACE, category: ["team", "share"] });
    expect(validateAuditSearch({ category: "member" })).toEqual({ category: ["member"] });
    expect(validateAuditSearch({ actor: "not-an-id", category: ["nonsense", 7, null, "team", "team"] })).toEqual({ category: ["team"] });
    expect(validateAuditSearch({ actor: ["a"], category: { team: true } })).toEqual({});
    expect(validateAuditSearch({ actor: 12, category: "constructor" })).toEqual({});
  });
});

describe("the filters of the log", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("asks for the whole log without filters and shows no chip", async () => {
    await open("/settings/workspace/audit");
    await table();

    expect(asked()).toEqual(["||"]);
    expect(screen.queryByRole("list", { name: "Active filters" })).toBeNull();
    expect(listed()).toEqual(["Team created", "Member removed"]);
  });

  it("lists the members by name with their email, and filters by the one chosen, starting from the first page", async () => {
    await open("/settings/workspace/audit");
    await table();
    await press(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => {
      expect(listed()).toHaveLength(4);
    });

    const input = await screen.findByRole("combobox", { name: "Actor" });
    await press(input);
    const grace = await screen.findByRole("option", { name: /^Grace Hopper/, hidden: true });
    expect(within(grace).getByText("grace@example.org")).toBeTruthy();
    await press(grace);

    await waitFor(() => {
      expect(window.location.search).toContain(`actor=${GRACE}`);
    });
    await waitFor(() => {
      expect(listed()).toEqual(["Member removed", "Share revoked"]);
    });
    // The list starts again: the request carries the actor and no cursor, and no row of the unfiltered list is left.
    expect(asked().at(-1)).toBe(`${GRACE}||`);
    expect(screen.getByRole<HTMLInputElement>("combobox", { name: "Actor" }).value).toBe("Grace Hopper");
    const chips = screen.getByRole("list", { name: "Active filters" });
    expect(within(chips).getByText("Grace Hopper")).toBeTruthy();
    expect(screen.getByText("Showing 2 events")).toBeTruthy();
  });

  it("sends every chosen category and starts again from the first page when it changes", async () => {
    await open("/settings/workspace/audit");
    await table();
    await press(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => {
      expect(listed()).toHaveLength(4);
    });

    await chooseCategory("Sharing");
    await waitFor(() => {
      expect(listed()).toEqual(["Share granted", "Share revoked"]);
    });
    expect(asked().at(-1)).toBe("|share|");

    await chooseCategory("Team");
    await waitFor(() => {
      expect(asked().at(-1)).toBe("|share,team|");
    });
    expect(await screen.findByText("Showing 2 events")).toBeTruthy();
    expect(listed()).toEqual(["Team created", "Share granted"]);
    expect(window.location.search).toContain("category=");
    expect(screen.getByRole("button", { name: "Remove category Sharing" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove category Team" })).toBeTruthy();
    // No request of a changed filter carried a cursor of the previous one.
    expect(asked().filter((line) => line.endsWith("|offset-2"))).toEqual(["||offset-2"]);
  });

  it("combines the actor and the categories in one request and takes a category off with its chip", async () => {
    await open(`/settings/workspace/audit?actor=${ADA}&category=${encodeURIComponent('["team","share"]')}`);
    await table();

    expect(asked()).toEqual([`${ADA}|team,share|`]);
    expect(listed()).toEqual(["Team created", "Share granted"]);

    await press(screen.getByRole("button", { name: "Remove category Team" }));

    await waitFor(() => {
      expect(asked().at(-1)).toBe(`${ADA}|share|`);
    });
    expect(await screen.findByText("Showing 1 event")).toBeTruthy();
    expect(listed()).toEqual(["Share granted"]);
  });

  it("shows the list of a link the same after a reload, and steps through the filter changes with the back button", async () => {
    await open("/settings/workspace/audit");
    await table();
    await chooseActor("Ada");
    await waitFor(() => {
      expect(asked().at(-1)).toBe(`${ADA}||`);
    });
    await chooseCategory("Sharing");
    await waitFor(() => {
      expect(asked().at(-1)).toBe(`${ADA}|share|`);
    });
    expect(await screen.findByText("Showing 1 event")).toBeTruthy();

    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    await waitFor(() => {
      expect(window.location.search).not.toContain("category");
    });
    expect(window.location.search).toContain(`actor=${ADA}`);
    await waitFor(() => {
      expect(screen.getByText("Showing 2 events")).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: "Remove category Sharing" })).toBeNull();
  });

  it("filters by an actor who is no member any more, names the chip a former member, and still lets the filter go", async () => {
    await open(`/settings/workspace/audit?actor=${FORMER}`);
    await table();

    expect(asked()).toEqual([`${FORMER}||`]);
    expect(listed()).toEqual(["Team deleted", "Member left"]);
    const chips = await screen.findByRole("list", { name: "Active filters" });
    expect(await within(chips).findByText("Former member")).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>("combobox", { name: "Actor" }).value).toBe("");

    await press(within(chips).getByRole("button", { name: "Remove filter: Former member" }));

    await waitFor(() => {
      expect(window.location.search).not.toContain("actor");
    });
    await waitFor(() => {
      expect(asked().at(-1)).toBe("||");
    });
    expect(screen.queryByRole("list", { name: "Active filters" })).toBeNull();
  });

  it("ignores a malformed actor and an unknown category in the address", async () => {
    await open(`/settings/workspace/audit?actor=nobody&category=${encodeURIComponent('["nonsense"]')}`);
    await table();

    expect(asked()).toEqual(["||"]);
    expect(screen.queryByRole("list", { name: "Active filters" })).toBeNull();
    expect(screen.queryByText("Former member")).toBeNull();
  });

  it("does not call a member who is merely not read yet a former member", async () => {
    await open(`/settings/workspace/audit?actor=${GRACE}`);
    await table();

    const chips = await screen.findByRole("list", { name: "Active filters" });
    expect(await within(chips).findByText("Grace Hopper")).toBeTruthy();
    expect(within(chips).queryByText("Former member")).toBeNull();
  });

  it("names an actor a former member only once the whole members list, to its last page, does not hold them", async () => {
    let release: () => void = () => undefined;
    world.membersSecondPage = new Promise<void>((resolve) => {
      release = resolve;
    });
    await open(`/settings/workspace/audit?actor=${FORMER}`);
    await table();

    // The first page is read and does not hold the actor, the second is not: they may be on it.
    await waitFor(() => {
      expect(world.memberRequests).toBe(2);
    });
    const chips = screen.getByRole("list", { name: "Active filters" });
    expect(within(chips).getByText("Actor")).toBeTruthy();
    expect(within(chips).queryByText("Former member")).toBeNull();

    release();

    expect(await within(chips).findByText("Former member")).toBeTruthy();
    expect(within(chips).queryByText("Actor")).toBeNull();
  });

  it("names an actor on a members page that is read late by their name, never a former member", async () => {
    let release: () => void = () => undefined;
    world.membersSecondPage = new Promise<void>((resolve) => {
      release = resolve;
    });
    await open(`/settings/workspace/audit?actor=${GRACE}`);
    await table();

    await waitFor(() => {
      expect(world.memberRequests).toBe(2);
    });
    const chips = screen.getByRole("list", { name: "Active filters" });
    expect(within(chips).getByText("Actor")).toBeTruthy();
    expect(within(chips).queryByText("Former member")).toBeNull();

    release();

    expect(await within(chips).findByText("Grace Hopper")).toBeTruthy();
    expect(within(chips).queryByText("Former member")).toBeNull();
  });
});

describe("no event matches", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("replaces the table with a state that says so, and Clear filters removes every filter", async () => {
    const unusedCategory = "invitation";
    await open(`/settings/workspace/audit?actor=${ADA}&category=${unusedCategory}`);

    expect(await screen.findByText("No events match these filters")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("No events yet")).toBeNull();
    // The bar stays, so that a filter can be changed.
    expect(screen.getByRole("combobox", { name: "Actor" })).toBeTruthy();
    await noViolations();

    await press(screen.getByRole("button", { name: "Clear filters" }));

    await waitFor(() => {
      expect(window.location.search).toBe("");
    });
    expect(await table()).toBeTruthy();
    expect(asked().at(-1)).toBe("||");
    expect(screen.queryByText("No events match these filters")).toBeNull();
    expect(screen.queryByRole("list", { name: "Active filters" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove category/ })).toBeNull();
  });

  it("shows the teaching state of the empty log, not the no-match state, where no filter is set", async () => {
    world.refuse = () => json({ items: [], nextCursor: null });
    await open("/settings/workspace/audit");

    expect(await screen.findByText("No events yet")).toBeTruthy();
    expect(screen.queryByText("No events match these filters")).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  it("says the log could not be loaded, never that no event matches, when a filtered list fails", async () => {
    world.refuse = (url) => (url.searchParams.has("actorAccountId") ? problem(500, "internal", "req-500") : undefined);
    await open(`/settings/workspace/audit?actor=${ADA}`);

    expect(await screen.findByText("The audit log could not be loaded")).toBeTruthy();
    expect(screen.queryByText("No events match these filters")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    // The filter can still be taken off.
    expect(screen.getByRole("button", { name: "Remove filter: Ada Lovelace" })).toBeTruthy();
    await noViolations();

    await press(screen.getByRole("button", { name: "Remove filter: Ada Lovelace" }));

    expect(await table()).toBeTruthy();
  });
});

describe("a members list that fails", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("disables the actor filter with its reason, leaves the table and the category filter, and does not call the actor a former member", async () => {
    world.membersFail = true;
    await open(`/settings/workspace/audit?actor=${GRACE}`);

    expect(await table()).toBeTruthy();
    expect(await screen.findByText("The members could not be loaded, so the actor filter is not available.")).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>("combobox", { name: "Actor" }).disabled).toBe(true);
    expect(asked()).toEqual([`${GRACE}||`]);
    expect(listed()).toEqual(["Member removed", "Share revoked"]);
    const chips = screen.getByRole("list", { name: "Active filters" });
    expect(within(chips).queryByText("Former member")).toBeNull();
    expect(within(chips).getByText("Actor")).toBeTruthy();
    expect(screen.queryByText("No events match these filters")).toBeNull();

    await chooseCategory("Member");
    await waitFor(() => {
      expect(asked().at(-1)).toBe(`${GRACE}|member|`);
    });
    await noViolations();
  });
});

describe("keyboard operation", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("chooses an actor with the arrow keys and Enter", async () => {
    await open("/settings/workspace/audit");
    await table();
    const input = await screen.findByRole("combobox", { name: "Actor" });
    await act(async () => {
      input.focus();
      await Promise.resolve();
    });

    await key({ key: "ArrowDown" }, input);
    await screen.findByRole("option", { name: /^Ada Lovelace/, hidden: true });
    await type(input, "grace");
    await key({ key: "ArrowDown" }, input);
    await key({ key: "Enter" }, input);

    await waitFor(() => {
      expect(asked().at(-1)).toBe(`${GRACE}||`);
    });
    expect(await screen.findByText("Showing 2 events")).toBeTruthy();
  });

  it("chooses categories by typing, with the arrow keys and Enter, and takes the last off with Backspace", async () => {
    await open("/settings/workspace/audit");
    await table();
    const input = await screen.findByRole("combobox", { name: "Action category" });
    await act(async () => {
      input.focus();
      await Promise.resolve();
    });

    await type(input, "shar");
    await key({ key: "ArrowDown" }, input);
    await key({ key: "Enter" }, input);

    await waitFor(() => {
      expect(asked().at(-1)).toBe("|share|");
    });
    expect(screen.getByRole("button", { name: "Remove category Sharing" })).toBeTruthy();

    await key({ key: "Backspace" }, input);

    await waitFor(() => {
      expect(asked().at(-1)).toBe("||");
    });
    expect(screen.queryByRole("button", { name: "Remove category Sharing" })).toBeNull();
  });
});

describe("German", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("shows the filter bar, the chips and the no-match state in German, without accessibility violations", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-DE", "de"]);
    await open(`/settings/workspace/audit?actor=${FORMER}&category=${encodeURIComponent('["share"]')}`);

    expect(await screen.findByText("Keine Ereignisse passen zu diesen Filtern")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Akteur" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Aktionskategorie" })).toBeTruthy();
    const chips = screen.getByRole("list", { name: "Aktive Filter" });
    expect(await within(chips).findByText("Ehemaliges Mitglied")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Kategorie Freigabe entfernen" })).toBeTruthy();
    await noViolations();

    await press(screen.getByRole("button", { name: "Filter zurücksetzen" }));
    expect(await screen.findByRole("table", { name: "Audit-Log" })).toBeTruthy();
  });
});

describe("accessibility", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("finds no violation with the filters set, with the list open and closed", async () => {
    await open(`/settings/workspace/audit?actor=${ADA}&category=${encodeURIComponent('["team"]')}`);
    await table();
    await noViolations();

    await press(await screen.findByRole("combobox", { name: "Actor" }));
    await screen.findByRole("option", { name: /^Ada Lovelace/, hidden: true });
    await noViolations();
  });
});
