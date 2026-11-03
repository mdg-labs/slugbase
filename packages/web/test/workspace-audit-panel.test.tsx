import type { ComponentTypes } from "@slugbase/contracts";
import { createHandlers, createResolverHandlers } from "@slugbase/testing/msw";
import { createMockServer, readOpenApiDocument } from "@slugbase/testing/msw/node";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp } from "../src/index.ts";
import { ACCOUNT_BODY, WORKSPACE_ID, allowSlowRender, json, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The event panel of /settings/workspace/audit (doc 03 sections 11.9 and 15), through the page and the app's own API client. The failure scenarios are an
// event's text built into markup or into a link to a member's content, a panel that opens without taking focus or closes without giving it back, an
// event without a target or details shown as an empty block, and an account deleted since shown as a live one.

type AuditEvent = ComponentTypes["schemas"]["AuditEvent"];

const server = createMockServer();
const document_ = readOpenApiDocument();

const ADA = ACCOUNT_BODY.id;
const GRACE = "0192f3a0-bbbb-7000-8000-000000000002";
const TEAM = "0192f3a0-ffff-7000-8000-000000000001";
const BOOKMARK = "0192f3a0-aaaa-7000-8000-000000000001";
const STAMP = "2026-10-01T08:00:00.000Z";
const AT = "2026-10-01T08:15:42.000Z";

function event(n: number, overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: `0192f3a0-eeee-7000-8000-${String(n).padStart(12, "0")}`,
    createdAt: AT,
    actor: { type: "account", accountId: ADA, label: "Ada Lovelace" },
    action: "team.created",
    category: "team",
    entity: { type: "team", id: TEAM },
    metadata: { name: "Platform" },
    ...overrides,
  };
}

let events: AuditEvent[] = [];

function serve(): void {
  server.use(
    ...createResolverHandlers(document_, {
      getMe: () =>
        json({
          account: { ...ACCOUNT_BODY, locale: globalThis.navigator.languages.some((language) => language.startsWith("de")) ? "de" : "en" },
          memberships: [{ workspaceId: WORKSPACE_ID, name: "Ada's Workspace", role: "owner" }],
          activeWorkspaceId: WORKSPACE_ID,
        }),
      getWorkspace: () => json({ id: WORKSPACE_ID, name: "Ada's Workspace", role: "owner", memberCount: 2, createdAt: STAMP, version: 1 }, { headers: { ETag: '"1"' } }),
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
            "audit.log": true,
          },
          usage: { "bookmarks.used": 0, "seats.used": 2, "workspaces.owned": 1 },
          upgradeAvailable: true,
        }),
      listAuditEvents: () => json({ items: events, nextCursor: null }),
    }),
    ...createHandlers(document_, {
      scenario: {
        name: "audit-panel",
        fixtures: { listWorkspaces: { items: [{ id: WORKSPACE_ID, name: "Ada's Workspace", role: "owner", memberCount: 2 }], canCreate: false } },
      },
    }),
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
  events = [];
  stubBrowserApis();
  stubMatchMedia(false);
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("lang");
});

async function openTable(): Promise<HTMLElement> {
  serve();
  window.history.replaceState(null, "", "/settings/workspace/audit");
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
  return screen.findByRole("table", { name: /Audit/ });
}

async function act_(run: () => void): Promise<void> {
  await act(async () => {
    run();
    await Promise.resolve();
  });
}

/** Opens the panel the way the keyboard does: focus on the button, then the click that Enter makes of it. */
async function openPanel(name: string, index = 0): Promise<{ button: HTMLElement; panel: HTMLElement }> {
  const button = screen.getAllByRole("button", { name })[index];
  if (button === undefined) {
    throw new Error(`no button ${name}`);
  }
  button.focus();
  await act_(() => {
    fireEvent.click(button);
  });
  return { button, panel: await screen.findByRole("dialog") };
}

async function noViolations(): Promise<void> {
  const results = await axe(document.body, { rules: { region: { enabled: false } } });
  expect(results.violations.map(({ id }) => id)).toEqual([]);
}

function termsOf(scope: HTMLElement): Record<string, string | null> {
  const found: Record<string, string | null> = {};
  for (const term of scope.querySelectorAll("dt")) {
    found[term.textContent] = term.nextElementSibling?.textContent ?? null;
  }
  return found;
}

describe("the event panel", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("opens from the action button, named by the action, with focus inside, and shows time, actor, action, category, target and details", async () => {
    events = [event(1, { action: "workspace.renamed", category: "workspace", entity: { type: "workspace", id: WORKSPACE_ID }, metadata: { from: "Old", to: "New name" } })];
    await openTable();
    expect(screen.queryByRole("dialog")).toBeNull();

    const { panel } = await openPanel("Workspace renamed");

    expect(within(panel).getByRole("heading", { name: "Workspace renamed" })).toBeTruthy();
    expect(panel.getAttribute("aria-labelledby")).not.toBeNull();
    expect(panel.contains(document.activeElement)).toBe(true);
    const time = panel.querySelector("time");
    expect(time?.getAttribute("datetime")).toBe(AT);
    expect(time?.textContent).toMatch(/2026/);
    expect(time?.textContent).toMatch(/:42/);
    expect(time?.textContent).toMatch(/[A-Z]{3,5}|GMT|UTC/);
    const fields = termsOf(panel);
    expect(fields["Actor"]).toContain("Ada Lovelace");
    expect(fields["Action"]).toBe("Workspace renamed");
    expect(fields["Category"]).toBe("Workspace");
    expect(fields["Target"]).toContain("Workspace");
    const id = within(panel).getByRole<HTMLInputElement>("textbox", { name: "Identifier of the target" });
    expect(id.value).toBe(WORKSPACE_ID);
    expect(id.readOnly).toBe(true);
    expect(id.closest("[class*='font-mono']")).not.toBeNull();
    expect(within(panel).getByRole("button", { name: "Copy the identifier" })).toBeTruthy();
    expect(fields["From"]).toBe("Old");
    expect(fields["To"]).toBe("New name");
    expect(within(panel).queryByText("This event recorded no further details.")).toBeNull();
  });

  it("closes with Escape and gives focus back to the button that opened it", async () => {
    events = [event(1), event(2)];
    await openTable();
    const { button, panel } = await openPanel("Team created", 1);

    await act_(() => {
      fireEvent.keyDown(panel, { key: "Escape" });
    });

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(document.activeElement).toBe(button);
  });

  it("closes with the close button and gives focus back", async () => {
    events = [event(1)];
    await openTable();
    const { button, panel } = await openPanel("Team created");

    await act_(() => {
      fireEvent.click(within(panel).getByRole("button", { name: "Close the event details" }));
    });

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(document.activeElement).toBe(button);
  });

  it("closes with the backdrop and gives focus back", async () => {
    events = [event(1)];
    await openTable();
    const { button } = await openPanel("Team created");
    const backdrop = document.querySelector<HTMLElement>("[data-slot='sheet-backdrop']");
    expect(backdrop).not.toBeNull();

    await act_(() => {
      fireEvent.pointerDown(backdrop as HTMLElement);
      fireEvent.pointerUp(backdrop as HTMLElement);
      fireEvent.click(backdrop as HTMLElement);
    });

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(document.activeElement).toBe(button);
  });

  it("opens the event of the button pressed and shows another's when another is pressed", async () => {
    events = [event(1, { metadata: { name: "First team" } }), event(2, { metadata: { name: "Second team" } })];
    await openTable();

    const { panel } = await openPanel("Team created", 1);
    expect(within(panel).getByText("Second team")).toBeTruthy();
    expect(within(panel).queryByText("First team")).toBeNull();
  });

  it("names a deleted account's event, and the system and an API token as what they are", async () => {
    events = [
      event(1, { actor: { type: "account", accountId: null, label: "Grace Hopper" } }),
      event(2, { actor: { type: "system", accountId: null, label: "SlugBase" } }),
      event(3, { actor: { type: "api_token", accountId: ADA, label: "CI token" } }),
    ];
    await openTable();

    const deleted = await openPanel("Team created", 0);
    expect(termsOf(deleted.panel)["Actor"]).toContain("Grace Hopper");
    expect(within(deleted.panel).getByText("deleted account")).toBeTruthy();
    await act_(() => {
      fireEvent.keyDown(deleted.panel, { key: "Escape" });
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    const system = await openPanel("Team created", 1);
    expect(within(system.panel).getByText("System")).toBeTruthy();
    expect(within(system.panel).queryByText("deleted account")).toBeNull();
    await act_(() => {
      fireEvent.keyDown(system.panel, { key: "Escape" });
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    const token = await openPanel("Team created", 2);
    expect(within(token.panel).getByText("API token")).toBeTruthy();
    expect(within(token.panel).queryByText("deleted account")).toBeNull();
  });

  it("says so where an event has no target and no details, instead of showing empty blocks", async () => {
    events = [event(1, { action: "workspace.deletion_requested", category: "workspace", entity: null, metadata: {} })];
    await openTable();

    const { panel } = await openPanel("Workspace deletion requested");

    expect(termsOf(panel)["Target"]).toBe("No target");
    expect(within(panel).queryByRole("textbox")).toBeNull();
    expect(within(panel).getByText("This event recorded no further details.")).toBeTruthy();
    expect(within(within(panel).getByRole("region", { name: "Details" })).queryByRole("term")).toBeNull();
    await noViolations();
  });

  it("shows the recorded key where the catalog does not know a metadata field, and the recorded name of an action it no longer holds", async () => {
    events = [event(1, { action: "retired.thing", category: null, metadata: { newField: "x", count: "12", constructor: "y" } })];
    await openTable();

    const { panel } = await openPanel("retired.thing");

    expect(within(panel).getByRole("heading", { name: "retired.thing" })).toBeTruthy();
    const fields = termsOf(panel);
    expect(fields["newField"]).toBe("x");
    expect(fields["Count"]).toBe("12");
    expect(fields["constructor"]).toBe("y");
    expect(fields["Category"]).toBe("Other");
  });

  it("renders every metadata field of an import and a share under its own term, a field the row lost as absent", async () => {
    events = [
      event(1, {
        action: "share.granted",
        category: "share",
        entity: { type: "bookmark", id: BOOKMARK },
        metadata: { targetKind: "member", targetName: "Grace Hopper" },
      }),
    ];
    await openTable();

    const { panel } = await openPanel("Share granted");

    const fields = termsOf(panel);
    expect(fields["Shared with (kind)"]).toBe("member");
    expect(fields["Shared with (name)"]).toBe("Grace Hopper");
    expect(fields["Shared with (identifier)"]).toBeUndefined();
  });

  it("renders hostile text as characters and links to nothing", async () => {
    const script = "<script>alert(1)</script>";
    const image = "<img src=x onerror=alert(1)>";
    const link = '<a href="javascript:alert(1)">x</a>';
    events = [
      event(1, {
        action: "share.granted",
        category: "share",
        actor: { type: "account", accountId: ADA, label: image },
        entity: { type: "bookmark", id: BOOKMARK },
        metadata: { targetKind: "team", targetId: TEAM, targetName: script, [link]: link },
      }),
    ];
    await openTable();

    const { panel } = await openPanel("Share granted");

    expect(within(panel).getAllByText(script).length).toBeGreaterThanOrEqual(1);
    expect(within(panel).getAllByText(image).length).toBeGreaterThanOrEqual(1);
    expect(within(panel).getAllByText(link).length).toBeGreaterThanOrEqual(2);
    expect(panel.querySelector("script, img, a, iframe")).toBeNull();
    expect(within(panel).queryAllByRole("link")).toEqual([]);
    expect(document.querySelector("img[src='x']")).toBeNull();
    await noViolations();
  });

  it("has no accessibility violations with the panel open", async () => {
    events = [event(1, { action: "member.removed", category: "member", entity: { type: "member", id: GRACE }, metadata: { content: "delete" } })];
    await openTable();

    await openPanel("Member removed");

    await noViolations();
  });

  it("shows the panel in German", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-DE", "de"]);
    events = [event(1, { action: "member.removed", category: "member", actor: { type: "account", accountId: null, label: "Grace Hopper" }, entity: { type: "member", id: GRACE }, metadata: { content: "delete" } })];
    await openTable();

    const { panel } = await openPanel("Mitglied entfernt");

    expect(within(panel).getByRole("heading", { name: "Mitglied entfernt" })).toBeTruthy();
    const fields = termsOf(panel);
    expect(fields["Akteur"]).toContain("gelöschtes Konto");
    expect(fields["Kategorie"]).toBe("Mitglied");
    expect(fields["Inhalte"]).toBe("delete");
    expect(within(panel).getByRole("textbox", { name: "Kennung des Ziels" })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Ereignisdetails schließen" })).toBeTruthy();
    expect(within(panel).getByRole("region", { name: "Details" })).toBeTruthy();
    expect(panel.querySelector("time")?.textContent).toMatch(/^01\.10\.2026, /);
    await noViolations();
  });
});
