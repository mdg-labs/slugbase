import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { createWebApp } from "../src/index.ts";
import { problem, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";
import { GRACE, SELF, WORKSPACE_PATH, stubWorkspaceSettingsServer, type Role } from "./workspace-settings-server.ts";

// Deleting the workspace (doc 03 section 11.6, doc 04 section 4.4, doc 01 section 13.2). The failure scenarios are a deletion that
// is sent before the workspace's name was typed, one that is sent without the fresh re-authentication the server asks for or that
// is shown as done when the prompt was closed, a refusal of the deletion guard or another failure shown as a success, a control
// offered to somebody who is not an owner, and a deleted workspace the SPA stays in.

const SLOW_TEST_TIMEOUT_MS = 30_000;
const REAUTH_PATH = "/api/v1/me/reauth";
const NAME = "Ada's Workspace";

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

async function openGeneral(): Promise<HTMLElement> {
  window.history.replaceState(null, "", "/settings/workspace");
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
  const heading = await screen.findByRole("heading", { level: 2, name: "Danger zone" });
  return heading.closest("[data-slot=danger-zone]") as HTMLElement;
}

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

async function openDelete(): Promise<HTMLElement> {
  await press(await screen.findByRole("button", { name: "Delete workspace" }));
  return screen.findByRole("alertdialog", { name: `Delete ${NAME}?` });
}

async function type(dialog: HTMLElement, typed: string): Promise<void> {
  await act(async () => {
    fireEvent.change(within(dialog).getByRole("textbox", { name: `Type ${NAME} to confirm` }), { target: { value: typed } });
    await Promise.resolve();
  });
}

function submit(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByRole("button", { name: "Delete workspace" });
}

describe("the Delete workspace control", () => {
  it("is offered to an owner in the danger zone, next to Leave, and says what it costs", async () => {
    stubWorkspaceSettingsServer({ members: [SELF, GRACE] });
    const zone = await openGeneral();

    expect(within(zone).getByRole("button", { name: "Delete workspace" })).toBeTruthy();
    expect(within(zone).getByRole("button", { name: "Leave workspace" })).toBeTruthy();
    expect(within(zone).getByText("Deletes the workspace and everything in it for every member. This cannot be undone.")).toBeTruthy();
  }, SLOW_TEST_TIMEOUT_MS);

  it.each<Role>(["admin", "member"])("is not offered to a %s, who still sees Leave", async (role) => {
    const server = stubWorkspaceSettingsServer({ role, members: [{ ...SELF, role }, { ...GRACE, role: "owner" }] });
    const zone = await openGeneral();

    expect(within(zone).getByRole("button", { name: "Leave workspace" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete workspace" })).toBeNull();
    expect(server.received("DELETE", WORKSPACE_PATH)).toHaveLength(0);
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("the delete dialog", () => {
  it("states that the deletion is irreversible and sends nothing until the exact name is typed", async () => {
    const server = stubWorkspaceSettingsServer({ members: [SELF, GRACE] });
    await openGeneral();

    const dialog = await openDelete();

    expect(dialog.textContent).toContain("This is irreversible.");
    expect(dialog.textContent).toContain("removes every row of the workspace");
    expect(submit(dialog).hasAttribute("disabled")).toBe(true);
    await type(dialog, "ada's workspace");
    expect(submit(dialog).hasAttribute("disabled")).toBe(true);
    await type(dialog, "Ada's");
    expect(submit(dialog).hasAttribute("disabled")).toBe(true);
    await act(async () => {
      fireEvent.submit(within(dialog).getByRole("textbox").closest("form") ?? dialog);
      await Promise.resolve();
    });
    expect(server.received("DELETE", WORKSPACE_PATH)).toHaveLength(0);
    const results = await axe(document.body, { rules: { region: { enabled: false } } });
    expect(results.violations.map(({ id }) => id)).toEqual([]);

    await type(dialog, NAME);
    expect(submit(dialog).hasAttribute("disabled")).toBe(false);
  }, SLOW_TEST_TIMEOUT_MS);

  it("sends the deletion, says so and leaves the workspace for /no-workspace", async () => {
    const server = stubWorkspaceSettingsServer({ members: [SELF, GRACE], afterLeaving: "none" });
    await openGeneral();
    const dialog = await openDelete();

    await type(dialog, NAME);
    await press(submit(dialog));

    await waitFor(() => {
      expect(window.location.pathname).toBe("/no-workspace");
    });
    expect(server.received("DELETE", WORKSPACE_PATH)).toHaveLength(1);
    expect((await screen.findAllByText(`${NAME} is being deleted`)).length).toBeGreaterThan(0);
    expect(await screen.findByRole("heading", { name: "Waiting for an invitation" })).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("moves to the workspace the account is now in", async () => {
    stubWorkspaceSettingsServer({ members: [SELF, GRACE], afterLeaving: "other" });
    await openGeneral();
    const dialog = await openDelete();

    await type(dialog, NAME);
    await press(submit(dialog));

    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
    });
    expect(screen.queryByRole("heading", { name: "Danger zone" })).toBeNull();
    expect((await screen.findAllByText(`${NAME} is being deleted`)).length).toBeGreaterThan(0);
  }, SLOW_TEST_TIMEOUT_MS);

  it("opens the re-authentication prompt on reauth_required, and sends the deletion again once the password is confirmed", async () => {
    const server = stubWorkspaceSettingsServer({
      members: [SELF, GRACE],
      afterLeaving: "none",
      workspaceDelete: (call) => (call === 1 ? problem(401, "reauth_required", "req-reauth") : new Response(null, { status: 202 })),
      other: () => Promise.resolve(new Response(null, { status: 204 })),
    });
    await openGeneral();
    const dialog = await openDelete();
    await type(dialog, NAME);

    await press(submit(dialog));
    const prompt = await screen.findByRole("dialog", { name: "Confirm it is you" });
    expect(screen.queryByText(`${NAME} is being deleted`)).toBeNull();
    fireEvent.change(within(prompt).getByLabelText("Password"), { target: { value: "old password 1" } });
    await press(within(prompt).getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(window.location.pathname).toBe("/no-workspace");
    });
    expect(server.received("POST", REAUTH_PATH).map(({ body }) => body)).toEqual([{ password: "old password 1" }]);
    expect(server.received("DELETE", WORKSPACE_PATH)).toHaveLength(2);
  }, SLOW_TEST_TIMEOUT_MS);

  it("tells the owner nothing was sent when they close the re-authentication prompt, and keeps the dialog", async () => {
    const server = stubWorkspaceSettingsServer({ members: [SELF, GRACE], workspaceDelete: () => problem(401, "reauth_required", "req-reauth") });
    await openGeneral();
    const dialog = await openDelete();
    await type(dialog, NAME);

    await press(submit(dialog));
    const prompt = await screen.findByRole("dialog", { name: "Confirm it is you" });
    await press(within(prompt).getByRole("button", { name: "Cancel" }));

    expect(await within(dialog).findByText("Confirm it is you to delete the workspace.")).toBeTruthy();
    expect(screen.queryByText(`${NAME} is being deleted`)).toBeNull();
    expect(window.location.pathname).toBe("/settings/workspace");
    expect(server.received("DELETE", WORKSPACE_PATH)).toHaveLength(1);
    await waitFor(() => {
      expect(submit(dialog).hasAttribute("disabled")).toBe(false);
    });
  }, SLOW_TEST_TIMEOUT_MS);

  it("explains a refusal of the deletion guard in the dialog and offers nothing but closing it", async () => {
    const server = stubWorkspaceSettingsServer({ members: [SELF, GRACE], workspaceDelete: () => problem(409, "billing_active", "req-409") });
    await openGeneral();
    const dialog = await openDelete();
    await type(dialog, NAME);

    await press(submit(dialog));

    const blocked = await screen.findByRole("dialog", { name: `${NAME} cannot be deleted yet` });
    expect(blocked.textContent).toContain("This workspace has an active paid subscription. Cancel the subscription first, then delete the workspace.");
    expect(within(blocked).queryByRole("textbox")).toBeNull();
    expect(within(blocked).queryByRole("button", { name: "Delete workspace" })).toBeNull();
    expect(screen.queryByText(`${NAME} is being deleted`)).toBeNull();
    expect(window.location.pathname).toBe("/settings/workspace");
    expect(server.received("DELETE", WORKSPACE_PATH)).toHaveLength(1);

    await press(within(blocked).getAllByRole("button", { name: "Close" })[0] as HTMLElement);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: `${NAME} cannot be deleted yet` })).toBeNull();
    });
    expect(server.received("DELETE", WORKSPACE_PATH)).toHaveLength(1);
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows nothing extra when no guard refuses", async () => {
    stubWorkspaceSettingsServer({ members: [SELF, GRACE] });
    await openGeneral();
    const dialog = await openDelete();

    expect(within(dialog).queryByText(/subscription/)).toBeNull();
    expect(within(dialog).queryByRole("alert")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it.each([
    ["403", () => problem(403, "forbidden", "req-403"), "Only an owner can delete the workspace. The page has been reloaded."],
  ])("explains a refusal with %s, changes nothing and closes the dialog", async (_name, answer, message) => {
    stubWorkspaceSettingsServer({ members: [SELF, GRACE], workspaceDelete: answer });
    await openGeneral();
    const dialog = await openDelete();
    await type(dialog, NAME);

    await press(submit(dialog));

    expect((await screen.findAllByText(message)).length).toBeGreaterThan(0);
    expect(screen.queryByText(`${NAME} is being deleted`)).toBeNull();
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(window.location.pathname).toBe("/settings/workspace");
  }, SLOW_TEST_TIMEOUT_MS);

  it("reports another failure in an error toast, keeps the dialog and lets the owner try again", async () => {
    const server = stubWorkspaceSettingsServer({
      members: [SELF, GRACE],
      afterLeaving: "none",
      workspaceDelete: (call) => (call === 1 ? problem(503, "unavailable", "req-503") : new Response(null, { status: 202 })),
    });
    await openGeneral();
    const dialog = await openDelete();
    await type(dialog, NAME);

    await press(submit(dialog));

    expect((await screen.findAllByText("req-503", { exact: false })).length).toBeGreaterThan(0);
    expect(screen.queryByText(`${NAME} is being deleted`)).toBeNull();
    expect(window.location.pathname).toBe("/settings/workspace");
    await waitFor(() => {
      expect(submit(dialog).hasAttribute("disabled")).toBe(false);
    });
    await press(submit(dialog));
    await waitFor(() => {
      expect(window.location.pathname).toBe("/no-workspace");
    });
    expect(server.received("DELETE", WORKSPACE_PATH)).toHaveLength(2);
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows the wait on the button and does not send a second request", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = stubWorkspaceSettingsServer({
      members: [SELF, GRACE],
      afterLeaving: "none",
      workspaceDelete: async () => {
        await gate;
        return new Response(null, { status: 202 });
      },
    });
    await openGeneral();
    const dialog = await openDelete();
    await type(dialog, NAME);

    await press(submit(dialog));

    await waitFor(() => {
      expect(within(dialog).getByRole("button", { name: /^Delete workspace/ }).hasAttribute("data-loading")).toBe(true);
    });
    fireEvent.submit(within(dialog).getByRole("textbox").closest("form") ?? dialog);
    expect(server.received("DELETE", WORKSPACE_PATH)).toHaveLength(1);
    await act(async () => {
      release();
      await gate;
    });
    await waitFor(() => {
      expect(window.location.pathname).toBe("/no-workspace");
    });
  }, SLOW_TEST_TIMEOUT_MS);

  it("sends nothing when the owner cancels", async () => {
    const server = stubWorkspaceSettingsServer({ members: [SELF, GRACE] });
    await openGeneral();
    const dialog = await openDelete();
    await type(dialog, NAME);

    await press(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(server.received("DELETE", WORKSPACE_PATH)).toHaveLength(0);
  }, SLOW_TEST_TIMEOUT_MS);
});

