import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { createWebApp } from "../src/index.ts";
import { ACCOUNT_BODY, ACTIVE_WORKSPACE_PATH, CONFIG_BODY, ME_PATH, SESSION_BODY, SESSION_PATH, WORKSPACES_PATH, WORKSPACE_ID, json, problem, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// Deleting the account (doc 03 section 11.1, doc 02 section 2.10). The failure scenarios are a deletion sent before the email was
// typed or before the member can see which workspaces go with the account, one sent without the fresh re-authentication the server
// asks for or shown as done when the prompt was closed, a refusal (last owner, last instance admin, deployment guard) or another
// failure shown as a success, and a deleted account whose cached answers the SPA keeps.

const SLOW_TEST_TIMEOUT_MS = 30_000;
const REAUTH_PATH = "/api/v1/me/reauth";
const WORKSPACE_PATH = "/api/v1/workspace";
const MEMBERS_PATH = "/api/v1/members";
const EMAIL = ACCOUNT_BODY.email;

const SOLO = { id: WORKSPACE_ID, name: "Ada's Workspace", role: "owner", memberCount: 1 };
const SHARED = { id: "0192f3a0-cccc-7000-8000-000000000002", name: "Team Analytical", role: "member", memberCount: 4 };
const BLOCKING = { id: "0192f3a0-cccc-7000-8000-000000000003", name: "Engine Room", role: "owner", memberCount: 3 };

type Listed = typeof SOLO | typeof SHARED | typeof BLOCKING;
type Answer = Response | Promise<Response>;

interface ServerOptions {
  readonly workspaces?: readonly Listed[];
  /** Answers `GET /workspaces` instead of the list; `call` counts from 1. */
  readonly list?: (call: number) => Answer;
  /** Answers `DELETE /me` instead of accepting it; `call` counts from 1. */
  readonly remove?: (call: number, request: Request) => Answer;
}

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

function stubServer(options: ServerOptions = {}) {
  let deleted = false;
  let active = WORKSPACE_ID;
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  const items = options.workspaces ?? [SOLO, SHARED];
  const fetch = vi.fn(async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/config") {
      return json(CONFIG_BODY);
    }
    const text = request.method === "GET" ? "" : await request.clone().text();
    calls.push({ method: request.method, path: pathname, body: text === "" ? undefined : (JSON.parse(text) as unknown) });
    const key = `${request.method} ${pathname}`;
    const call = (counts.get(key) ?? 0) + 1;
    counts.set(key, call);
    if (deleted && pathname !== "/api/v1/auth/login") {
      return problem(401, "unauthenticated", "req-gone");
    }
    if (pathname === SESSION_PATH) {
      return json(SESSION_BODY);
    }
    if (pathname === ME_PATH && request.method === "GET") {
      return json({
        account: ACCOUNT_BODY,
        memberships: items.map(({ id, name, role }) => ({ workspaceId: id, name, role })),
        activeWorkspaceId: active,
      });
    }
    if (pathname === ME_PATH && request.method === "DELETE") {
      const answer = options.remove === undefined ? new Response(null, { status: 204 }) : await options.remove(call, request);
      deleted = deleted || answer.ok;
      return answer;
    }
    if (pathname === WORKSPACES_PATH && request.method === "GET") {
      return options.list === undefined ? json({ items, canCreate: false }) : options.list(call);
    }
    if (pathname === ACTIVE_WORKSPACE_PATH && request.method === "PUT") {
      active = (JSON.parse(text) as { workspaceId: string }).workspaceId;
      return new Response(null, { status: 204 });
    }
    if (pathname === REAUTH_PATH) {
      return new Response(null, { status: 204 });
    }
    if (pathname === WORKSPACE_PATH) {
      const current = items.find(({ id }) => id === active) ?? SOLO;
      return json({ ...current, createdAt: "2026-09-01T08:00:00.000Z", version: 1 }, { headers: { ETag: '"1"' } });
    }
    if (pathname === MEMBERS_PATH) {
      return json({ items: [], nextCursor: null });
    }
    throw new Error(`unexpected call ${request.method} ${pathname}`);
  });
  vi.stubGlobal("fetch", fetch);
  return {
    received: (method: string, path: string): Call[] => calls.filter((call) => call.method === method && call.path === path),
  };
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

async function openProfile(): Promise<HTMLElement> {
  window.history.replaceState(null, "", "/settings/account");
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
  await press(await screen.findByRole("button", { name: "Delete account" }));
  return screen.findByRole("alertdialog", { name: "Delete your account?" });
}

async function type(dialog: HTMLElement, typed: string): Promise<void> {
  await act(async () => {
    fireEvent.change(within(dialog).getByRole("textbox", { name: `Type ${EMAIL} to confirm` }), { target: { value: typed } });
    await Promise.resolve();
  });
}

function submit(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByRole("button", { name: "Delete account" });
}

/** The dialog, opened with the list of workspaces loaded and the email typed. */
async function readyToConfirm(): Promise<HTMLElement> {
  await openProfile();
  const dialog = await openDelete();
  await within(dialog).findByText("Ada's Workspace");
  await type(dialog, EMAIL);
  await waitFor(() => {
    expect(submit(dialog).hasAttribute("disabled")).toBe(false);
  });
  return dialog;
}

describe("the Delete account control", () => {
  it("is in the danger zone of the profile and says what it costs", async () => {
    stubServer();
    const zone = await openProfile();

    expect(within(zone).getByRole("button", { name: "Delete account" })).toBeTruthy();
    expect(within(zone).getByText("Deletes your account and signs you out everywhere. This cannot be undone.")).toBeTruthy();
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("the delete dialog", () => {
  it("lists the workspaces that go with the account and asks for the exact email before anything is sent", async () => {
    const server = stubServer({ workspaces: [SOLO, SHARED, BLOCKING] });
    await openProfile();
    const dialog = await openDelete();

    const goes = await within(dialog).findByText("This workspace is deleted with your account, because you are its only member:");
    const list = goes.parentElement?.querySelector("ul") as HTMLElement;
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Ada's Workspace"]);
    expect(dialog.textContent).toContain("This is irreversible.");
    expect(submit(dialog).hasAttribute("disabled")).toBe(true);
    await type(dialog, "ADA@example.org");
    expect(submit(dialog).hasAttribute("disabled")).toBe(true);
    await type(dialog, "ada@");
    expect(submit(dialog).hasAttribute("disabled")).toBe(true);
    await act(async () => {
      fireEvent.submit(within(dialog).getByRole("textbox").closest("form") ?? dialog);
      await Promise.resolve();
    });
    expect(server.received("DELETE", ME_PATH)).toHaveLength(0);
    const results = await axe(document.body, { rules: { region: { enabled: false } } });
    expect(results.violations.map(({ id }) => id)).toEqual([]);

    await type(dialog, EMAIL);
    expect(submit(dialog).hasAttribute("disabled")).toBe(false);
  }, SLOW_TEST_TIMEOUT_MS);

  it("says so when no workspace goes with the account", async () => {
    stubServer({ workspaces: [SHARED] });
    await openProfile();
    const dialog = await openDelete();

    expect(await within(dialog).findByText("No workspace is deleted with your account.")).toBeTruthy();
    expect(within(dialog).queryByRole("list")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows that the workspaces are loading and keeps the confirmation disabled, although the email is typed, until they are in", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = stubServer({
      list: async () => {
        await gate;
        return json({ items: [SOLO, SHARED], canCreate: false });
      },
    });
    window.history.replaceState(null, "", "/settings/account");
    const App = createWebApp({ extensions: [] });
    await renderApp(<App />);
    await press(await screen.findByRole("button", { name: "Delete account" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete your account?" });
    await type(dialog, EMAIL);

    expect(within(dialog).getByRole("status")).toBeTruthy();
    expect(within(dialog).queryByText("Ada's Workspace")).toBeNull();
    expect(submit(dialog).hasAttribute("disabled")).toBe(true);
    await act(async () => {
      fireEvent.submit(within(dialog).getByRole("textbox").closest("form") ?? dialog);
      await Promise.resolve();
    });
    expect(server.received("DELETE", ME_PATH)).toHaveLength(0);

    await act(async () => {
      release();
      await gate;
    });
    await within(dialog).findByText("Ada's Workspace");
    await waitFor(() => {
      expect(submit(dialog).hasAttribute("disabled")).toBe(false);
    });
  }, SLOW_TEST_TIMEOUT_MS);

  it("says the workspaces could not be loaded, keeps the confirmation disabled and lets the member try again", async () => {
    const server = stubServer({ list: (call) => (call === 1 ? json({ items: [SOLO], canCreate: false }) : call === 2 ? problem(429, "rate_limited", "req-429") : json({ items: [SOLO], canCreate: false })) });
    await openProfile();
    const dialog = await openDelete();
    await type(dialog, EMAIL);

    expect(await within(dialog).findByText("The workspaces could not be loaded")).toBeTruthy();
    expect(submit(dialog).hasAttribute("disabled")).toBe(true);
    expect(server.received("DELETE", ME_PATH)).toHaveLength(0);

    await press(within(dialog).getByRole("button", { name: "Try again" }));
    await within(dialog).findByText("Ada's Workspace");
    await waitFor(() => {
      expect(submit(dialog).hasAttribute("disabled")).toBe(false);
    });
  }, SLOW_TEST_TIMEOUT_MS);

  it("sends the email, says so, drops the cache and shows /login", async () => {
    const server = stubServer();
    const dialog = await readyToConfirm();

    await press(submit(dialog));

    await waitFor(() => {
      expect(window.location.pathname).toBe("/login");
    });
    expect(server.received("DELETE", ME_PATH).map(({ body }) => body)).toEqual([{ email: EMAIL }]);
    expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeTruthy();
    expect((await screen.findAllByText("Your account was deleted")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Danger zone" })).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("opens the re-authentication prompt on reauth_required, and sends the deletion again once the password is confirmed", async () => {
    const server = stubServer({ remove: (call) => (call === 1 ? problem(401, "reauth_required", "req-reauth") : new Response(null, { status: 204 })) });
    const dialog = await readyToConfirm();

    await press(submit(dialog));
    const prompt = await screen.findByRole("dialog", { name: "Confirm it is you" });
    expect(screen.queryByText("Your account was deleted")).toBeNull();
    fireEvent.change(within(prompt).getByLabelText("Password"), { target: { value: "old password 1" } });
    await press(within(prompt).getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(window.location.pathname).toBe("/login");
    });
    expect(server.received("POST", REAUTH_PATH).map(({ body }) => body)).toEqual([{ password: "old password 1" }]);
    expect(server.received("DELETE", ME_PATH).map(({ body }) => body)).toEqual([{ email: EMAIL }, { email: EMAIL }]);
  }, SLOW_TEST_TIMEOUT_MS);

  it("tells the member nothing was sent when they close the re-authentication prompt, and keeps the dialog", async () => {
    const server = stubServer({ remove: () => problem(401, "reauth_required", "req-reauth") });
    const dialog = await readyToConfirm();

    await press(submit(dialog));
    const prompt = await screen.findByRole("dialog", { name: "Confirm it is you" });
    await press(within(prompt).getByRole("button", { name: "Cancel" }));

    expect(await within(dialog).findByText("Confirm it is you to delete your account.")).toBeTruthy();
    expect(screen.queryByText("Your account was deleted")).toBeNull();
    expect(window.location.pathname).toBe("/settings/account");
    expect(server.received("DELETE", ME_PATH)).toHaveLength(1);
    await waitFor(() => {
      expect(submit(dialog).hasAttribute("disabled")).toBe(false);
    });
  }, SLOW_TEST_TIMEOUT_MS);

  it("names the field when the server says the email is not the account's own", async () => {
    const server = stubServer({
      remove: () =>
        json(
          { type: "x", title: "x", status: 422, code: "validation_failed", detail: "x", requestId: "req-422", errors: [{ path: "email", code: "email_mismatch" }] },
          { status: 422, contentType: "application/problem+json" },
        ),
    });
    const dialog = await readyToConfirm();

    await press(submit(dialog));

    expect(await within(dialog).findByText("That is not the email address of your account.")).toBeTruthy();
    expect(screen.queryByText("Your account was deleted")).toBeNull();
    expect(server.received("DELETE", ME_PATH)).toHaveLength(1);
    expect(window.location.pathname).toBe("/settings/account");
  }, SLOW_TEST_TIMEOUT_MS);

  it("reports another failure in an error toast, keeps the dialog and lets the member try again", async () => {
    const server = stubServer({ remove: (call) => (call === 1 ? problem(503, "unavailable", "req-503") : new Response(null, { status: 204 })) });
    const dialog = await readyToConfirm();

    await press(submit(dialog));

    expect((await screen.findAllByText("req-503", { exact: false })).length).toBeGreaterThan(0);
    expect(screen.queryByText("Your account was deleted")).toBeNull();
    expect(window.location.pathname).toBe("/settings/account");
    await waitFor(() => {
      expect(submit(dialog).hasAttribute("disabled")).toBe(false);
    });
    await press(submit(dialog));
    await waitFor(() => {
      expect(window.location.pathname).toBe("/login");
    });
    expect(server.received("DELETE", ME_PATH)).toHaveLength(2);
  }, SLOW_TEST_TIMEOUT_MS);

  it("sends nothing when the member cancels", async () => {
    const server = stubServer();
    const dialog = await readyToConfirm();

    await press(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(server.received("DELETE", ME_PATH)).toHaveLength(0);
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("a refused deletion", () => {
  it("lists the workspaces the account is the last owner of, with links to their members, and offers no deletion", async () => {
    const server = stubServer({
      workspaces: [SOLO, BLOCKING],
      remove: () =>
        json(
          { type: "x", title: "x", status: 409, code: "last_owner", detail: "x", requestId: "req-409", workspaces: [{ id: BLOCKING.id, name: BLOCKING.name }] },
          { status: 409, contentType: "application/problem+json" },
        ),
    });
    const dialog = await readyToConfirm();

    await press(submit(dialog));

    const blocked = await screen.findByRole("dialog", { name: "Your account cannot be deleted yet" });
    expect(blocked.textContent).toContain("You are the only owner of workspaces that have other members.");
    expect(within(blocked).queryByRole("textbox")).toBeNull();
    expect(within(blocked).queryByRole("button", { name: "Delete account" })).toBeNull();
    expect(window.location.pathname).toBe("/settings/account");
    expect(server.received("DELETE", ME_PATH)).toHaveLength(1);

    await press(within(blocked).getByRole("link", { name: "Open the members of Engine Room" }));

    await waitFor(() => {
      expect(window.location.pathname).toBe("/settings/workspace/members");
    });
    expect(server.received("PUT", ACTIVE_WORKSPACE_PATH).map(({ body }) => body)).toEqual([{ workspaceId: BLOCKING.id }]);
    expect(screen.queryByRole("dialog", { name: "Your account cannot be deleted yet" })).toBeNull();
    expect(server.received("DELETE", ME_PATH)).toHaveLength(1);
  }, SLOW_TEST_TIMEOUT_MS);

  it("explains that the last instance admin cannot delete the account, and offers nothing but closing it", async () => {
    const server = stubServer({
      remove: () =>
        json(
          { type: "x", title: "x", status: 422, code: "validation_failed", detail: "x", requestId: "req-422", errors: [{ path: "email", code: "last_instance_admin" }] },
          { status: 422, contentType: "application/problem+json" },
        ),
    });
    const dialog = await readyToConfirm();

    await press(submit(dialog));

    const blocked = await screen.findByRole("dialog", { name: "Your account cannot be deleted yet" });
    expect(blocked.textContent).toContain("You are the only instance admin, and an instance needs one.");
    expect(within(blocked).queryByRole("textbox")).toBeNull();
    expect(within(blocked).queryByRole("link")).toBeNull();
    expect(within(blocked).queryByRole("button", { name: "Delete account" })).toBeNull();
    expect(screen.queryByText("Your account was deleted")).toBeNull();

    await press(within(blocked).getAllByRole("button", { name: "Close" })[0] as HTMLElement);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Your account cannot be deleted yet" })).toBeNull();
    });
    expect(server.received("DELETE", ME_PATH)).toHaveLength(1);
    expect(window.location.pathname).toBe("/settings/account");
  }, SLOW_TEST_TIMEOUT_MS);

  it.each([
    ["billing_active", "This account or one of its workspaces has an active paid subscription."],
    ["internal", "This server does not allow the account to be deleted right now."],
  ])("explains a refusal of the deletion guard (%s) in the dialog and offers nothing but closing it", async (code, message) => {
    stubServer({ remove: () => problem(409, code, "req-409") });
    const dialog = await readyToConfirm();

    await press(submit(dialog));

    const blocked = await screen.findByRole("dialog", { name: "Your account cannot be deleted yet" });
    expect(blocked.textContent).toContain(message);
    expect(within(blocked).queryByRole("textbox")).toBeNull();
    expect(within(blocked).queryByRole("button", { name: "Delete account" })).toBeNull();
    expect(screen.queryByText("Your account was deleted")).toBeNull();
    expect(window.location.pathname).toBe("/settings/account");
  }, SLOW_TEST_TIMEOUT_MS);
});
