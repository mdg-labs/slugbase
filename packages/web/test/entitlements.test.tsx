import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Entitlements } from "../src/entitlements/index.ts";
import { isEntitlementRequired, isGranted, isWorkspaceLimitReached } from "../src/entitlements/index.ts";
import { ApiProblemError } from "../src/api/client.ts";
import type { WebExtension } from "../src/extensions/index.ts";
import { createWebApp } from "../src/index.ts";
import { json, problem, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";
import { HOME, TEAM, stubWorkspaceServer } from "./workspace-server.ts";
import { GRACE, INVITATIONS_PATH, SELF, stubWorkspaceSettingsServer, type TestInvitation } from "./workspace-settings-server.ts";

// The entitlement gates of the web app (doc 03 `entitlement-gate`, doc 01 section 7.2). The failure scenarios are a gate
// that hides a feature while the entitlements are still loading or could not be loaded, entitlements asked for again by
// every component that reads them, entitlements of one workspace read for another, a workspace limit shown as an error
// where the upgrade slot belongs, and a refused entitlement that leaves the member without an explanation.

const SLOW_TEST_TIMEOUT_MS = 30_000;
const ENTITLEMENTS_PATH = "/api/v1/entitlements";

function entitlementsBody(changes: { entitlements?: Partial<Entitlements["entitlements"]>; usage?: Partial<Entitlements["usage"]> } = {}): Entitlements {
  return {
    entitlements: {
      "bookmarks.max": "unlimited",
      "seats.max": "unlimited",
      "workspaces.ownMax": "unlimited",
      "ai.suggestions": true,
      "sharing.members": true,
      "sharing.teams": true,
      "members.invite": true,
      "teams.manage": true,
      "audit.log": true,
      ...changes.entitlements,
    },
    usage: { "bookmarks.used": 0, "seats.used": 2, "workspaces.owned": 1, ...changes.usage },
    upgradeAvailable: true,
  };
}

const UPGRADE: WebExtension = { id: "upgrade", slots: { "entitlement.upgradeAction": () => <a href="/settings/billing">Upgrade plan</a> } };

const PENDING: TestInvitation = {
  id: "0192f3a0-dddd-7000-8000-000000000001",
  email: "linus@example.org",
  role: "member",
  invitedBy: SELF.accountId,
  expiresAt: "2026-10-25T10:00:00.000Z",
};

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

async function mount(path: string, extensions: readonly WebExtension[] = []): Promise<void> {
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

function membersServer(entitlements: (request: Request, count: number) => Response | Promise<Response>, options: { mail?: boolean; invitationResend?: () => Response } = {}) {
  const counts = { entitlements: 0 };
  const stub = stubWorkspaceSettingsServer({
    members: [SELF, GRACE],
    invitations: [PENDING],
    ...options,
    other: async (request) => {
      if (new URL(request.url).pathname === ENTITLEMENTS_PATH) {
        counts.entitlements += 1;
        return entitlements(request, counts.entitlements);
      }
      throw new Error(`unexpected call ${request.method} ${request.url}`);
    },
  });
  return { ...stub, counts };
}

describe("the pure rules", () => {
  it("grant a feature until the entitlements say otherwise", () => {
    expect(isGranted(undefined, "members.invite")).toBe(true);
    expect(isGranted(entitlementsBody(), "members.invite")).toBe(true);
    expect(isGranted(entitlementsBody({ entitlements: { "members.invite": false } }), "members.invite")).toBe(false);
  });

  it("reach the workspace limit only where the account owns as many as it may", () => {
    expect(isWorkspaceLimitReached(undefined)).toBe(false);
    expect(isWorkspaceLimitReached(entitlementsBody())).toBe(false);
    expect(isWorkspaceLimitReached(entitlementsBody({ entitlements: { "workspaces.ownMax": 2 }, usage: { "workspaces.owned": 1 } }))).toBe(false);
    expect(isWorkspaceLimitReached(entitlementsBody({ entitlements: { "workspaces.ownMax": 2 }, usage: { "workspaces.owned": 2 } }))).toBe(true);
    expect(isWorkspaceLimitReached(entitlementsBody({ entitlements: { "workspaces.ownMax": 0 }, usage: { "workspaces.owned": 0 } }))).toBe(true);
  });

  it("recognise only the 403 entitlement_required problem", () => {
    const refused = (status: number, code: "entitlement_required" | "forbidden") => new ApiProblemError({ status, code, requestId: "r" });
    expect(isEntitlementRequired(refused(403, "entitlement_required"))).toBe(true);
    expect(isEntitlementRequired(refused(403, "forbidden"))).toBe(false);
    expect(isEntitlementRequired(new Error("entitlement_required"))).toBe(false);
  });
});

describe("the invitations behind members.invite", () => {
  it("shows the invitations where the workspace grants the entitlement", async () => {
    membersServer(() => json(entitlementsBody()));
    await mount("/settings/workspace/members", [UPGRADE]);

    expect(await screen.findByRole("table", { name: "Invitations" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Invite people" })).toBeTruthy();
    expect(screen.queryByText("Upgrade plan")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("replaces the Invite action and the pending invitations with the upgrade slot where it is not granted", async () => {
    const stub = membersServer(() => json(entitlementsBody({ entitlements: { "members.invite": false } })));
    await mount("/settings/workspace/members", [UPGRADE]);

    expect(await screen.findByText("Upgrade plan")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Invite people" })).toBeNull();
    });
    expect(screen.queryByRole("table", { name: "Invitations" })).toBeNull();
    expect(screen.getByRole("table", { name: "Members" })).toBeTruthy();
    expect(stub.received("GET", INVITATIONS_PATH).length).toBeLessThanOrEqual(1);
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows nothing in their place where no extension fills the slot", async () => {
    const stub = membersServer(() => json(entitlementsBody({ entitlements: { "members.invite": false } })));
    await mount("/settings/workspace/members");

    await waitFor(() => {
      expect(stub.counts.entitlements).toBe(1);
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Invite people" })).toBeNull();
    });
    expect(screen.queryByText("Upgrade plan")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Invitations" })).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("keeps the invitations while the entitlements load", async () => {
    let release: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    membersServer(async () => {
      await pending;
      return json(entitlementsBody({ entitlements: { "members.invite": false } }));
    }, {});
    await mount("/settings/workspace/members", [UPGRADE]);

    expect(await screen.findByRole("button", { name: "Invite people" })).toBeTruthy();
    expect(screen.queryByText("Upgrade plan")).toBeNull();
    await act(async () => {
      release();
      await pending;
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Invite people" })).toBeNull();
    });
    expect(screen.getByText("Upgrade plan")).toBeTruthy();
  }, SLOW_TEST_TIMEOUT_MS);

  it("keeps the invitations when the entitlements cannot be loaded", async () => {
    const stub = membersServer(() => problem(503, "unavailable", "req-503"));
    await mount("/settings/workspace/members", [UPGRADE]);

    await waitFor(() => {
      expect(stub.counts.entitlements).toBeGreaterThan(0);
    });
    expect(await screen.findByRole("table", { name: "Invitations" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Invite people" })).toBeTruthy();
    expect(screen.queryByText("Upgrade plan")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("asks for the entitlements once for the page and the sidebar together", async () => {
    const stub = membersServer(() => json(entitlementsBody()));
    await mount("/settings/workspace/members");

    await screen.findByRole("table", { name: "Invitations" });
    await screen.findByRole("button", { name: /^Workspace: / });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stub.counts.entitlements).toBe(1);
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("a refused entitlement", () => {
  it("shows a toast with the upgrade slot and reads the entitlements again", async () => {
    const stub = membersServer(() => json(entitlementsBody()), {
      mail: true,
      invitationResend: () => problem(403, "entitlement_required", "req-403"),
    });
    await mount("/settings/workspace/members", [UPGRADE]);
    const table = await screen.findByRole("table", { name: "Invitations" });
    await press(within(table).getByRole("button", { name: "Actions for the invitation of linus@example.org" }));

    await press(await screen.findByRole("menuitem", { name: "Resend" }));

    expect((await screen.findAllByText("Not available in this workspace")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("This workspace does not include that feature.").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Upgrade plan").length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(stub.counts.entitlements).toBe(2);
    });
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows that toast alone, without the generic one for a failed change", async () => {
    membersServer(() => json(entitlementsBody()), { mail: true, invitationResend: () => problem(403, "entitlement_required", "req-403") });
    await mount("/settings/workspace/members", [UPGRADE]);
    const table = await screen.findByRole("table", { name: "Invitations" });
    await press(within(table).getByRole("button", { name: "Actions for the invitation of linus@example.org" }));

    await press(await screen.findByRole("menuitem", { name: "Resend" }));

    expect((await screen.findAllByText("Not available in this workspace")).length).toBeGreaterThan(0);
    expect(screen.queryByText("The change was not saved")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows the toast without an upgrade action where no extension fills the slot", async () => {
    membersServer(() => json(entitlementsBody()), { mail: true, invitationResend: () => problem(403, "entitlement_required", "req-403") });
    await mount("/settings/workspace/members");
    const table = await screen.findByRole("table", { name: "Invitations" });
    await press(within(table).getByRole("button", { name: "Actions for the invitation of linus@example.org" }));

    await press(await screen.findByRole("menuitem", { name: "Resend" }));

    expect((await screen.findAllByText("Not available in this workspace")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Upgrade plan")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("the workspace limit", () => {
  const atLimit = () => json(entitlementsBody({ entitlements: { "workspaces.ownMax": 1 }, usage: { "workspaces.owned": 1 } }));

  async function openNew(): Promise<void> {
    await press(await screen.findByRole("button", { name: /^Workspace: / }));
    await screen.findByRole("menu");
    await press(await screen.findByRole("menuitem", { name: "New workspace" }));
  }

  it("shows the upgrade slot in place of the creation form at workspaces.ownMax", async () => {
    const server = stubWorkspaceServer({ canCreate: false, entitlements: atLimit });
    await mount("/", [UPGRADE]);

    await openNew();

    const dialog = await screen.findByRole("dialog", { name: "New workspace" });
    expect(within(dialog).getByText("Workspace limit reached")).toBeTruthy();
    expect(within(dialog).getByText("Upgrade plan")).toBeTruthy();
    expect(within(dialog).queryByRole("textbox", { name: "Name" })).toBeNull();
    expect(server.calls("POST", "/api/v1/workspaces")).toHaveLength(0);
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows the limit and nothing else where no extension fills the slot", async () => {
    stubWorkspaceServer({ canCreate: false, entitlements: atLimit });
    await mount("/");

    await openNew();

    const dialog = await screen.findByRole("dialog", { name: "New workspace" });
    expect(within(dialog).getByText("Workspace limit reached")).toBeTruthy();
    expect(within(dialog).queryByText("Upgrade plan")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("keeps the creation form below the limit", async () => {
    stubWorkspaceServer({ canCreate: true, entitlements: () => json(entitlementsBody({ entitlements: { "workspaces.ownMax": 3 }, usage: { "workspaces.owned": 1 } })) });
    await mount("/", [UPGRADE]);

    await openNew();

    const dialog = await screen.findByRole("dialog", { name: "New workspace" });
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toBeTruthy();
    expect(within(dialog).queryByText("Upgrade plan")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("offers no New workspace where creation is off and the limit is not the reason", async () => {
    stubWorkspaceServer({ canCreate: false, entitlements: () => json(entitlementsBody()) });
    await mount("/", [UPGRADE]);

    await press(await screen.findByRole("button", { name: /^Workspace: / }));
    const menu = await screen.findByRole("menu");

    await within(menu).findByRole("menuitemradio", { name: "Team" });
    expect(within(menu).queryByRole("menuitem", { name: "New workspace" })).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows the limit and the upgrade slot where the server refuses the creation at the limit", async () => {
    const server = stubWorkspaceServer({
      canCreate: true,
      entitlements: () => json(entitlementsBody({ entitlements: { "workspaces.ownMax": 3 }, usage: { "workspaces.owned": 1 } })),
      post: () => Promise.resolve(problem(422, "workspace_limit_reached", "req-limit")),
    });
    await mount("/", [UPGRADE]);
    await openNew();
    const dialog = await screen.findByRole("dialog", { name: "New workspace" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: "Studio" } });

    await press(within(dialog).getByRole("button", { name: "Create workspace" }));

    expect(await within(dialog).findByText("Workspace limit reached")).toBeTruthy();
    expect(within(dialog).getByText("Upgrade plan")).toBeTruthy();
    expect(within(dialog).queryByText("Use a name of 1 to 64 characters.")).toBeNull();
    expect(within(dialog).queryByRole("textbox", { name: "Name" })).toBeNull();
    await waitFor(() => {
      expect(server.calls("GET", ENTITLEMENTS_PATH)).toHaveLength(2);
    });
  }, SLOW_TEST_TIMEOUT_MS);

  it("still names the name as the problem for a refusal that is no limit", async () => {
    stubWorkspaceServer({
      canCreate: true,
      entitlements: () => json(entitlementsBody({ entitlements: { "workspaces.ownMax": 3 }, usage: { "workspaces.owned": 1 } })),
      post: () => Promise.resolve(problem(422, "validation_failed", "req-name")),
    });
    await mount("/", [UPGRADE]);
    await openNew();
    const dialog = await screen.findByRole("dialog", { name: "New workspace" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: "Studio" } });

    await press(within(dialog).getByRole("button", { name: "Create workspace" }));

    expect(await within(dialog).findByText("Use a name of 1 to 64 characters.")).toBeTruthy();
    expect(within(dialog).queryByText("Workspace limit reached")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("reads the entitlements again after switching, and not the other workspace's", async () => {
    const server = stubWorkspaceServer({
      canCreate: false,
      entitlements: (_request, count) => (count === 1 ? atLimit() : json(entitlementsBody())),
    });
    await mount("/");
    await press(await screen.findByRole("button", { name: `Workspace: ${HOME.name}` }));
    expect(await screen.findByRole("menuitem", { name: "New workspace" })).toBeTruthy();
    await press(await screen.findByRole("menuitemradio", { name: TEAM.name }));

    await screen.findByRole("button", { name: `Workspace: ${TEAM.name}` });
    await press(screen.getByRole("button", { name: `Workspace: ${TEAM.name}` }));
    const menu = await screen.findByRole("menu");

    await within(menu).findByRole("menuitemradio", { name: HOME.name });
    await waitFor(() => {
      expect(within(menu).queryByRole("menuitem", { name: "New workspace" })).toBeNull();
    });
    expect(server.calls("GET", ENTITLEMENTS_PATH).length).toBeGreaterThanOrEqual(2);
  }, SLOW_TEST_TIMEOUT_MS);
});
