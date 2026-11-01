import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Entitlements } from "../src/entitlements/index.ts";
import type { WebExtension } from "../src/extensions/index.ts";
import { createWebApp } from "../src/index.ts";
import { SWITCH_WRITE_WAIT_MS } from "../src/shell/workspaces.ts";
import { ACCOUNT_BODY, ACTIVE_WORKSPACE_PATH, ME_PATH, WORKSPACE_ID, WORKSPACE_NAME, json, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";
import {
  GRACE,
  INVITATIONS_PATH,
  MEMBERS_PATH,
  OTHER_WORKSPACE_ID,
  SECOND_WORKSPACE_NAME,
  SELF,
  WORKSPACE_PATH,
  WORKSPACE_SETTINGS_PATH,
  stubWorkspaceSettingsServer,
} from "./workspace-settings-server.ts";

// A switch of workspace while requests of the previous workspace are out. The failure scenarios are an account read that is
// answered after the switch and puts the previous workspace back, a page that shows or renames the previous workspace's
// document after the switch, entitlements of one workspace stored for the other, and a write that is overtaken by the switch
// and lands in the other workspace.

const SLOW_TEST_TIMEOUT_MS = 30_000;
const LOADED_WAIT = { timeout: 10_000 } as const;
const ENTITLEMENTS_PATH = "/api/v1/entitlements";
const AI_SWITCH = "Enable AI suggestions for this workspace";
const UPGRADE: WebExtension = { id: "upgrade", slots: { "entitlement.upgradeAction": () => <a href="/settings/billing">Upgrade plan</a> } };

type Respond = (response: Response) => void;

function entitlementsBody(aiSuggestions: boolean): Entitlements {
  return {
    entitlements: {
      "bookmarks.max": "unlimited",
      "seats.max": "unlimited",
      "workspaces.ownMax": "unlimited",
      "ai.suggestions": aiSuggestions,
      "sharing.members": true,
      "sharing.teams": true,
      "members.invite": true,
      "teams.manage": true,
      "audit.log": true,
    },
    usage: { "bookmarks.used": 0, "seats.used": 2, "workspaces.owned": 1 },
    upgradeAvailable: true,
  };
}

function workspaceBody(id: string, name: string, version: number) {
  return { id, name, role: "owner", memberCount: 2, createdAt: "2026-09-01T08:00:00.000Z", version };
}

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia(false);
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("lang");
});

async function open(path: string, extensions: readonly WebExtension[] = []): Promise<void> {
  window.history.replaceState(null, "", path);
  const App = createWebApp({ extensions });
  await renderApp(<App />);
}

type Stub = ReturnType<typeof stubWorkspaceSettingsServer>;

/** Waits until the account has been read and no further read starts, so that a late answer cannot undo a switch made after it. */
async function settleAccountReads(stub: Stub): Promise<void> {
  let reads = -1;
  for (let round = 0; round < 20 && reads !== stub.received("GET", ME_PATH).length; round += 1) {
    reads = stub.received("GET", ME_PATH).length;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
  }
}

/** Opens the switcher's menu and chooses the workspace, without waiting for the switch. */
async function choose(stub: Stub, name: string): Promise<void> {
  const trigger = await screen.findByRole("button", { name: /^Workspace: / }, LOADED_WAIT);
  if (trigger.getAttribute("aria-expanded") !== "true") {
    await act(async () => {
      fireEvent.click(trigger);
      await Promise.resolve();
    });
  }
  const item = await screen.findByRole("menuitemradio", { name }, LOADED_WAIT);
  await settleAccountReads(stub);
  await act(async () => {
    fireEvent.click(item);
    await Promise.resolve();
  });
}

async function switchTo(stub: Stub, name: string): Promise<void> {
  await choose(stub, name);
  await screen.findByRole("button", { name: `Workspace: ${name}` }, LOADED_WAIT);
  await settleAccountReads(stub);
}

async function answer(responders: Respond[], response: () => Response): Promise<void> {
  await act(async () => {
    for (const respond of responders.splice(0)) {
      respond(response());
    }
    await Promise.resolve();
  });
}

describe("an account read that is out when the switch is made", () => {
  it("does not put the previous workspace back when it is answered after the switch", async () => {
    const held: Respond[] = [];
    let holding = false;
    const stub = stubWorkspaceSettingsServer({
      second: { aiEnabled: true },
      meGet: () => (holding ? new Promise<Response>((resolve) => held.push(resolve)) : undefined),
    });
    await open("/settings/workspace");
    await screen.findByRole("textbox", { name: "Name" }, LOADED_WAIT);
    await settleAccountReads(stub);

    // The read starts while the session is in the first workspace and is answered with it.
    holding = true;
    await act(async () => {
      window.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(held.length).toBeGreaterThan(0);
    }, LOADED_WAIT);
    holding = false;

    await switchTo(stub, SECOND_WORKSPACE_NAME);
    await answer(held, () =>
      json({
        account: ACCOUNT_BODY,
        memberships: [
          { workspaceId: WORKSPACE_ID, name: WORKSPACE_NAME, role: "owner" },
          { workspaceId: OTHER_WORKSPACE_ID, name: SECOND_WORKSPACE_NAME, role: "owner" },
        ],
        activeWorkspaceId: WORKSPACE_ID,
      }),
    );
    await settleAccountReads(stub);

    expect(screen.getByRole("button", { name: `Workspace: ${SECOND_WORKSPACE_NAME}` })).toBeTruthy();
    expect(screen.queryByRole("button", { name: `Workspace: ${WORKSPACE_NAME}` })).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("the General page after a switch", () => {
  it("shows a skeleton and offers no rename until the new workspace's own document arrives", async () => {
    const held: Respond[] = [];
    let holding = false;
    const stub = stubWorkspaceSettingsServer({
      second: { aiEnabled: true },
      get: () => (holding ? new Promise<Response>((resolve) => held.push(resolve)) : undefined),
    });
    await open("/settings/workspace");
    expect((await screen.findByRole<HTMLInputElement>("textbox", { name: "Name" }, LOADED_WAIT)).value).toBe(WORKSPACE_NAME);

    holding = true;
    await switchTo(stub, SECOND_WORKSPACE_NAME);

    expect(await screen.findByRole("status", { name: "Loading" }, LOADED_WAIT)).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByDisplayValue(WORKSPACE_NAME)).toBeNull();

    // Nothing could be sent while the document of the new workspace was out. Both workspaces are at version 3, so a rename made from the previous
    // workspace's document would have been accepted by the new one.
    expect(stub.received("PATCH", WORKSPACE_PATH)).toEqual([]);

    await answer(held, () => json(workspaceBody(OTHER_WORKSPACE_ID, SECOND_WORKSPACE_NAME, 3)));
    expect((await screen.findByRole<HTMLInputElement>("textbox", { name: "Name" }, LOADED_WAIT)).value).toBe(SECOND_WORKSPACE_NAME);
  }, SLOW_TEST_TIMEOUT_MS);

  it("reads the new workspace's document when the first read, still out at the switch, is answered with the previous one", async () => {
    const held: Respond[] = [];
    const stub = stubWorkspaceSettingsServer({
      second: { aiEnabled: true },
      get: (call) => (call === 1 ? new Promise<Response>((resolve) => held.push(resolve)) : undefined),
    });
    await open("/settings/workspace");
    await waitFor(() => {
      expect(held.length).toBe(1);
    }, LOADED_WAIT);

    // The page has no document yet, so the read is the first one of its key and is still out when the session moves.
    await switchTo(stub, SECOND_WORKSPACE_NAME);
    await answer(held, () => json(workspaceBody(WORKSPACE_ID, WORKSPACE_NAME, 3)));

    expect((await screen.findByRole<HTMLInputElement>("textbox", { name: "Name" }, LOADED_WAIT)).value).toBe(SECOND_WORKSPACE_NAME);
    expect(stub.received("GET", WORKSPACE_PATH).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByDisplayValue(WORKSPACE_NAME)).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows an error, not the previous workspace, when the new workspace's document cannot be read", async () => {
    let holding = false;
    const stub = stubWorkspaceSettingsServer({
      second: { aiEnabled: true },
      get: () => (holding ? json({ type: "x", title: "x", status: 503, code: "unavailable", detail: "x", requestId: "req-503" }, { status: 503, contentType: "application/problem+json" }) : undefined),
    });
    await open("/settings/workspace");
    await screen.findByRole("textbox", { name: "Name" }, LOADED_WAIT);

    holding = true;
    await switchTo(stub, SECOND_WORKSPACE_NAME);

    expect(await screen.findByText("The workspace could not be loaded", undefined, { timeout: 20_000 })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
    expect(screen.queryByDisplayValue(WORKSPACE_NAME)).toBeNull();
  }, 60_000);
});

const CALM = "2026-10-18T09:30:00.000Z";

/** Serves the entitlements, which the invitations and the teams are behind; everything else the page asks for is the server's. */
function entitlementsOnly(request: Request): Promise<Response> {
  return Promise.resolve(new URL(request.url).pathname === ENTITLEMENTS_PATH ? json(entitlementsBody(true)) : json({}, { status: 500 }));
}

function hold(held: Respond[]): Promise<Response> {
  return new Promise<Response>((resolve) => held.push(resolve));
}

describe("the Members page after a switch", () => {
  it("shows a skeleton and offers no row action until the new workspace's own list arrives", async () => {
    const held: Respond[] = [];
    let holding = false;
    // Grace Hopper is a member of both workspaces, so a change made from the previous workspace's list would be accepted by the new one.
    const stub = stubWorkspaceSettingsServer({
      second: { aiEnabled: true },
      other: entitlementsOnly,
      membersGet: () => (holding ? hold(held) : undefined),
    });
    await open("/settings/workspace/members");
    expect(await screen.findByRole("combobox", { name: "Role of Grace Hopper" }, LOADED_WAIT)).toBeTruthy();
    await settleAccountReads(stub);

    holding = true;
    await switchTo(stub, SECOND_WORKSPACE_NAME);
    await waitFor(() => {
      expect(held.length).toBeGreaterThan(0);
    }, LOADED_WAIT);

    // The page is on the new workspace's document, so what is left to wait for is the list.
    expect(await screen.findByRole("heading", { name: "Members" }, LOADED_WAIT)).toBeTruthy();
    expect(await screen.findByRole("status", { name: "Loading" }, LOADED_WAIT)).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Members" })).toBeNull();
    expect(screen.queryByText("Grace Hopper")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Role of Grace Hopper" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Actions for Grace Hopper" })).toBeNull();
    // No row action of the previous workspace's list could be taken, so nothing was sent to the account that both workspaces have.
    expect(stub.received("PATCH", `${MEMBERS_PATH}/${GRACE.accountId}`)).toEqual([]);
    expect(stub.received("DELETE", `${MEMBERS_PATH}/${GRACE.accountId}`)).toEqual([]);

    await answer(held, () => json({ items: [{ ...SELF, lastActiveAt: CALM }, GRACE], nextCursor: null }));
    expect(await screen.findByRole("combobox", { name: "Role of Grace Hopper" }, LOADED_WAIT)).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading" })).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows the invitations of the new workspace only, from a skeleton", async () => {
    const held: Respond[] = [];
    let holding = false;
    const invited = {
      id: "0192f3a0-dddd-7000-8000-000000000001",
      email: "linus@example.org",
      role: "member" as const,
      invitedBy: SELF.accountId,
      expiresAt: "2026-12-01T10:00:00.000Z",
    };
    const stub = stubWorkspaceSettingsServer({
      second: { aiEnabled: true },
      invitations: [invited],
      other: entitlementsOnly,
      invitationsGet: () => (holding ? hold(held) : undefined),
    });
    await open("/settings/workspace/members");
    expect(await screen.findByText("linus@example.org", undefined, LOADED_WAIT)).toBeTruthy();
    await settleAccountReads(stub);

    holding = true;
    await switchTo(stub, SECOND_WORKSPACE_NAME);
    await waitFor(() => {
      expect(held.length).toBeGreaterThan(0);
    }, LOADED_WAIT);

    expect(await screen.findByRole("status", { name: "Loading invitations" }, LOADED_WAIT)).toBeTruthy();
    expect(screen.queryByText("linus@example.org")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Actions for the invitation of / })).toBeNull();
    expect(stub.received("DELETE", `${INVITATIONS_PATH}/${invited.id}`)).toEqual([]);

    await answer(held, () => json({ items: [], nextCursor: null }));
    expect(await screen.findByText("No pending invitations", undefined, LOADED_WAIT)).toBeTruthy();
    expect(screen.queryByText("linus@example.org")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("the Teams page after a switch", () => {
  it("shows a skeleton and offers no row action until the new workspace's own list arrives", async () => {
    const held: Respond[] = [];
    const team = (id: string, name: string) => ({
      id,
      name,
      description: "",
      memberCount: 0,
      version: 1,
      createdAt: "2026-09-01T08:00:00.000Z",
      updatedAt: "2026-09-01T08:00:00.000Z",
    });
    const stub = stubWorkspaceSettingsServer({
      second: { aiEnabled: true },
      other: (request) => {
        const { pathname } = new URL(request.url);
        if (pathname.startsWith("/api/v1/teams/")) {
          return Promise.resolve(json({ ...team(pathname.split("/")[4] ?? "", "Platform"), members: [] }));
        }
        return entitlementsOnly(request);
      },
      teamsGet: (_call, workspaceId) =>
        workspaceId === WORKSPACE_ID ? Promise.resolve(json({ items: [team("0192f3a0-ffff-7000-8000-000000000001", "Platform")], nextCursor: null })) : hold(held),
    });
    await open("/settings/workspace/teams");
    expect(await screen.findByRole("button", { name: "Actions for the team Platform" }, LOADED_WAIT)).toBeTruthy();
    await settleAccountReads(stub);

    await switchTo(stub, SECOND_WORKSPACE_NAME);
    await waitFor(() => {
      expect(held.length).toBeGreaterThan(0);
    }, LOADED_WAIT);

    expect(await screen.findByRole("status", { name: "Loading teams" }, LOADED_WAIT)).toBeTruthy();
    expect(screen.queryByText("Platform")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Actions for the team / })).toBeNull();

    await answer(held, () => json({ items: [team("0192f3a0-ffff-7000-8000-000000000002", "Design")], nextCursor: null }));
    expect(await screen.findByText("Design", undefined, LOADED_WAIT)).toBeTruthy();
    expect(screen.queryByText("Platform")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("the entitlements across switches", () => {
  it("gives each workspace its own entitlements on the way from the first to the second and back", async () => {
    const held: Respond[] = [];
    let holding = false;
    // The server answers for the workspace the session acts in when the request arrives, whichever key the client asked under.
    const stub: Stub = stubWorkspaceSettingsServer({
      ai: { provider: "Example AI" },
      second: { aiEnabled: true },
      other: (request) => {
        if (new URL(request.url).pathname !== ENTITLEMENTS_PATH) {
          throw new Error(`unexpected call ${request.method} ${request.url}`);
        }
        const puts = stub.received("PUT", ACTIVE_WORKSPACE_PATH);
        const active = (puts.at(-1)?.body as { workspaceId: string } | undefined)?.workspaceId ?? WORKSPACE_ID;
        const response = () => json(entitlementsBody(active === WORKSPACE_ID));
        return holding ? new Promise<Response>((resolve) => held.push(() => {
                resolve(response());
              })) : Promise.resolve(response());
      },
    });
    await open("/settings/workspace/ai", [UPGRADE]);
    expect(await screen.findByRole("switch", { name: AI_SWITCH }, LOADED_WAIT)).toBeTruthy();
    expect(screen.queryByText("Upgrade plan")).toBeNull();

    holding = true;
    await switchTo(stub, SECOND_WORKSPACE_NAME);
    await answer(held, () => json({}));
    expect(await screen.findByText("Upgrade plan", undefined, LOADED_WAIT)).toBeTruthy();
    expect(screen.queryByRole("switch", { name: AI_SWITCH })).toBeNull();

    // Back in the first workspace the reads stay out, so what the page shows is what the cache holds for it.
    await switchTo(stub, WORKSPACE_NAME);
    expect(await screen.findByRole("switch", { name: AI_SWITCH }, LOADED_WAIT)).toBeTruthy();
    expect(screen.queryByText("Upgrade plan")).toBeNull();

    await answer(held, () => json({}));
    await settleAccountReads(stub);
    expect(screen.getByRole("switch", { name: AI_SWITCH })).toBeTruthy();
    expect(screen.queryByText("Upgrade plan")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("a switch while a write is out", () => {
  const SAVING = "A change is still being saved. Try again in a moment.";

  async function toggleAi(): Promise<void> {
    await act(async () => {
      fireEvent.click(await screen.findByRole("switch", { name: AI_SWITCH }, LOADED_WAIT));
      await Promise.resolve();
    });
  }

  it("sends nothing and says why, then switches once the save has answered", async () => {
    let answerSave: Respond = () => undefined;
    const stub = stubWorkspaceSettingsServer({
      ai: { provider: "Example AI" },
      second: { aiEnabled: true },
      settingsPatch: () =>
        new Promise<Response>((resolve) => {
          answerSave = resolve;
        }),
      other: (request) => Promise.resolve(new URL(request.url).pathname === ENTITLEMENTS_PATH ? json(entitlementsBody(true)) : json({}, { status: 500 })),
    });
    await open("/settings/workspace/ai");
    await toggleAi();
    await waitFor(() => {
      expect(stub.received("PATCH", WORKSPACE_SETTINGS_PATH)).toHaveLength(1);
    }, LOADED_WAIT);

    await choose(stub, SECOND_WORKSPACE_NAME);

    expect((await screen.findAllByText(SAVING, undefined, LOADED_WAIT)).length).toBeGreaterThan(0);
    expect(stub.received("PUT", ACTIVE_WORKSPACE_PATH)).toEqual([]);
    expect(screen.getByRole("button", { name: `Workspace: ${WORKSPACE_NAME}` })).toBeTruthy();

    await answer([answerSave], () => json({ aiEnabled: false }));
    await waitFor(() => {
      expect(screen.getByRole("switch", { name: AI_SWITCH }).getAttribute("aria-checked")).toBe("false");
    }, LOADED_WAIT);
    await switchTo(stub, SECOND_WORKSPACE_NAME);

    expect(stub.received("PUT", ACTIVE_WORKSPACE_PATH).map(({ body }) => body)).toEqual([{ workspaceId: OTHER_WORKSPACE_ID }]);
    // The save landed in the workspace it was made in.
    expect(stub.received("PATCH", WORKSPACE_SETTINGS_PATH)).toHaveLength(1);
  }, SLOW_TEST_TIMEOUT_MS);

  it("keeps the new workspace's document when a rename that was out past the bound is answered after the switch", async () => {
    const held: Respond[] = [];
    const stub = stubWorkspaceSettingsServer({
      second: { aiEnabled: true },
      patch: () => new Promise<Response>((resolve) => held.push(resolve)),
    });
    await open("/settings/workspace");
    const name = await screen.findByRole<HTMLInputElement>("textbox", { name: "Name" }, LOADED_WAIT);
    await settleAccountReads(stub);
    await act(async () => {
      fireEvent.change(name, { target: { value: "Renamed Workspace" } });
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(held.length).toBe(1);
    }, LOADED_WAIT);

    // The rename has been out longer than a write holds a switch back, so the switch goes through.
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + SWITCH_WRITE_WAIT_MS + 1000);
    await switchTo(stub, SECOND_WORKSPACE_NAME);
    expect((await screen.findByRole<HTMLInputElement>("textbox", { name: "Name" }, LOADED_WAIT)).value).toBe(SECOND_WORKSPACE_NAME);

    await answer(held, () => json(workspaceBody(WORKSPACE_ID, "Renamed Workspace", 4)));
    await settleAccountReads(stub);

    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Name" }).value).toBe(SECOND_WORKSPACE_NAME);
    expect(screen.queryByRole("status", { name: "Loading" })).toBeNull();
    expect(screen.queryByDisplayValue("Renamed Workspace")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("does not stay locked by a save that never answers", async () => {
    const stub = stubWorkspaceSettingsServer({
      ai: { provider: "Example AI" },
      second: { aiEnabled: true },
      settingsPatch: () => new Promise<Response>(() => undefined),
      other: (request) => Promise.resolve(new URL(request.url).pathname === ENTITLEMENTS_PATH ? json(entitlementsBody(true)) : json({}, { status: 500 })),
    });
    await open("/settings/workspace/ai");
    await toggleAi();
    await waitFor(() => {
      expect(stub.received("PATCH", WORKSPACE_SETTINGS_PATH)).toHaveLength(1);
    }, LOADED_WAIT);

    await choose(stub, SECOND_WORKSPACE_NAME);
    expect((await screen.findAllByText(SAVING, undefined, LOADED_WAIT)).length).toBeGreaterThan(0);
    expect(stub.received("PUT", ACTIVE_WORKSPACE_PATH)).toEqual([]);

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + SWITCH_WRITE_WAIT_MS + 1000);
    await switchTo(stub, SECOND_WORKSPACE_NAME);

    expect(stub.received("PUT", ACTIVE_WORKSPACE_PATH).map(({ body }) => body)).toEqual([{ workspaceId: OTHER_WORKSPACE_ID }]);
  }, SLOW_TEST_TIMEOUT_MS);
});
