import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { createWebApp } from "../src/index.ts";
import { ACCOUNT_BODY, ACTIVE_WORKSPACE_PATH, PRODUCT_NAME, WORKSPACES_PATH, problem, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";
import { HOME, LOGOUT_PATH, NEW_ID, stubWorkspaceServer } from "./workspace-server.ts";

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
  window.history.replaceState(null, "", "/no-workspace");
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("lang");
});

async function mountApp(): Promise<void> {
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
}

const noWorkspace = { workspaces: [], active: null } as const;

describe("/no-workspace where creating a workspace is off", () => {
  it("says the account is waiting for an invitation, with its email and a way to sign out, and offers no creation", async () => {
    stubWorkspaceServer({ ...noWorkspace, canCreate: false });
    await mountApp();

    expect(await screen.findByRole("heading", { level: 1, name: "Waiting for an invitation" })).toBeTruthy();
    expect(screen.getByText(`Signed in as ${ACCOUNT_BODY.email}`)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create a workspace" })).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("signs out and goes to the sign-in page", async () => {
    const server = stubWorkspaceServer({ ...noWorkspace });
    await mountApp();

    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(server.calls("POST", LOGOUT_PATH)).toHaveLength(1);
      expect(window.location.pathname).toBe("/login");
    });
  });

  it("is written in German for a German browser", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-AT"]);
    stubWorkspaceServer({ ...noWorkspace });
    await mountApp();

    expect(await screen.findByRole("heading", { level: 1, name: "Warten auf eine Einladung" })).toBeTruthy();
    expect(screen.getByText(`Angemeldet als ${ACCOUNT_BODY.email}`)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Abmelden" })).toBeTruthy();
  });

  it.each(["light", "dark"] as const)("has no axe violations in the %s theme", async (theme) => {
    stubWorkspaceServer({ ...noWorkspace });
    await mountApp();
    await screen.findByRole("heading", { level: 1, name: "Waiting for an invitation" });
    document.documentElement.classList.toggle("dark", theme === "dark");

    expect((await axe(document.body, { rules: { region: { enabled: false } } })).violations.map(({ id }) => id)).toEqual([]);
  });

  it("works at phone width", async () => {
    stubMatchMedia(true);
    window.innerWidth = 375;
    stubWorkspaceServer({ ...noWorkspace });
    await mountApp();

    expect(await screen.findByRole("heading", { level: 1, name: "Waiting for an invitation" })).toBeTruthy();
  });
});

describe("/no-workspace where an account can create a workspace", () => {
  async function openDialog(): Promise<HTMLElement> {
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Create a workspace" }));
      await Promise.resolve();
    });
    return screen.findByRole("dialog", { name: "New workspace" });
  }

  async function createNamed(dialog: HTMLElement, name: string): Promise<void> {
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: name } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Create workspace" }));
      await Promise.resolve();
    });
  }

  it("offers to create one and still shows the email and the sign-out", async () => {
    stubWorkspaceServer({ ...noWorkspace, canCreate: true });
    await mountApp();

    expect(await screen.findByRole("heading", { level: 1, name: "You are not in a workspace yet" })).toBeTruthy();
    expect(screen.queryByText("Waiting for an invitation")).toBeNull();
    expect(screen.getByText(`Signed in as ${ACCOUNT_BODY.email}`)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("creates the workspace, switches to it and opens the app in it", async () => {
    const server = stubWorkspaceServer({ ...noWorkspace, canCreate: true });
    await mountApp();

    await createNamed(await openDialog(), "First");

    expect(await screen.findByRole("heading", { level: 1, name: `Welcome to ${PRODUCT_NAME}` })).toBeTruthy();
    expect(window.location.pathname).toBe("/");
    expect(server.calls("POST", WORKSPACES_PATH).map((call) => call.body)).toEqual([{ name: "First" }]);
    expect(server.calls("PUT", ACTIVE_WORKSPACE_PATH).map((call) => call.body)).toEqual([{ workspaceId: NEW_ID }]);
    expect(await screen.findByRole("button", { name: "Workspace: First" })).toBeTruthy();
  });

  it("stays on the page and creates nothing twice when the creation fails", async () => {
    const server = stubWorkspaceServer({ ...noWorkspace, canCreate: true, post: () => Promise.resolve(problem(503, "unavailable", "req-post")) });
    await mountApp();

    await createNamed(await openDialog(), "First");

    expect(await screen.findByText("The workspace could not be created. Try again in a moment.")).toBeTruthy();
    expect(window.location.pathname).toBe("/no-workspace");
    expect(server.calls("PUT", ACTIVE_WORKSPACE_PATH)).toHaveLength(0);
  });

  it("does not open the app when the switch fails, and offers the new workspace to open once the dialog is dismissed", async () => {
    let attempt = 0;
    const server = stubWorkspaceServer({
      ...noWorkspace,
      canCreate: true,
      put: (request) => {
        attempt += 1;
        if (attempt === 1) {
          return Promise.resolve(problem(503, "unavailable", "req-put"));
        }
        return request.clone().json().then((body: { workspaceId: string }) => {
          server.activate(body.workspaceId);
          return new Response(null, { status: 204 });
        });
      },
    });
    await mountApp();

    await createNamed(await openDialog(), "First");

    expect(await screen.findByText("The new workspace was not opened")).toBeTruthy();
    expect(window.location.pathname).toBe("/no-workspace");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Not now" }));
      await Promise.resolve();
    });
    expect(await screen.findByRole("heading", { level: 1, name: "Choose a workspace" })).toBeTruthy();
    expect(screen.queryByText("Waiting for an invitation")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open First" }));
      await Promise.resolve();
    });

    expect(await screen.findByRole("heading", { level: 1, name: `Welcome to ${PRODUCT_NAME}` })).toBeTruthy();
    expect(window.location.pathname).toBe("/");
  });
});

describe("/no-workspace in the states of its requests", () => {
  it("shows a skeleton while the account's workspaces are on their way", async () => {
    stubWorkspaceServer({ ...noWorkspace, list: () => new Promise<Response>(() => undefined) });
    await mountApp();

    expect(await screen.findByRole("status", { name: "Loading" })).toBeTruthy();
    expect(screen.queryByText("Waiting for an invitation")).toBeNull();
  });

  it("says it could not be loaded instead of claiming a wait, and tries again on request", async () => {
    let failing = true;
    const server = stubWorkspaceServer({
      ...noWorkspace,
      list: () =>
        Promise.resolve(
          failing ? problem(400, "bad_request", "req-list") : new Response(JSON.stringify({ items: [], canCreate: true }), { headers: { "Content-Type": "application/json" } }),
        ),
    });
    await mountApp();

    expect(await screen.findByRole("heading", { level: 1, name: "Your account could not be loaded" })).toBeTruthy();
    expect(screen.queryByText("Waiting for an invitation")).toBeNull();
    failing = false;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await Promise.resolve();
    });

    expect(await screen.findByRole("heading", { level: 1, name: "You are not in a workspace yet" })).toBeTruthy();
    expect(server.calls("GET", WORKSPACES_PATH).length).toBeGreaterThan(1);
  });

  it("raises a toast and stays when opening a workspace of the account fails", async () => {
    stubWorkspaceServer({ workspaces: [HOME], active: null, put: () => Promise.resolve(problem(503, "unavailable", "req-put")) });
    await mountApp();

    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Open Home" }));
      await Promise.resolve();
    });

    expect((await screen.findAllByText("The workspace was not switched")).length).toBeGreaterThan(0);
    expect(window.location.pathname).toBe("/no-workspace");
  });
});

describe("the guards around /no-workspace", () => {
  it("sends an account that acts in a workspace to the app", async () => {
    stubWorkspaceServer();
    await mountApp();

    expect(await screen.findByRole("heading", { level: 1, name: `Welcome to ${PRODUCT_NAME}` })).toBeTruthy();
    expect(window.location.pathname).toBe("/");
  });
});
