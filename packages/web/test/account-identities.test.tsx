import type { ComponentTypes } from "@slugbase/contracts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { navigateTo } from "../src/auth/navigate.ts";
import { createWebApp } from "../src/index.ts";
import { CONFIG_BODY, ME_PATH, SESSION_PATH, json, meBody, problem, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

vi.mock("../src/auth/navigate.ts", () => ({ navigateTo: vi.fn() }));

// The Linked sign-in methods card, "Add a password" and the provider variant of the re-authentication prompt on
// /settings/account/security (doc 03 section 11.2, doc 04 sections 4.4 and 4.5). The failure scenarios are a failed
// list that reads as "nothing linked", a link that navigates to a raw problem document because the session was not
// fresh, an unlink that leaves the list stale or hides the one-method refusal, a passwordless account that is asked
// for a password it does not have, and a card that shows for a server with nothing to manage.

type Identity = ComponentTypes["schemas"]["Identity"];

const IDENTITIES_PATH = "/api/v1/me/identities";
const START_PATH = "/api/v1/auth/oidc/acme/start";
const PASSWORD_PATH = "/api/v1/me/password";
const REAUTH_PATH = "/api/v1/me/reauth";

const PROVIDERS = [
  { slug: "acme", name: "Acme SSO" },
  { slug: "town-hall", name: "Town Hall" },
] as const;

const ACME: Identity = {
  id: "0192f3a0-dddd-7000-8000-000000000001",
  provider: "acme",
  emailAtLink: "ada@acme.example",
  createdAt: "2026-09-01T08:00:00.000Z",
  lastUsedAt: "2026-10-14T12:30:00.000Z",
};
const REMOVED: Identity = { ...ACME, id: "0192f3a0-dddd-7000-8000-000000000002", provider: "old-idp", emailAtLink: "", lastUsedAt: null };

interface Call {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly redirect: RequestRedirect;
  readonly body: unknown;
}

interface ServerOptions {
  providers?: readonly { slug: string; name: string }[] | undefined;
  identities?: readonly Identity[];
  hasPassword?: boolean;
  list?: () => Response | undefined;
  unlink?: () => Response | undefined;
  start?: (call: number) => Response;
  password?: (call: number) => Response | undefined;
  reauth?: () => Response;
}

interface Server {
  readonly calls: Call[];
  readonly to: (method: string, path: string) => Call[];
}

function stubServer({
  providers = PROVIDERS,
  identities = [],
  hasPassword = true,
  list,
  unlink,
  start,
  password,
  reauth,
}: ServerOptions = {}): Server {
  let linked = [...identities];
  let passwordSet = hasPassword;
  const calls: Call[] = [];
  const count = (path: string): number => calls.filter((entry) => entry.path === path).length;
  const fetch = vi.fn(async (request: Request) => {
    const { pathname, search } = new URL(request.url);
    if (pathname === "/api/config") {
      return json({ ...CONFIG_BODY, signIn: { oidc: providers } });
    }
    if (pathname === ME_PATH) {
      return json({ ...(meBody() as { account: object }), account: { ...(meBody() as { account: object }).account, hasPassword: passwordSet } });
    }
    if (pathname === SESSION_PATH) {
      return json({ items: [], nextCursor: null });
    }
    const text = request.method === "GET" ? "" : await request.clone().text();
    calls.push({ method: request.method, path: pathname, search, redirect: request.redirect, body: text === "" ? undefined : (JSON.parse(text) as unknown) });
    if (pathname === IDENTITIES_PATH) {
      return list?.() ?? json({ items: linked, nextCursor: null });
    }
    if (request.method === "DELETE" && pathname.startsWith(`${IDENTITIES_PATH}/`)) {
      const refused = unlink?.();
      if (refused !== undefined) {
        return refused;
      }
      const id = pathname.slice(IDENTITIES_PATH.length + 1);
      linked = linked.filter((identity) => identity.id !== id);
      return new Response(null, { status: 204 });
    }
    if (pathname.startsWith("/api/v1/auth/oidc/") && pathname.endsWith("/start")) {
      return start?.(count(pathname)) ?? new Response(null, { status: 302, headers: { Location: "https://idp.example/authorize" } });
    }
    if (pathname === PASSWORD_PATH) {
      const answer = password?.(count(PASSWORD_PATH));
      if (answer !== undefined) {
        return answer;
      }
      passwordSet = true;
      return new Response(null, { status: 204 });
    }
    if (pathname === REAUTH_PATH) {
      return reauth?.() ?? new Response(null, { status: 204 });
    }
    return problem(404, "not_found", "req-404");
  });
  vi.stubGlobal("fetch", fetch);
  return { calls, to: (method, path) => calls.filter((call) => call.method === method && call.path === path) };
}

function reauthRequired(): Response {
  return problem(401, "reauth_required", "req-reauth");
}

function lastSignInMethod(): Response {
  return json(
    {
      type: "https://slugbase.app/problems/validation_failed",
      title: "validation_failed",
      status: 422,
      code: "validation_failed",
      detail: "x",
      requestId: "req-422",
      errors: [{ path: "id", code: "last_sign_in_method" }],
    },
    { status: 422, contentType: "application/problem+json" },
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

function click(name: string | RegExp, scope: HTMLElement = document.body): Promise<void> {
  return act_(() => {
    fireEvent.click(within(scope).getByRole("button", { name }));
  });
}

async function card(): Promise<HTMLElement> {
  const heading = await screen.findByRole("heading", { level: 2, name: "Linked sign-in methods" });
  const section = heading.closest("section");
  if (section === null) {
    throw new Error("the card has no section");
  }
  return section;
}

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia(false);
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
  vi.mocked(navigateTo).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("lang");
});

describe("the Linked sign-in methods card", () => {
  it("lists the linked identities with provider, email at link and last use, and a Link action for each provider not linked", async () => {
    stubServer({ identities: [ACME] });
    await openSecurity();
    const section = await card();

    const row = await within(section).findByRole("row", { name: /Acme SSO/ });
    expect(within(row).getByText("ada@acme.example")).toBeTruthy();
    expect(within(row).getByText(/Oct 14, 2026/)).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Unlink Acme SSO" })).toBeTruthy();
    expect(within(section).getByRole("button", { name: "Link Town Hall" })).toBeTruthy();
    expect(within(section).queryByRole("button", { name: "Link Acme SSO" })).toBeNull();
  });

  it("shows 'Never' for an identity that was not used since it was linked, and the slug of a provider that was removed", async () => {
    stubServer({ identities: [REMOVED], providers: [] });
    await openSecurity();
    const section = await card();

    const row = await within(section).findByRole("row", { name: /old-idp/ });
    expect(within(row).getByText("Never")).toBeTruthy();
    expect(within(row).getByText("Not given")).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Unlink old-idp" })).toBeTruthy();
  });

  it("lists every provider with a Link action when none is linked, and says so", async () => {
    stubServer();
    await openSecurity();
    const section = await card();

    expect(await within(section).findByText("No provider is linked to your account.")).toBeTruthy();
    expect(within(section).getByRole("button", { name: "Link Acme SSO" })).toBeTruthy();
    expect(within(section).getByRole("button", { name: "Link Town Hall" })).toBeTruthy();
  });

  it("is not shown when no provider is configured and none is linked", async () => {
    const server = stubServer({ providers: [] });
    await openSecurity();
    await screen.findByRole("heading", { level: 2, name: "Password" });
    await waitFor(() => {
      expect(server.to("GET", IDENTITIES_PATH)).toHaveLength(1);
    });

    expect(screen.queryByRole("heading", { level: 2, name: "Linked sign-in methods" })).toBeNull();
    expect(screen.queryByText("No provider is linked to your account.")).toBeNull();
  });

  it("reads a page after the first before it offers a provider to link", async () => {
    const SECOND: Identity = { ...ACME, id: "0192f3a0-dddd-7000-8000-000000000003", provider: "town-hall" };
    let page = 0;
    stubServer({
      list: () => {
        page += 1;
        return page === 1 ? json({ items: [ACME], nextCursor: "next" }) : json({ items: [SECOND], nextCursor: null });
      },
    });
    await openSecurity();
    const section = await card();

    expect(await within(section).findByText("Town Hall")).toBeTruthy();
    expect(within(section).queryByRole("button", { name: /^Link / })).toBeNull();
  });

  it("says the identities could not be loaded instead of listing none, and loads them on retry", async () => {
    let failing = true;
    stubServer({ identities: [ACME], list: () => (failing ? problem(400, "bad_request", "req-400") : undefined) });
    await openSecurity();
    const section = await card();

    const alert = await within(section).findByRole("alert");
    expect(within(alert).getByText("Your linked sign-in methods could not be loaded")).toBeTruthy();
    expect(within(section).queryByText("No provider is linked to your account.")).toBeNull();
    expect(within(section).queryByRole("button", { name: /^Link / })).toBeNull();
    expect(within(section).queryByRole("button", { name: /^Unlink/ })).toBeNull();

    failing = false;
    await click("Try again", alert);

    expect(await within(section).findByRole("row", { name: /Acme SSO/ })).toBeTruthy();
    expect(within(section).queryByRole("alert")).toBeNull();
  });

  it("has no accessibility violations", async () => {
    stubServer({ identities: [ACME] });
    await openSecurity();
    await within(await card()).findByRole("row", { name: /Acme SSO/ });

    const results = await axe(document.body, { rules: { region: { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});

describe("unlinking", () => {
  it("asks first, explains that one way to sign in must remain, then unlinks and reloads the list", async () => {
    const server = stubServer({ identities: [ACME] });
    await openSecurity();
    const section = await card();
    await click("Unlink Acme SSO", await within(section).findByRole("row", { name: /Acme SSO/ }));

    const dialog = await screen.findByRole("alertdialog", { name: "Unlink Acme SSO?" });
    expect(within(dialog).getByText(/At least one way to sign in must remain/)).toBeTruthy();
    expect(server.to("DELETE", `${IDENTITIES_PATH}/${ACME.id}`)).toHaveLength(0);
    await click("Unlink", dialog);

    await waitFor(() => {
      expect(server.to("DELETE", `${IDENTITIES_PATH}/${ACME.id}`)).toHaveLength(1);
    });
    expect(await within(section).findByText("No provider is linked to your account.")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(await screen.findByText("Sign-in method unlinked")).toBeTruthy();
  });

  it("does not unlink when the member cancels", async () => {
    const server = stubServer({ identities: [ACME] });
    await openSecurity();
    const section = await card();
    await click("Unlink Acme SSO", await within(section).findByRole("row", { name: /Acme SSO/ }));

    await click("Cancel", await screen.findByRole("alertdialog"));

    expect(server.calls.filter((call) => call.method === "DELETE")).toEqual([]);
    expect(within(section).getByRole("row", { name: /Acme SSO/ })).toBeTruthy();
  });

  it("shows the refusal of the one-method rule in the card, keeps the identity and raises no toast", async () => {
    stubServer({ identities: [ACME], hasPassword: false, unlink: lastSignInMethod });
    await openSecurity();
    const section = await card();
    await click("Unlink Acme SSO", await within(section).findByRole("row", { name: /Acme SSO/ }));
    await click("Unlink", await screen.findByRole("alertdialog"));

    const alert = await within(section).findByRole("alert");
    expect(within(alert).getByText("This is your only way to sign in")).toBeTruthy();
    expect(within(alert).getByText(/Add a password or link another provider first/)).toBeTruthy();
    expect(within(section).getByRole("row", { name: /Acme SSO/ })).toBeTruthy();
    expect(screen.queryByText("The change was not saved")).toBeNull();
    expect(screen.queryByText("Sign-in method unlinked")).toBeNull();
  });

  it("raises a toast and keeps the identity when the unlink fails for another reason", async () => {
    stubServer({ identities: [ACME], unlink: () => problem(503, "unavailable", "req-503") });
    await openSecurity();
    const section = await card();
    await click("Unlink Acme SSO", await within(section).findByRole("row", { name: /Acme SSO/ }));
    await click("Unlink", await screen.findByRole("alertdialog"));

    expect((await screen.findAllByText("The change was not saved")).length).toBeGreaterThan(0);
    expect(within(section).getByRole("row", { name: /Acme SSO/ })).toBeTruthy();
    expect(screen.queryByText("Sign-in method unlinked")).toBeNull();
  });

  it("confirms with the password when the session is not fresh, and sends the unlink again once", async () => {
    let first = true;
    const server = stubServer({
      identities: [ACME],
      unlink: () => {
        if (first) {
          first = false;
          return reauthRequired();
        }
        return undefined;
      },
    });
    await openSecurity();
    const section = await card();
    await click("Unlink Acme SSO", await within(section).findByRole("row", { name: /Acme SSO/ }));
    await click("Unlink", await screen.findByRole("alertdialog"));

    const prompt = await screen.findByRole("dialog", { name: "Confirm it is you" });
    fireEvent.change(within(prompt).getByLabelText("Password"), { target: { value: "old password 1" } });
    await click("Confirm", prompt);

    expect(await within(section).findByText("No provider is linked to your account.")).toBeTruthy();
    expect(server.to("DELETE", `${IDENTITIES_PATH}/${ACME.id}`)).toHaveLength(2);
  });
});

describe("linking", () => {
  it("navigates the browser to the provider when the session is fresh, with the Security page to come back to", async () => {
    const server = stubServer();
    await openSecurity();
    const section = await card();

    await click("Link Acme SSO", section);

    await waitFor(() => {
      expect(navigateTo).toHaveBeenCalledExactlyOnceWith(`${START_PATH}?intent=link&returnTo=%2Fsettings%2Faccount%2Fsecurity`);
    });
    // The freshness was asked without following the redirect, so a stale session never lands on a raw problem document.
    expect(server.to("GET", START_PATH).map((call) => call.redirect)).toEqual(["manual"]);
    expect(server.to("GET", START_PATH).map((call) => new URLSearchParams(call.search).get("intent"))).toEqual(["link"]);
    expect(server.to("POST", REAUTH_PATH)).toEqual([]);
  });

  it("sends the member through re-authentication first when it is not fresh, then on to the provider", async () => {
    const server = stubServer({ start: (call) => (call === 1 ? reauthRequired() : new Response(null, { status: 302 })) });
    await openSecurity();
    const section = await card();
    await click("Link Acme SSO", section);

    const prompt = await screen.findByRole("dialog", { name: "Confirm it is you" });
    expect(navigateTo).not.toHaveBeenCalled();
    fireEvent.change(within(prompt).getByLabelText("Password"), { target: { value: "old password 1" } });
    await click("Confirm", prompt);

    await waitFor(() => {
      expect(navigateTo).toHaveBeenCalledExactlyOnceWith(`${START_PATH}?intent=link&returnTo=%2Fsettings%2Faccount%2Fsecurity`);
    });
    expect(server.to("POST", REAUTH_PATH).map((call) => call.body)).toEqual([{ password: "old password 1" }]);
  });

  it("goes nowhere and raises no failure when the member closes the re-authentication prompt", async () => {
    const server = stubServer({ start: () => reauthRequired() });
    await openSecurity();
    await click("Link Acme SSO", await card());

    const prompt = await screen.findByRole("dialog", { name: "Confirm it is you" });
    await click("Cancel", prompt);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(navigateTo).not.toHaveBeenCalled();
    expect(server.to("GET", START_PATH)).toHaveLength(1);
    expect(screen.queryByText("The change was not saved")).toBeNull();
    // The member can try again.
    expect(within(await card()).getByRole("button", { name: "Link Acme SSO" }).hasAttribute("disabled")).toBe(false);
  });

  it("raises a toast and stays on the page when the start fails", async () => {
    stubServer({ start: () => problem(503, "unavailable", "req-503") });
    await openSecurity();
    await click("Link Acme SSO", await card());

    expect((await screen.findAllByText("The change was not saved")).length).toBeGreaterThan(0);
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it("offers the provider route to confirm it is you when the account has no password", async () => {
    const server = stubServer({ hasPassword: false, identities: [ACME], start: () => reauthRequired() });
    await openSecurity();
    await click("Link Town Hall", await card());

    const prompt = await screen.findByRole("dialog", { name: "Confirm it is you" });
    expect(within(prompt).queryByLabelText("Password")).toBeNull();
    expect(within(prompt).getByText(/with your sign-in provider/)).toBeTruthy();
    await click("Confirm with Acme SSO", prompt);

    expect(navigateTo).toHaveBeenCalledExactlyOnceWith("/api/v1/auth/oidc/acme/start?intent=reauth&returnTo=%2Fsettings%2Faccount%2Fsecurity");
    expect(server.to("POST", REAUTH_PATH)).toEqual([]);
  });

  it("says no provider is available when an account without a password has none configured", async () => {
    stubServer({ hasPassword: false, identities: [REMOVED], providers: [], unlink: reauthRequired });
    await openSecurity();
    const section = await card();
    await click("Unlink old-idp", await within(section).findByRole("row", { name: /old-idp/ }));
    await click("Unlink", await screen.findByRole("alertdialog"));

    const prompt = await screen.findByRole("dialog", { name: "Confirm it is you" });
    expect(within(prompt).getByText(/No sign-in provider is available/)).toBeTruthy();
    expect(within(prompt).queryByLabelText("Password")).toBeNull();
  });
});

describe("adding a password", () => {
  it("asks for the new password alone, sends it without a current password and turns into the change form", async () => {
    const server = stubServer({ hasPassword: false });
    await openSecurity();
    expect(await screen.findByRole("heading", { level: 2, name: "Add a password" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "a much longer new passphrase" } });
    await click("Add a password", document.body);

    await waitFor(() => {
      expect(server.to("POST", PASSWORD_PATH).map((call) => call.body)).toEqual([{ newPassword: "a much longer new passphrase" }]);
    });
    expect(await screen.findByText("Your password was added. Your other sessions were signed out.")).toBeTruthy();
    expect(await screen.findByLabelText("Current password")).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2, name: "Add a password" })).toBeNull();
  });

  it("is confirmed through the provider when the session is not fresh", async () => {
    stubServer({ hasPassword: false, password: (call) => (call === 1 ? reauthRequired() : undefined) });
    await openSecurity();
    await screen.findByRole("heading", { level: 2, name: "Add a password" });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "a much longer new passphrase" } });
    await click("Add a password", document.body);

    const prompt = await screen.findByRole("dialog", { name: "Confirm it is you" });
    expect(within(prompt).queryByLabelText("Password")).toBeNull();
    expect(within(prompt).getByRole("button", { name: "Confirm with Acme SSO" })).toBeTruthy();
    expect(within(prompt).getByRole("button", { name: "Confirm with Town Hall" })).toBeTruthy();
  });

  it("tells the member when the account gained a password since the page loaded", async () => {
    stubServer({
      hasPassword: false,
      password: () =>
        json(
          {
            type: "https://slugbase.app/problems/validation_failed",
            title: "validation_failed",
            status: 422,
            code: "validation_failed",
            detail: "x",
            requestId: "req-422",
            errors: [{ path: "currentPassword", code: "invalid" }],
          },
          { status: 422, contentType: "application/problem+json" },
        ),
    });
    await openSecurity();
    await screen.findByRole("heading", { level: 2, name: "Add a password" });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "a much longer new passphrase" } });
    await click("Add a password", document.body);

    expect(await screen.findByText("This account already has a password. Reload the page to change it.")).toBeTruthy();
  });
});

describe("the failure of a provider link or re-authentication", () => {
  const FAILED = "Linking or confirming with that provider did not work. Try again.";

  it("sends a signed-in visitor of /login?error=oidc_failed to the Security page, which says it once, generically", async () => {
    stubServer();
    window.history.replaceState(null, "", "/login?error=oidc_failed");
    const App = createWebApp({ extensions: [] });
    await renderApp(<App />);
    await screen.findByRole("heading", { level: 1, name: "Security" });

    expect(window.location.pathname).toBe("/settings/account/security");
    const alert = screen.getByText(FAILED).closest('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).not.toMatch(/state|nonce|token|account|exist/i);
  });

  it("is shown in the language of the page", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-DE", "de"]);
    stubServer();
    window.history.replaceState(null, "", "/settings/account/security?error=oidc_failed");
    const App = createWebApp({ extensions: [] });
    await renderApp(<App />);

    expect(
      await screen.findByText("Das Verknüpfen oder Bestätigen mit diesem Anbieter hat nicht funktioniert. Versuche es erneut."),
    ).toBeTruthy();
  });

  it("is dismissed, and the code leaves the address so a reload does not show it again", async () => {
    stubServer();
    await openSecurity("/settings/account/security?error=oidc_failed");
    expect(screen.getByText(FAILED).closest('[role="alert"]')).not.toBeNull();

    await click("Dismiss");

    await waitFor(() => {
      expect(screen.queryByText(FAILED)).toBeNull();
    });
    expect(window.location.search).toBe("");
  });

  it.each(["/login?error=something_else", "/login"])("sends a signed-in visitor of %s home without a message", async (path) => {
    stubServer();
    window.history.replaceState(null, "", path);
    const App = createWebApp({ extensions: [] });
    await renderApp(<App />);

    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
    });
    expect(window.location.search).toBe("");
    expect(screen.queryByText(FAILED)).toBeNull();
  });

  it("ignores any other error value on the Security page", async () => {
    stubServer();
    await openSecurity("/settings/account/security?error=%3Cb%3Eaccount%20does%20not%20exist%3C%2Fb%3E");

    expect(screen.queryByText(FAILED)).toBeNull();
    expect(screen.queryByText(/does not exist/)).toBeNull();
  });

  it("does not carry the failure along as the page to come back to after confirming through the provider", async () => {
    stubServer({ hasPassword: false, identities: [ACME], start: () => reauthRequired() });
    await openSecurity("/settings/account/security?error=oidc_failed");
    await click("Link Town Hall", await card());
    const prompt = await screen.findByRole("dialog", { name: "Confirm it is you" });
    await click("Confirm with Acme SSO", prompt);

    expect(navigateTo).toHaveBeenCalledExactlyOnceWith("/api/v1/auth/oidc/acme/start?intent=reauth&returnTo=%2Fsettings%2Faccount%2Fsecurity");
  });
});
