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
  /** The events the list holds, in place of the standard ones. */
  events: AuditEvent[] | undefined;
  /** Replaces the answer to the audit list while it returns one. */
  refuse: (url: URL) => Response | undefined;
  received: URL[];
  memberRequests: number;
}

let world: World;

function newWorld(): World {
  return { entitled: true, membersFail: false, membersSecondPage: undefined, events: undefined, refuse: () => undefined, received: [], memberRequests: 0 };
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
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        const matching = (world.events ?? EVENTS).filter(
          (candidate) =>
            (actor === null || candidate.actor.accountId === actor) &&
            (categories.length === 0 || categories.includes(candidate.category ?? "")) &&
            (from === null || Date.parse(candidate.createdAt) >= Date.parse(from)) &&
            (to === null || Date.parse(candidate.createdAt) < Date.parse(to)),
        );
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

/** The `from` and `to` of each request, the way they were sent. */
function askedRange(): string[] {
  return world.received.map((url) => `${url.searchParams.get("from") ?? ""}|${url.searchParams.get("to") ?? ""}`);
}

async function choosePreset(name: string): Promise<void> {
  await press(await screen.findByRole("combobox", { name: "Date range" }));
  await press(await screen.findByRole("option", { name }));
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

describe("the date range in the address", () => {
  it("keeps a preset, or the days of a range that can be asked for, and drops everything else", () => {
    expect(validateAuditSearch({ range: "24h" })).toEqual({ range: "24h" });
    expect(validateAuditSearch({ range: "90d" })).toEqual({ range: "90d" });
    expect(validateAuditSearch({ from: "2026-01-15", to: "2026-01-20" })).toEqual({ from: "2026-01-15", to: "2026-01-20" });
    expect(validateAuditSearch({ from: "2026-01-15" })).toEqual({ from: "2026-01-15" });
    expect(validateAuditSearch({ to: "9999-12-31" })).toEqual({ to: "9999-12-31" });
    // A preset takes the place of the days.
    expect(validateAuditSearch({ range: "7d", from: "2026-01-15", to: "2026-01-20" })).toEqual({ range: "7d" });
    expect(validateAuditSearch({ range: "1y" })).toEqual({});
    expect(validateAuditSearch({ range: ["7d"] })).toEqual({});
    expect(validateAuditSearch({ range: "constructor" })).toEqual({});
    // A day that is none, or outside years 0001 to 9999, is dropped on its own.
    expect(validateAuditSearch({ from: "2026-02-30", to: "2026-03-01" })).toEqual({ to: "2026-03-01" });
    expect(validateAuditSearch({ from: "0000-01-01", to: "2026-03-01" })).toEqual({ to: "2026-03-01" });
    expect(validateAuditSearch({ from: "10000-01-01" })).toEqual({});
    expect(validateAuditSearch({ from: "2026-1-5", to: 20260105 })).toEqual({});
    expect(validateAuditSearch({ from: ["2026-01-15"] })).toEqual({});
    // A range that ends before it starts is dropped whole.
    expect(validateAuditSearch({ from: "2026-02-01", to: "2026-01-01" })).toEqual({});
    expect(validateAuditSearch({ actor: GRACE, from: "2026-01-15", to: "2026-01-15" })).toEqual({ actor: GRACE, from: "2026-01-15", to: "2026-01-15" });
  });
});

describe("the date range of the log", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  const ZONE = "America/Los_Angeles";
  let zone: string | undefined;

  beforeEach(() => {
    zone = process.env["TZ"];
    process.env["TZ"] = ZONE;
    // The days below are the viewer's: the failure is a range that is cut at midnight UTC instead.
    expect(new Date(2026, 0, 15).getTimezoneOffset()).toBe(480);
  });

  afterEach(() => {
    if (zone === undefined) {
      Reflect.deleteProperty(process.env, "TZ");
    } else {
      process.env["TZ"] = zone;
    }
  });

  /** An event at a given instant, for the days of the viewer's zone. */
  function eventAt(n: number, createdAt: string): AuditEvent {
    return { ...event(n, ADA_LABEL, "team.created", "team"), createdAt };
  }

  // The 15th of January 2026 is 08:00 UTC to 08:00 UTC the next day in Los Angeles.
  const DAY_EVENTS = [
    eventAt(1, "2026-01-16T08:30:00.000Z"),
    eventAt(2, "2026-01-16T07:30:00.000Z"),
    eventAt(3, "2026-01-15T12:00:00.000Z"),
    eventAt(4, "2026-01-15T08:00:00.000Z"),
    eventAt(5, "2026-01-15T07:30:00.000Z"),
  ];

  it("asks for a day of the viewer's zone, from its start to the start of the next, and lists exactly that day's events", async () => {
    world.events = DAY_EVENTS;
    await open("/settings/workspace/audit?from=2026-01-15&to=2026-01-15");
    await table();

    expect(askedRange()).toEqual(["2026-01-15T08:00:00.000Z|2026-01-16T08:00:00.000Z"]);
    // The last event of the evening (23:30 on the 15th) is in, the first of the 16th and the last of the 14th are not.
    expect(world.received[0]?.searchParams.get("cursor")).toBeNull();
    await press(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => {
      expect(screen.getByText("Showing 3 events")).toBeTruthy();
    });
    expect(listed()).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("takes the last day to the start of the day after it across a change of the clock, and leaves an open end out", async () => {
    await open("/settings/workspace/audit?from=2026-03-08&to=2026-03-08");
    await waitFor(() => {
      expect(world.received).toHaveLength(1);
    });
    // The clocks went forward on the 8th of March: the day is 23 hours long.
    expect(askedRange()).toEqual(["2026-03-08T08:00:00.000Z|2026-03-09T07:00:00.000Z"]);
  });

  it("asks from the first day alone, or up to the last day alone", async () => {
    await open("/settings/workspace/audit?from=2026-01-15");
    await table();
    expect(askedRange()).toEqual(["2026-01-15T08:00:00.000Z|"]);
    await press(within(screen.getByRole("list", { name: "Active filters" })).getByRole("button", { name: /^Remove filter: From/ }));
    await waitFor(() => {
      expect(askedRange().at(-1)).toBe("|");
    });

    window.history.replaceState(null, "", "/settings/workspace/audit?to=2026-01-15");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => {
      expect(askedRange().at(-1)).toBe("|2026-01-16T08:00:00.000Z");
    });
  });

  it("leaves out an end past year 9999, and keeps the first instant inside year 0001 for a start before it", async () => {
    await open("/settings/workspace/audit?to=9999-12-31");
    await waitFor(() => {
      expect(world.received).toHaveLength(1);
    });
    // In Los Angeles the day after 9999-12-31 begins in year 10000, which the API refuses: no end is sent.
    expect(askedRange()).toEqual(["|"]);

    // In Tokyo 0001-01-01 begins in year 0000, which the API refuses too: the first instant stands for it.
    process.env["TZ"] = "Asia/Tokyo";
    await act(async () => {
      window.history.pushState(null, "", "/settings/workspace/audit?from=0001-01-01");
      window.dispatchEvent(new PopStateEvent("popstate"));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(askedRange().at(-1)).toBe("0001-01-01T00:00:00.000Z|");
    });
  });

  it("asks from a preset backwards from the moment of the request, with no end, and takes it off with its chip", async () => {
    await open("/settings/workspace/audit");
    await table();
    expect(askedRange()).toEqual(["|"]);

    const before = Date.now();
    await choosePreset("Last 7 days");

    await waitFor(() => {
      expect(window.location.search).toContain("range=7d");
    });
    await waitFor(() => {
      expect(askedRange()).toHaveLength(2);
    });
    const [from, to] = askedRange().at(-1)?.split("|") ?? [];
    expect(to).toBe("");
    expect(Date.parse(from ?? "")).toBeGreaterThanOrEqual(before - 7 * 24 * 3_600_000);
    expect(Date.parse(from ?? "")).toBeLessThanOrEqual(Date.now() - 7 * 24 * 3_600_000);
    expect(screen.getByRole("combobox", { name: "Date range" }).textContent).toContain("Last 7 days");
    const chips = screen.getByRole("list", { name: "Active filters" });
    expect(within(chips).getByText("Last 7 days")).toBeTruthy();
    expect(screen.queryByLabelText("First day")).toBeNull();

    await press(within(chips).getByRole("button", { name: "Remove filter: Last 7 days" }));

    await waitFor(() => {
      expect(window.location.search).toBe("");
    });
    await waitFor(() => {
      expect(askedRange().at(-1)).toBe("|");
    });
    expect(screen.getByRole("combobox", { name: "Date range" }).textContent).toContain("Any time");
  });

  it.each([
    ["Last 24 hours", "24h", 24],
    ["Last 30 days", "30d", 30 * 24],
    ["Last 90 days", "90d", 90 * 24],
  ])("reaches back as far as %s says", async (name, range, hours) => {
    await open(`/settings/workspace/audit?range=${range}`);
    await table();

    const [from] = askedRange()[0]?.split("|") ?? [];
    expect(Math.abs(Date.now() - hours * 3_600_000 - Date.parse(from ?? ""))).toBeLessThan(60_000);
    expect(screen.getByRole("combobox", { name: "Date range" }).textContent).toContain(name);
  });

  it("sends the same `from` with every page of one list, as a cursor is valid only with the bounds it was issued for", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-02-01T12:00:00.000Z") });
    try {
      await open("/settings/workspace/audit?range=24h");
      await table();
      expect(askedRange()).toEqual(["2026-01-31T12:00:00.000Z|"]);

      vi.setSystemTime(new Date("2026-02-01T12:30:00.000Z"));
      await press(screen.getByRole("button", { name: "Load more" }));
      await waitFor(() => {
        expect(world.received).toHaveLength(2);
      });

      expect(world.received[1]?.searchParams.get("cursor")).toBe("offset-2");
      expect(askedRange()).toEqual(["2026-01-31T12:00:00.000Z|", "2026-01-31T12:00:00.000Z|"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not ask again on its own while the page stays, though the preset's `from` moves with the clock", async () => {
    await open("/settings/workspace/audit?range=7d");
    await table();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(world.received).toHaveLength(1);
  });

  it("starts the list again, from its first page, when the range changes", async () => {
    await open("/settings/workspace/audit?range=30d");
    await table();
    await press(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => {
      expect(listed()).toHaveLength(4);
    });

    await choosePreset("Last 24 hours");

    await waitFor(() => {
      expect(window.location.search).toContain("range=24h");
    });
    await waitFor(() => {
      expect(world.received.at(-1)?.searchParams.get("cursor")).toBeNull();
      expect(listed()).toHaveLength(2);
    });
    expect(screen.getByText("Showing 2 events")).toBeTruthy();
  });

  it("chooses a custom range by its days: nothing is asked until a day is entered, then the address holds them", async () => {
    await open("/settings/workspace/audit");
    await table();

    await choosePreset("Custom range");

    const first = await screen.findByLabelText<HTMLInputElement>("First day");
    const last = screen.getByLabelText<HTMLInputElement>("Last day");
    expect(first.type).toBe("date");
    expect(first.min).toBe("0001-01-01");
    expect(first.max).toBe("9999-12-31");
    expect(window.location.search).toBe("");
    expect(world.received).toHaveLength(1);

    await type(first, "2026-01-15");
    await waitFor(() => {
      expect(window.location.search).toContain("from=2026-01-15");
    });
    await waitFor(() => {
      expect(askedRange().at(-1)).toBe("2026-01-15T08:00:00.000Z|");
    });
    await type(last, "2026-01-15");
    await waitFor(() => {
      expect(askedRange().at(-1)).toBe("2026-01-15T08:00:00.000Z|2026-01-16T08:00:00.000Z");
    });
    expect(window.location.search).toContain("to=2026-01-15");
    expect(window.location.search).not.toContain("range");
    const chips = screen.getByRole("list", { name: "Active filters" });
    expect(within(chips).getByText("Jan 15, 2026 to Jan 15, 2026")).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("First day").value).toBe("2026-01-15");
  });

  it("says a first day after the last under the field, asks for nothing, and asks again once it is put right", async () => {
    world.events = DAY_EVENTS;
    await open("/settings/workspace/audit?from=2026-01-14&to=2026-01-16");
    await table();
    expect(world.received).toHaveLength(1);

    await type(screen.getByLabelText("First day"), "2026-01-20");

    expect(await screen.findByText("The last day is before the first day.")).toBeTruthy();
    expect(screen.getByLabelText("Last day").getAttribute("aria-invalid")).toBe("true");
    expect(world.received).toHaveLength(1);
    expect(window.location.search).toContain("from=2026-01-14");
    // The table is still the one of the range asked for, not an error banner.
    expect(screen.getByRole("table", { name: "Audit log" })).toBeTruthy();
    expect(screen.queryByText("The audit log could not be loaded")).toBeNull();
    await noViolations();

    await type(screen.getByLabelText("Last day"), "2026-01-25");

    await waitFor(() => {
      expect(askedRange().at(-1)).toBe("2026-01-20T08:00:00.000Z|2026-01-26T08:00:00.000Z");
    });
    expect(screen.queryByText("The last day is before the first day.")).toBeNull();
  });

  it("refuses a day outside years 0001 to 9999 under its field and asks for nothing", async () => {
    world.events = DAY_EVENTS;
    await open("/settings/workspace/audit?from=2026-01-14&to=2026-01-16");
    await table();

    await type(screen.getByLabelText("Last day"), "10000-01-01");

    expect(await screen.findByText("Enter a day from year 0001 to 9999.")).toBeTruthy();
    expect(world.received).toHaveLength(1);
    expect(window.location.search).toContain("to=2026-01-16");
  });

  it("shows a refused range beside the range, never as the table's banner or as an empty list, and lets it be changed", async () => {
    world.refuse = (url) => (url.searchParams.has("to") ? problem(422, "validation_failed", "req-422") : undefined);
    await open("/settings/workspace/audit?from=2026-01-10&to=2026-01-12");

    expect(await screen.findByText("These days could not be used. Choose other days.")).toBeTruthy();
    expect(screen.getByLabelText("Last day").getAttribute("aria-invalid")).toBe("true");
    expect(screen.queryByText("The audit log could not be loaded")).toBeNull();
    expect(screen.queryByText("No events match these filters")).toBeNull();
    expect(screen.queryByText("No events yet")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    await noViolations();

    await type(screen.getByLabelText("Last day"), "");

    await waitFor(() => {
      expect(askedRange().at(-1)).toBe("2026-01-10T08:00:00.000Z|");
    });
    expect(await table()).toBeTruthy();
    expect(screen.queryByText("These days could not be used. Choose other days.")).toBeNull();
  });

  it("still says that the log could not be loaded for another failure of a ranged list", async () => {
    world.refuse = (url) => (url.searchParams.has("from") ? problem(500, "internal", "req-500") : undefined);
    await open("/settings/workspace/audit?range=7d");

    expect(await screen.findByText("The audit log could not be loaded")).toBeTruthy();
    expect(screen.queryByText("These days could not be used. Choose other days.")).toBeNull();
  });

  it("keeps the range through a reload of the address and with the actor, and steps back through its changes", async () => {
    world.events = DAY_EVENTS;
    await open(`/settings/workspace/audit?actor=${ADA}&from=2026-01-15&to=2026-01-15`);
    await table();

    expect(world.received).toHaveLength(1);
    expect(world.received[0]?.searchParams.get("actorAccountId")).toBe(ADA);
    expect(askedRange()).toEqual(["2026-01-15T08:00:00.000Z|2026-01-16T08:00:00.000Z"]);
    expect(screen.getByRole("combobox", { name: "Date range" }).textContent).toContain("Custom range");
    expect(screen.getByLabelText<HTMLInputElement>("First day").value).toBe("2026-01-15");
    expect(screen.getByLabelText<HTMLInputElement>("Last day").value).toBe("2026-01-15");

    await choosePreset("Last 7 days");
    await waitFor(() => {
      expect(window.location.search).toContain("range=7d");
    });
    expect(window.location.search).not.toContain("from=");
    expect(window.location.search).toContain(`actor=${ADA}`);

    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    await waitFor(() => {
      expect(window.location.search).toContain("from=2026-01-15");
    });
    expect(window.location.search).not.toContain("range");
    expect(screen.getByLabelText<HTMLInputElement>("First day").value).toBe("2026-01-15");
  });

  it("ignores a malformed range in the address and shows the whole log", async () => {
    await open("/settings/workspace/audit?range=1y&from=2026-02-30&to=nonsense");
    await table();

    expect(askedRange()).toEqual(["|"]);
    expect(screen.queryByRole("list", { name: "Active filters" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Date range" }).textContent).toContain("Any time");
    expect(screen.queryByLabelText("First day")).toBeNull();
  });

  it("is taken off by Clear filters with the other filters", async () => {
    await open(`/settings/workspace/audit?actor=${GRACE}&from=2026-01-15&to=2026-01-15`);

    expect(await screen.findByText("No events match these filters")).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("First day").value).toBe("2026-01-15");

    await press(screen.getByRole("button", { name: "Clear filters" }));

    await waitFor(() => {
      expect(window.location.search).toBe("");
    });
    expect(await table()).toBeTruthy();
    expect(askedRange().at(-1)).toBe("|");
    expect(screen.queryByRole("list", { name: "Active filters" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Date range" }).textContent).toContain("Any time");
    expect(screen.queryByLabelText("First day")).toBeNull();
  });

  it("is taken off by Clear filters also when the custom range had no day yet", async () => {
    world.refuse = (url) => (url.searchParams.get("actorAccountId") === GRACE ? json({ items: [], nextCursor: null }) : undefined);
    await open(`/settings/workspace/audit?actor=${GRACE}`);
    expect(await screen.findByText("No events match these filters")).toBeTruthy();
    await choosePreset("Custom range");
    await screen.findByLabelText("First day");

    await press(screen.getByRole("button", { name: "Clear filters" }));

    await waitFor(() => {
      expect(screen.queryByLabelText("First day")).toBeNull();
    });
    expect(screen.getByRole("combobox", { name: "Date range" }).textContent).toContain("Any time");
  });

  it("lists the presets and the custom range with the keyboard", async () => {
    await open("/settings/workspace/audit");
    await table();
    const select = await screen.findByRole("combobox", { name: "Date range" });
    await act(async () => {
      select.focus();
      await Promise.resolve();
    });

    await key({ key: "ArrowDown" }, select);
    const options = (await screen.findAllByRole("option")).map((option) => option.textContent);
    expect(options).toEqual(["Any time", "Last 24 hours", "Last 7 days", "Last 30 days", "Last 90 days", "Custom range"]);
    await press(screen.getByRole("option", { name: "Last 30 days" }));

    await waitFor(() => {
      expect(window.location.search).toContain("range=30d");
    });
    await waitFor(() => {
      expect(askedRange()).toHaveLength(2);
    });
  });

  it("finds no violation with the presets open, and with the days of a custom range shown", async () => {
    world.events = DAY_EVENTS;
    await open("/settings/workspace/audit?from=2026-01-14&to=2026-01-20");
    await table();
    await noViolations();

    await press(await screen.findByRole("combobox", { name: "Date range" }));
    await screen.findByRole("option", { name: "Last 7 days" });
    await noViolations();
  });
});

describe("the date range in German", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("names the picker, the days and the chip in German, with the dates the way German writes them, without accessibility violations", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-DE", "de"]);
    world.events = [{ ...event(1, ADA_LABEL, "team.created", "team"), createdAt: "2026-01-16T12:00:00.000Z" }];
    await open("/settings/workspace/audit?from=2026-01-15&to=2026-01-20");
    expect(await screen.findByRole("table", { name: "Audit-Log" })).toBeTruthy();

    expect(screen.getByRole("combobox", { name: "Zeitraum" }).textContent).toContain("Eigener Zeitraum");
    expect(screen.getByLabelText<HTMLInputElement>("Erster Tag").value).toBe("2026-01-15");
    expect(screen.getByLabelText("Letzter Tag")).toBeTruthy();
    const chips = screen.getByRole("list", { name: "Aktive Filter" });
    expect(within(chips).getByText("15.01.2026 bis 20.01.2026")).toBeTruthy();
    await noViolations();

    await type(screen.getByLabelText("Erster Tag"), "2026-02-01");
    expect(await screen.findByText("Der letzte Tag liegt vor dem ersten Tag.")).toBeTruthy();

    await press(await screen.findByRole("combobox", { name: "Zeitraum" }));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
      "Beliebiger Zeitraum",
      "Letzte 24 Stunden",
      "Letzte 7 Tage",
      "Letzte 30 Tage",
      "Letzte 90 Tage",
      "Eigener Zeitraum",
    ]);
    await noViolations();
  });
});
