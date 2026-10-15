import type { ComponentTypes } from "@slugbase/contracts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { createWebApp } from "../src/index.ts";
import { ACCOUNT_BODY, CONFIG_BODY, ME_PATH, SESSION_PATH, json, meBody, problem, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// /settings/account/security (doc 03 section 11.2) and the re-authentication prompt (doc 04 section 4.4). The failure
// scenarios are a password change that shows as done when the server refused it, a refusal that is not shown in its
// field, a request that is not sent again after the member confirmed (or is sent again after they gave up), a revoke
// that leaves the list stale, and a sessions list that claims there are no sessions.

type Transport = (request: Request) => Promise<Response>;
type Session = ComponentTypes["schemas"]["Session"];

const PASSWORD_PATH = "/api/v1/me/password";
const REAUTH_PATH = "/api/v1/me/reauth";

const CURRENT: Session = {
  id: "0192f3a0-cccc-7000-8000-000000000001",
  createdAt: "2026-10-01T08:00:00.000Z",
  lastSeenAt: "2026-10-15T09:30:00.000Z",
  userAgentFamily: "Firefox",
  ipPrefix: "203.0",
  current: true,
};
const LAPTOP: Session = { ...CURRENT, id: "0192f3a0-cccc-7000-8000-000000000002", userAgentFamily: "Chrome", ipPrefix: "198.51", current: false };
const PHONE: Session = { ...CURRENT, id: "0192f3a0-cccc-7000-8000-000000000003", userAgentFamily: null, ipPrefix: null, current: false };

interface Call {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly contentType: string | null;
  readonly body: unknown;
}

interface Server {
  readonly calls: Call[];
  readonly to: (method: string, path: string) => Call[];
}

interface ServerOptions {
  sessions?: () => Response | Promise<Response>;
  password?: (call: number) => Response | Promise<Response>;
  reauth?: (call: number) => Response | Promise<Response>;
  revoke?: () => Response | Promise<Response>;
  hasPassword?: boolean;
}

/** A server with a signed-in account whose sessions are `initial`, which revokes the sessions it is told to. */
function stubServer({ sessions, password, reauth, revoke, hasPassword = true }: ServerOptions = {}, initial: readonly Session[] = [CURRENT, LAPTOP, PHONE]): Server {
  let listed = [...initial];
  let ended = false;
  const calls: Call[] = [];
  const fetch = vi.fn<Transport>(async (request) => {
    const { pathname, search } = new URL(request.url);
    const text = request.method === "GET" || request.method === "HEAD" ? "" : await request.clone().text();
    const call: Call = {
      method: request.method,
      path: pathname,
      search,
      contentType: request.headers.get("Content-Type"),
      body: text === "" ? undefined : (JSON.parse(text) as unknown),
    };
    if (pathname === "/api/config") {
      return json(CONFIG_BODY);
    }
    if (ended && (pathname === ME_PATH || pathname === SESSION_PATH)) {
      return problem(401, "unauthenticated", "req-401");
    }
    if (pathname === ME_PATH) {
      return json({ ...(meBody() as { account: object }), account: { ...ACCOUNT_BODY, hasPassword } });
    }
    calls.push(call);
    if (pathname === SESSION_PATH && request.method === "GET") {
      return search.includes("limit=1&") || search.endsWith("limit=1") ? json({ items: listed.slice(0, 1), nextCursor: null }) : (sessions?.() ?? json({ items: listed, nextCursor: null }));
    }
    if (pathname === "/api/v1/me/identities") {
      return json({ items: [], nextCursor: null });
    }
    if (pathname === PASSWORD_PATH) {
      return password?.(calls.filter((entry) => entry.path === PASSWORD_PATH).length) ?? new Response(null, { status: 204 });
    }
    if (pathname === REAUTH_PATH) {
      return reauth?.(calls.filter((entry) => entry.path === REAUTH_PATH).length) ?? new Response(null, { status: 204 });
    }
    if (request.method === "DELETE" && pathname === SESSION_PATH) {
      listed = listed.filter((session) => session.current);
      return new Response(null, { status: 204 });
    }
    if (request.method === "DELETE" && pathname.startsWith(`${SESSION_PATH}/`)) {
      if (revoke !== undefined) {
        return revoke();
      }
      const id = pathname.slice(SESSION_PATH.length + 1);
      ended = listed.some((session) => session.id === id && session.current);
      listed = listed.filter((session) => session.id !== id);
      return new Response(null, { status: 204 });
    }
    return problem(404, "not_found", "req-404");
  });
  vi.stubGlobal("fetch", fetch);
  return { calls, to: (method, path) => calls.filter((call) => call.method === method && call.path === path) };
}

function reauthRequired(): Response {
  return problem(401, "reauth_required", "req-reauth");
}

function withErrors(status: number, code: string, errors: readonly { path: string; code: string }[]): Response {
  return json(
    { type: `https://slugbase.app/problems/${code}`, title: code, status, code, detail: "x", requestId: "req-422", errors },
    { status, contentType: "application/problem+json" },
  );
}

async function openSecurity(path = "/settings/account/security"): Promise<void> {
  window.history.replaceState(null, "", path);
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
  await screen.findByRole("heading", { level: 1, name: "Security" });
}

async function act_(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

function typeInto(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function submitPasswordChange(current = "old password 1", next = "a much longer new passphrase"): Promise<void> {
  typeInto("Current password", current);
  typeInto("New password", next);
  await act_(() => {
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
  });
}

function sessionRows(): HTMLElement[] {
  return within(screen.getByRole("table", { name: "Sessions" })).getAllByRole("row").slice(1);
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

describe("the security page", () => {
  it("opens from the Security link of the settings navigation", async () => {
    stubServer();
    window.history.replaceState(null, "", "/settings/account");
    const App = createWebApp({ extensions: [] });
    await renderApp(<App />);
    const nav = await screen.findByRole("navigation", { name: "Settings" });

    await act_(() => {
      fireEvent.click(within(nav).getByRole("link", { name: "Security" }));
    });

    expect(await screen.findByRole("heading", { level: 1, name: "Security" })).toBeTruthy();
    expect(window.location.pathname).toBe("/settings/account/security");
    expect(within(screen.getByRole("navigation", { name: "Settings" })).getByRole("link", { name: "Security" }).getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("opens from the Security entry of the account menu", async () => {
    stubServer();
    window.history.replaceState(null, "", "/");
    const App = createWebApp({ extensions: [] });
    await renderApp(<App />);
    await act_(() => {
      fireEvent.click(screen.getByRole("button", { name: "Account" }));
    });
    await act_(() => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Security" }));
    });

    expect(await screen.findByRole("heading", { level: 1, name: "Security" })).toBeTruthy();
    expect(window.location.pathname).toBe("/settings/account/security");
  });

  it("offers an account without a password to add one, without asking for a current password", async () => {
    stubServer({ hasPassword: false });
    await openSecurity();

    expect(await screen.findByRole("heading", { level: 2, name: "Add a password" })).toBeTruthy();
    expect(screen.queryByLabelText("Current password")).toBeNull();
    expect(screen.queryByRole("button", { name: "Change password" })).toBeNull();
  });
});

describe("the Password card", () => {
  it("scores the new password as it is typed, in words and as a meter, in the browser alone", async () => {
    const server = stubServer();
    await openSecurity();

    expect(screen.queryByRole("meter")).toBeNull();
    typeInto("New password", "password1234");
    expect(screen.getByRole("meter", { name: "Password strength" }).getAttribute("aria-valuetext")).toBe("Very weak");
    typeInto("New password", "correct horse battery staple");
    expect(screen.getByRole("meter", { name: "Password strength" }).getAttribute("aria-valuetext")).toBe("Strong");
    expect(server.calls.filter((call) => call.path === PASSWORD_PATH)).toEqual([]);
  });

  it("changes the password, says the other sessions were signed out, clears the fields and reloads the sessions", async () => {
    const server = stubServer();
    await openSecurity();
    await waitFor(() => {
      expect(sessionRows()).toHaveLength(3);
    });
    const listsBefore = server.to("GET", SESSION_PATH).length;

    await submitPasswordChange();

    expect(await screen.findByText("Your password was changed. Your other sessions were signed out.")).toBeTruthy();
    expect(server.to("POST", PASSWORD_PATH).map((call) => call.body)).toEqual([
      { currentPassword: "old password 1", newPassword: "a much longer new passphrase" },
    ]);
    expect(screen.getByLabelText<HTMLInputElement>("Current password").value).toBe("");
    expect(screen.getByLabelText<HTMLInputElement>("New password").value).toBe("");
    await waitFor(() => {
      expect(server.to("GET", SESSION_PATH).length).toBeGreaterThan(listsBefore);
    });
  });

  it("asks for both passwords before sending anything", async () => {
    const server = stubServer();
    await openSecurity();

    await act_(() => {
      fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    });

    expect(screen.getByText("Enter your current password.")).toBeTruthy();
    expect(screen.getByText("Enter a new password.")).toBeTruthy();
    expect(server.to("POST", PASSWORD_PATH)).toEqual([]);
  });

  it.each([
    ["too_short", "Use at least 12 characters."],
    ["too_long", "Use at most 256 characters."],
    ["breached", "This password appeared in a known data breach. Choose another one."],
  ])("shows the server's %s refusal in the new password field and no success note", async (code, message) => {
    stubServer({ password: () => withErrors(422, "weak_password", [{ path: "newPassword", code }]) });
    await openSecurity();

    await submitPasswordChange("old password 1", "short");

    const field = await screen.findByLabelText("New password");
    await waitFor(() => {
      expect(field.getAttribute("aria-invalid")).toBe("true");
    });
    expect(screen.getByText(message)).toBeTruthy();
    expect(screen.queryByText(/Your password was changed/)).toBeNull();
    expect(screen.queryByText("The change was not saved")).toBeNull();
    expect((field as HTMLInputElement).value).toBe("short");
  });

  it("shows a wrong current password in the current password field", async () => {
    stubServer({ password: () => withErrors(422, "validation_failed", [{ path: "currentPassword", code: "invalid_password" }]) });
    await openSecurity();

    await submitPasswordChange();

    expect(await screen.findByText("The current password is not right.")).toBeTruthy();
    expect(screen.getByLabelText("Current password").getAttribute("aria-invalid")).toBe("true");
    expect(screen.queryByText(/Your password was changed/)).toBeNull();
  });

  it("raises a toast for a failure that is not a refusal of a field, and shows no success note", async () => {
    stubServer({ password: () => problem(503, "unavailable", "req-503") });
    await openSecurity();

    await submitPasswordChange();

    expect((await screen.findAllByText("The change was not saved")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Your password was changed/)).toBeNull();
  });
});

describe("the re-authentication prompt", () => {
  it("opens on reauth_required, confirms with the password and sends the change again once", async () => {
    const server = stubServer({ password: (call) => (call === 1 ? reauthRequired() : new Response(null, { status: 204 })) });
    await openSecurity();

    await submitPasswordChange();

    const dialog = await screen.findByRole("dialog", { name: "Confirm it is you" });
    expect(server.to("POST", REAUTH_PATH)).toEqual([]);
    fireEvent.change(within(dialog).getByLabelText("Password"), { target: { value: "old password 1" } });
    await act_(() => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    });

    expect(await screen.findByText("Your password was changed. Your other sessions were signed out.")).toBeTruthy();
    expect(server.to("POST", REAUTH_PATH).map((call) => call.body)).toEqual([{ password: "old password 1" }]);
    const order = server.calls.filter((call) => [PASSWORD_PATH, REAUTH_PATH].includes(call.path)).map((call) => call.path);
    expect(order).toEqual([PASSWORD_PATH, REAUTH_PATH, PASSWORD_PATH]);
    expect(server.to("POST", PASSWORD_PATH).map((call) => call.body)).toEqual([
      { currentPassword: "old password 1", newPassword: "a much longer new passphrase" },
      { currentPassword: "old password 1", newPassword: "a much longer new passphrase" },
    ]);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("stays open with the error in the field when the password is wrong, and does not send the change again", async () => {
    const server = stubServer({
      password: () => reauthRequired(),
      reauth: () => withErrors(401, "reauth_required", [{ path: "password", code: "invalid_password" }]),
    });
    await openSecurity();
    await submitPasswordChange();
    const dialog = await screen.findByRole("dialog", { name: "Confirm it is you" });

    fireEvent.change(within(dialog).getByLabelText("Password"), { target: { value: "nope" } });
    await act_(() => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    });

    expect(await within(dialog).findByText("The password is not right.")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Confirm it is you" })).toBeTruthy();
    expect(server.to("POST", PASSWORD_PATH)).toHaveLength(1);
    expect(screen.queryByText(/Your password was changed/)).toBeNull();
  });

  it("asks only once when the password is accepted and the change is refused again, and reports that refusal", async () => {
    const server = stubServer({ password: () => reauthRequired() });
    await openSecurity();
    await submitPasswordChange();
    const dialog = await screen.findByRole("dialog", { name: "Confirm it is you" });

    fireEvent.change(within(dialog).getByLabelText("Password"), { target: { value: "old password 1" } });
    await act_(() => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    });

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(server.to("POST", PASSWORD_PATH)).toHaveLength(2);
    expect((await screen.findAllByText("The change was not saved")).length).toBeGreaterThan(0);
  });

  it("sends nothing again and raises no failure when the member closes it", async () => {
    const server = stubServer({ password: () => reauthRequired() });
    await openSecurity();
    await submitPasswordChange();
    const dialog = await screen.findByRole("dialog", { name: "Confirm it is you" });

    await act_(() => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    });

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(server.to("POST", PASSWORD_PATH)).toHaveLength(1);
    expect(server.to("POST", REAUTH_PATH)).toEqual([]);
    expect(screen.queryByText("The change was not saved")).toBeNull();
    expect(screen.queryByText(/Your password was changed/)).toBeNull();
  });
});

describe("the Sessions card", () => {
  it("lists the device, the network prefix, when each was created and last seen, and marks this device", async () => {
    stubServer();
    await openSecurity();

    await waitFor(() => {
      expect(sessionRows()).toHaveLength(3);
    });
    const [current, laptop, phone] = sessionRows() as [HTMLElement, HTMLElement, HTMLElement];
    expect(within(current).getByText("Firefox")).toBeTruthy();
    expect(within(current).getByText("This device")).toBeTruthy();
    expect(within(current).getByText("203.0")).toBeTruthy();
    expect(within(laptop).getByText("Chrome")).toBeTruthy();
    expect(within(laptop).queryByText("This device")).toBeNull();
    expect(within(phone).getByText("Unknown device")).toBeTruthy();
    expect(within(phone).getByText("Unknown")).toBeTruthy();
    expect(screen.getAllByText("This device")).toHaveLength(1);
    const headers = within(screen.getByRole("table", { name: "Sessions" })).getAllByRole("columnheader");
    expect(headers.map((header) => header.textContent)).toEqual(["Device", "Network", "Signed in", "Last active", "Actions"]);
    expect(within(laptop).getAllByText(/2026/)).toHaveLength(2);
  });

  it("has a Revoke on every row", async () => {
    stubServer();
    await openSecurity();

    await waitFor(() => {
      expect(sessionRows()).toHaveLength(3);
    });
    for (const row of sessionRows()) {
      expect(within(row).getByRole("button", { name: /^Revoke the session on/ })).toBeTruthy();
    }
  });

  it("revokes a session with a JSON request and shows the list without it", async () => {
    const server = stubServer();
    await openSecurity();
    await waitFor(() => {
      expect(sessionRows()).toHaveLength(3);
    });

    await act_(() => {
      fireEvent.click(screen.getByRole("button", { name: "Revoke the session on Chrome" }));
    });

    await waitFor(() => {
      expect(sessionRows()).toHaveLength(2);
    });
    const [revoke] = server.to("DELETE", `${SESSION_PATH}/${LAPTOP.id}`);
    expect(revoke?.contentType).toBe("application/json");
    expect(screen.queryByText("Chrome")).toBeNull();
    expect((await screen.findAllByText("Session revoked")).length).toBeGreaterThan(0);
  });

  it("raises a toast and keeps the row when a revoke fails", async () => {
    const server = stubServer({ revoke: () => problem(503, "unavailable", "req-503") });
    await openSecurity();
    await waitFor(() => {
      expect(sessionRows()).toHaveLength(3);
    });

    await act_(() => {
      fireEvent.click(screen.getByRole("button", { name: "Revoke the session on Chrome" }));
    });

    expect((await screen.findAllByText("The change was not saved")).length).toBeGreaterThan(0);
    expect(server.to("DELETE", `${SESSION_PATH}/${LAPTOP.id}`)).toHaveLength(1);
    expect(sessionRows()).toHaveLength(3);
    expect(screen.queryByText("Session revoked")).toBeNull();
  });

  it("signs out everywhere else only after a confirmation, and keeps this device", async () => {
    const server = stubServer();
    await openSecurity();
    await waitFor(() => {
      expect(sessionRows()).toHaveLength(3);
    });

    await act_(() => {
      fireEvent.click(screen.getByRole("button", { name: "Sign out everywhere else" }));
    });
    const dialog = await screen.findByRole("alertdialog", { name: "Sign out everywhere else?" });
    expect(server.to("DELETE", SESSION_PATH)).toEqual([]);
    await act_(() => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    });
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(server.to("DELETE", SESSION_PATH)).toEqual([]);

    await act_(() => {
      fireEvent.click(screen.getByRole("button", { name: "Sign out everywhere else" }));
    });
    const again = await screen.findByRole("alertdialog", { name: "Sign out everywhere else?" });
    await act_(() => {
      fireEvent.click(within(again).getByRole("button", { name: "Sign out everywhere else" }));
    });

    await waitFor(() => {
      expect(sessionRows()).toHaveLength(1);
    });
    const [call] = server.to("DELETE", SESSION_PATH);
    expect(call?.search).toBe("");
    expect(call?.contentType).toBe("application/json");
    expect(within(sessionRows()[0] as HTMLElement).getByText("This device")).toBeTruthy();
    expect((await screen.findAllByText("Signed out everywhere else")).length).toBeGreaterThan(0);
  });

  it("has nothing to sign out everywhere else while this device is the only session", async () => {
    stubServer({}, [CURRENT]);
    await openSecurity();

    await waitFor(() => {
      expect(sessionRows()).toHaveLength(1);
    });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Sign out everywhere else" }).disabled).toBe(true);
  });

  it("revokes this device only after a confirmation and then goes to sign in", async () => {
    const server = stubServer();
    await openSecurity();
    await waitFor(() => {
      expect(sessionRows()).toHaveLength(3);
    });

    await act_(() => {
      fireEvent.click(screen.getByRole("button", { name: "Revoke the session on Firefox" }));
    });
    const dialog = await screen.findByRole("alertdialog", { name: "Sign out of this device?" });
    expect(server.to("DELETE", `${SESSION_PATH}/${CURRENT.id}`)).toEqual([]);
    await act_(() => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Sign out" }));
    });

    await waitFor(() => {
      expect(window.location.pathname).toBe("/login");
    });
    expect(server.to("DELETE", `${SESSION_PATH}/${CURRENT.id}`)).toHaveLength(1);
  });

  it("shows a loading skeleton while the sessions load", async () => {
    stubServer({ sessions: () => new Promise<Response>(() => undefined) });
    await openSecurity();

    expect(screen.getAllByRole("status", { name: "Loading" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("table", { name: "Sessions" })).toBeNull();
  });

  it("says the sessions could not be loaded, and tries again", async () => {
    let failing = true;
    const server = stubServer({ sessions: () => (failing ? problem(400, "bad_request", "req-400") : json({ items: [CURRENT], nextCursor: null })) });
    await openSecurity();

    expect(await screen.findByText("Your sessions could not be loaded")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Sessions" })).toBeNull();
    failing = false;
    await act_(() => {
      fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Try again" }));
    });

    await waitFor(() => {
      expect(sessionRows()).toHaveLength(1);
    });
    expect(server.to("GET", SESSION_PATH).length).toBeGreaterThan(1);
  });

  it("never shows an empty state: the current session always exists, so an empty answer is an error", async () => {
    stubServer({ sessions: () => json({ items: [], nextCursor: null }) });
    await openSecurity();

    expect(await screen.findByText("Your sessions could not be loaded")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Sessions" })).toBeNull();
    expect(screen.queryByText(/no sessions|nothing here|empty/i)).toBeNull();
    expect(screen.queryByText("This device")).toBeNull();
  });

  it("offers the next page when the server has more sessions than one page", async () => {
    const server = stubServer({
      sessions: () => json({ items: [CURRENT], nextCursor: "next-page" }),
    });
    await openSecurity();
    await waitFor(() => {
      expect(sessionRows()).toHaveLength(1);
    });

    await act_(() => {
      fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    });

    await waitFor(() => {
      expect(server.to("GET", SESSION_PATH).some((call) => call.search.includes("cursor=next-page"))).toBe(true);
    });
  });
});

describe("accessibility and layout", () => {
  async function violations(): Promise<string[]> {
    const results = await axe(document.body, { rules: { region: { enabled: false } } });
    return results.violations.map((violation) => `${violation.id}: ${violation.help}`);
  }

  it.each(["light", "dark"] as const)("has no axe violations at tablet width in the %s theme", async (theme) => {
    stubServer();
    await openSecurity();
    await waitFor(() => {
      expect(sessionRows()).toHaveLength(3);
    });
    document.documentElement.classList.toggle("dark", theme === "dark");

    expect(await violations()).toEqual([]);
  });

  it.each(["light", "dark"] as const)("has no axe violations with the dialogs open in the %s theme", async (theme) => {
    stubServer({ password: () => reauthRequired() });
    await openSecurity();
    document.documentElement.classList.toggle("dark", theme === "dark");
    await submitPasswordChange();
    await screen.findByRole("dialog", { name: "Confirm it is you" });

    expect(await violations()).toEqual([]);
  });

  it("lists each session as a card on a narrow screen, with the same content and actions", async () => {
    stubMatchMedia(true);
    stubServer();
    await openSecurity();

    const list = await screen.findByRole("list", { name: "Sessions" });
    const cards = within(list).getAllByRole("listitem");
    expect(cards).toHaveLength(3);
    expect(within(cards[0] as HTMLElement).getByText("This device")).toBeTruthy();
    expect(within(cards[1] as HTMLElement).getByRole("button", { name: "Revoke the session on Chrome" })).toBeTruthy();
    expect(await violations()).toEqual([]);
  });
});
