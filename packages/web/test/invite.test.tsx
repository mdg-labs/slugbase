import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { navigateTo } from "../src/auth/navigate.ts";
import { createWebApp } from "../src/index.ts";
import {
  ACCOUNT_BODY,
  CONFIG_BODY,
  ME_PATH,
  PRODUCT_NAME,
  SESSION_BODY,
  SESSION_PATH,
  WORKSPACES_PATH,
  WORKSPACE_LIST_BODY,
  json,
  meOf,
  problem,
  renderApp,
  stubBrowserApis,
  stubMatchMedia,
} from "./support.tsx";

vi.mock("../src/auth/navigate.ts", () => ({ navigateTo: vi.fn() }));

// The page behind an invitation link (doc 03 section 1.5, doc 02 section 3.4) over a stubbed transport. The failure
// scenarios are a dead link that says why it is dead, a signed-out visitor who is sent to sign in before the page is
// read, a signed-in stranger who can join with someone else's invitation, a token that reaches an operation other than
// the two invitation ones or the page's title, the console or the error page, an account that is created for an
// address the visitor typed, and a sign-out that leaves the page showing the old branch.

const TOKEN = "invitation-token-for-tests";
const INVITE_URL = `/invite/${TOKEN}`;
const INSPECT_PATH = "/api/v1/invitations/inspect";
const ACCEPT_PATH = "/api/v1/invitations/accept";
const LOGIN_PATH = "/api/v1/auth/login";
const LOGOUT_PATH = "/api/v1/auth/logout";

const INVITEE = "grace@example.org";
const WORKSPACE = "Compilers & Co";

type Viewer = "none" | "invitee" | "other" | "partial";

interface Call {
  readonly method: string;
  readonly path: string;
  readonly url: string;
  readonly body: string;
  readonly headers: string;
}

interface ServerOptions {
  readonly viewer?: Viewer;
  readonly accountExists?: boolean;
  readonly providers?: readonly { slug: string; name: string }[];
  readonly preview?: Record<string, unknown>;
  readonly inspect?: (call: number) => Response | Promise<Response>;
  readonly accept?: (call: number, body: Record<string, unknown>) => Response | Promise<Response>;
  readonly login?: () => Response | Promise<Response>;
  /** Who the session belongs to once a sign-in was answered with success; a second factor leaves it half signed in. */
  readonly afterLogin?: Viewer;
  /** Answers a call instead of the server when it returns a response. */
  readonly intercept?: (request: Request, call: number) => Response | Promise<Response> | undefined;
}

interface Server {
  readonly calls: Call[];
  readonly to: (method: string, path: string) => Call[];
  readonly viewer: () => Viewer;
}

const PREVIEW = {
  workspaceName: WORKSPACE,
  inviterName: "Ada Lovelace",
  email: INVITEE,
  role: "admin",
  accountExists: true,
};

function stubServer({ viewer: initial = "none", accountExists = true, providers, preview = {}, inspect, accept, login, afterLogin = "invitee", intercept }: ServerOptions = {}): Server {
  let viewer = initial;
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (request: Request) => {
    const { pathname, href } = new URL(request.url);
    const body = await request.clone().text();
    calls.push({
      method: request.method,
      path: pathname,
      url: href,
      body,
      headers: JSON.stringify([...request.headers.entries()]),
    });
    const count = calls.filter((call) => call.method === request.method && call.path === pathname).length;
    const intercepted = intercept?.(request, count);
    if (intercepted !== undefined) {
      return intercepted;
    }
    switch (pathname) {
      case "/api/config":
        return json(providers === undefined ? CONFIG_BODY : { ...CONFIG_BODY, signIn: { registration: false, oidc: providers } });
      case INSPECT_PATH:
        return inspect === undefined ? json({ ...PREVIEW, accountExists, ...preview }) : inspect(count);
      case ME_PATH:
        if (viewer === "none") {
          return problem(401, "unauthenticated", "req-me");
        }
        if (viewer === "partial") {
          return problem(401, "mfa_required", "req-me");
        }
        return json(meOf({ ...ACCOUNT_BODY, email: viewer === "invitee" ? INVITEE : ACCOUNT_BODY.email }));
      case SESSION_PATH:
        if (viewer === "partial") {
          return problem(401, "mfa_required", "req-session");
        }
        return viewer === "none" ? problem(401, "unauthenticated", "req-session") : json(SESSION_BODY);
      case WORKSPACES_PATH:
        return json(WORKSPACE_LIST_BODY);
      case LOGIN_PATH: {
        const response = login === undefined ? json({ next: "done" }) : await login();
        if (response.ok) {
          viewer = afterLogin;
        }
        return response;
      }
      case LOGOUT_PATH:
        viewer = "none";
        return new Response(null, { status: 204 });
      case ACCEPT_PATH: {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        const response = accept === undefined ? json({ workspaceId: "0192f3a0-cccc-7000-8000-000000000001", role: "admin" }, { status: "displayName" in parsed ? 201 : 200 }) : await accept(count, parsed);
        if (response.ok) {
          viewer = "invitee";
        }
        return response;
      }
      default:
        throw new Error(`unexpected call ${request.method} ${pathname}`);
    }
  });
  return {
    calls,
    to: (method, path) => calls.filter((call) => call.method === method && call.path === path),
    viewer: () => viewer,
  };
}

function bodyOf(call: Call): unknown {
  return JSON.parse(call.body) as unknown;
}

async function openInvite(path = INVITE_URL, strict = false): Promise<void> {
  window.history.replaceState(null, "", path);
  const App = createWebApp({ extensions: [] });
  await renderApp(strict ? <StrictMode><App /></StrictMode> : <App />);
}

function typeInto(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function press(name: string | RegExp): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
    await Promise.resolve();
  });
}

const HOME = `Welcome to ${PRODUCT_NAME}`;

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
  vi.mocked(navigateTo).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("lang");
});

describe("an invitation for the signed-in account", () => {
  it("shows the workspace, the inviter and the role, and joins with the token alone, then goes home", async () => {
    const server = stubServer({ viewer: "invitee" });
    await openInvite();

    expect(await screen.findByRole("heading", { level: 1, name: "You are invited" })).toBeTruthy();
    const main = screen.getByRole("main");
    expect(within(main).getByText(WORKSPACE)).toBeTruthy();
    expect(within(main).getByText("Ada Lovelace")).toBeTruthy();
    expect(main.querySelector("[data-slot='status-badge']")?.textContent).toBe("Admin");
    expect(screen.getByText(`You are signed in as ${INVITEE}.`)).toBeTruthy();

    await press(`Join ${WORKSPACE}`);

    expect(await screen.findByRole("heading", { level: 1, name: HOME })).toBeTruthy();
    expect(window.location.pathname).toBe("/");
    expect(server.to("POST", ACCEPT_PATH).map((call) => bodyOf(call))).toEqual([{ token: TOKEN }]);
  });

  it("matches the signed-in address to the invited one without regard to case", async () => {
    stubServer({ viewer: "invitee", preview: { email: "Grace@Example.ORG" } });
    await openInvite();

    expect(await screen.findByRole("button", { name: `Join ${WORKSPACE}` })).toBeTruthy();
  });

  it("renders the names of the invitation as text, never as markup", async () => {
    stubServer({ viewer: "invitee", preview: { workspaceName: '<img src="x" onerror="alert(1)">Acme', inviterName: "<b>Ada</b>" } });
    await openInvite();

    await screen.findByRole("heading", { level: 1, name: "You are invited" });
    const main = screen.getByRole("main");
    expect(main.textContent).toContain('<img src="x" onerror="alert(1)">Acme');
    expect(main.textContent).toContain("<b>Ada</b>");
    expect(main.querySelector("img")).toBeNull();
    expect(main.querySelector("b")).toBeNull();
  });

  it("leaves out the inviter once the inviting account is gone", async () => {
    stubServer({ viewer: "invitee", preview: { inviterName: null } });
    await openInvite();

    await screen.findByRole("button", { name: `Join ${WORKSPACE}` });
    expect(screen.queryByText("Invited by")).toBeNull();
  });

  it("tells a member who joined already, with the way home", async () => {
    stubServer({ viewer: "invitee", accept: () => problem(409, "already_member", "req-409") });
    await openInvite();
    await screen.findByRole("button", { name: `Join ${WORKSPACE}` });

    await press(`Join ${WORKSPACE}`);

    expect((await screen.findByRole("status")).textContent).toContain("You are already a member of this workspace.");
    expect(screen.getByRole("link", { name: "Go to Home" }).getAttribute("href")).toBe("/");
    expect(window.location.pathname).toBe(INVITE_URL);
  });

  it("says which address the account has to hold when the server refuses the account, and lets the visitor try again", async () => {
    const forbidden = () =>
      json(
        { type: "t", title: "forbidden", status: 403, code: "forbidden", detail: "x", requestId: "req-403", errors: [{ path: "token", code: "invitation_email_mismatch" }] },
        { status: 403, contentType: "application/problem+json" },
      );
    const server = stubServer({ viewer: "invitee", accept: (call) => (call === 1 ? forbidden() : json({ workspaceId: "w", role: "admin" })) });
    await openInvite();
    await screen.findByRole("button", { name: `Join ${WORKSPACE}` });

    await press(`Join ${WORKSPACE}`);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(`The invitation is for ${INVITEE}.`);
    expect(window.location.pathname).toBe(INVITE_URL);

    await press(`Join ${WORKSPACE}`);
    expect(await screen.findByRole("heading", { level: 1, name: HOME })).toBeTruthy();
    expect(server.to("POST", ACCEPT_PATH)).toHaveLength(2);
  });

  it.each([
    ["a full workspace", () => problem(422, "seat_limit_reached", "req-422"), "This workspace has no free seat."],
    ["a failing server", () => problem(500, "internal", "req-500"), "Joining is not possible right now."],
    ["a rate limit", () => problem(429, "rate_limited", "req-429"), "Too many attempts. Try again later."],
  ])("explains %s and stays on the page", async (_name, answer, message) => {
    stubServer({ viewer: "invitee", accept: answer });
    await openInvite();
    await screen.findByRole("button", { name: `Join ${WORKSPACE}` });

    await press(`Join ${WORKSPACE}`);

    expect((await screen.findByRole("alert")).textContent).toContain(message);
    expect(window.location.pathname).toBe(INVITE_URL);
    expect(screen.getByRole("button", { name: `Join ${WORKSPACE}` }).hasAttribute("data-loading")).toBe(false);
  });

  it("turns into the dead-link explanation when the server refuses the token while joining", async () => {
    stubServer({ viewer: "invitee", accept: () => problem(410, "token_expired", "req-410") });
    await openInvite();
    await screen.findByRole("button", { name: `Join ${WORKSPACE}` });

    await press(`Join ${WORKSPACE}`);

    expect(await screen.findByText("This invitation link does not work")).toBeTruthy();
    expect(screen.queryByRole("button", { name: `Join ${WORKSPACE}` })).toBeNull();
  });
});

describe("an invitation for someone else's account", () => {
  it("explains the mismatch and does not offer to join", async () => {
    stubServer({ viewer: "other" });
    await openInvite();

    expect(await screen.findByText("This invitation is for another address")).toBeTruthy();
    expect(screen.getByText(`You are signed in as ${ACCOUNT_BODY.email}, and the invitation is for ${INVITEE}. Sign out to continue with the invited address.`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: `Join ${WORKSPACE}` })).toBeNull();
  });

  it("signs out and then shows the sign-in form of the invited address on the same page", async () => {
    const server = stubServer({ viewer: "other" });
    await openInvite();
    await screen.findByText("This invitation is for another address");

    await press("Sign out and continue");

    expect(await screen.findByLabelText("Email")).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Email").value).toBe(INVITEE);
    expect(screen.queryByText("This invitation is for another address")).toBeNull();
    expect(server.to("POST", LOGOUT_PATH)).toHaveLength(1);
    expect(window.location.pathname).toBe(INVITE_URL);
    // Signing out read the invitation no second time.
    expect(server.to("POST", INSPECT_PATH)).toHaveLength(1);
  });

  it("shows the sign-up after signing out when the invited address has no account", async () => {
    stubServer({ viewer: "other", accountExists: false });
    await openInvite();
    await screen.findByText("This invitation is for another address");

    await press("Sign out and continue");

    expect(await screen.findByRole("button", { name: "Create account and join" })).toBeTruthy();
    expect(window.location.pathname).toBe(INVITE_URL);
  });

  it("stays on the mismatch when the sign-out did not go through", async () => {
    stubServer({ viewer: "other", intercept: (request) => (new URL(request.url).pathname === LOGOUT_PATH ? problem(500, "internal", "req-500") : undefined) });
    await openInvite();
    await screen.findByText("This invitation is for another address");

    await press("Sign out and continue");

    expect((await screen.findAllByText("You are still signed in")).length).toBeGreaterThan(0);
    expect(screen.getByText("This invitation is for another address")).toBeTruthy();
  });
});

describe("an invitation for an address without an account", () => {
  it("shows the short sign-up with the address fixed, and creates the account with the token, a name and a password", async () => {
    const server = stubServer({ accountExists: false });
    await openInvite();

    expect(await screen.findByRole("heading", { level: 1, name: "You are invited" })).toBeTruthy();
    const email = screen.getByLabelText<HTMLInputElement>("Email");
    expect(email.value).toBe(INVITEE);
    expect(email.readOnly).toBe(true);
    expect(screen.queryByText("or")).toBeNull();

    typeInto("Name", "  Grace Hopper ");
    typeInto("Password", "a long and unusual password");
    await press("Create account and join");

    expect(await screen.findByRole("heading", { level: 1, name: HOME })).toBeTruthy();
    expect(server.to("POST", ACCEPT_PATH).map((call) => bodyOf(call))).toEqual([
      { token: TOKEN, displayName: "Grace Hopper", password: "a long and unusual password" },
    ]);
    expect(window.location.pathname).toBe("/");
  });

  it("asks for a name and a password before it asks the server", async () => {
    const server = stubServer({ accountExists: false });
    await openInvite();
    await screen.findByRole("button", { name: "Create account and join" });

    await press("Create account and join");

    expect(screen.getByText("Enter your name.")).toBeTruthy();
    expect(screen.getByText("Enter a password.")).toBeTruthy();
    expect(server.to("POST", ACCEPT_PATH)).toHaveLength(0);
  });

  it("shows the password policy the server answered with and keeps the entries", async () => {
    stubServer({
      accountExists: false,
      accept: () =>
        json(
          { type: "t", title: "weak_password", status: 422, code: "weak_password", detail: "x", requestId: "req-422", errors: [{ path: "password", code: "too_short" }] },
          { status: 422, contentType: "application/problem+json" },
        ),
    });
    await openInvite();
    await screen.findByRole("button", { name: "Create account and join" });
    typeInto("Name", "Grace");
    typeInto("Password", "short");

    await press("Create account and join");

    expect(await screen.findByText("Use at least 12 characters.")).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("Grace");
    expect(window.location.pathname).toBe(INVITE_URL);
  });

  it.each([
    ["a refused registration", () => problem(403, "registration_refused", "req-403"), "An account cannot be created with this invitation."],
    ["a full workspace", () => problem(422, "seat_limit_reached", "req-422"), "This workspace has no free seat."],
    ["a failing server", () => problem(503, "unavailable", "req-503"), "Creating the account is not possible right now."],
  ])("explains %s", async (_name, answer, message) => {
    stubServer({ accountExists: false, accept: answer });
    await openInvite();
    await screen.findByRole("button", { name: "Create account and join" });
    typeInto("Name", "Grace");
    typeInto("Password", "a long and unusual password");

    await press("Create account and join");

    expect((await screen.findByRole("alert")).textContent).toContain(message);
    expect(window.location.pathname).toBe(INVITE_URL);
  });

  it("switches to the sign-in form when an account holds the address after all", async () => {
    stubServer({ accountExists: false, accept: () => problem(409, "email_taken", "req-409") });
    await openInvite();
    await screen.findByRole("button", { name: "Create account and join" });
    typeInto("Name", "Grace");
    typeInto("Password", "a long and unusual password");

    await press("Create account and join");

    expect(await screen.findByText(`${INVITEE} already has an account. Sign in to join.`)).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Email").value).toBe(INVITEE);
  });

  it("lists the configured providers under the form; they start the handshake of the invitation, which carries the token in its own parameter and no page to come back to", async () => {
    stubServer({ accountExists: false, providers: [{ slug: "acme", name: "Acme SSO" }] });
    await openInvite();

    await screen.findByRole("button", { name: "Create account and join" });
    expect(screen.getByText("or")).toBeTruthy();
    expect(screen.getByText(`Use an account at a provider that has confirmed ${INVITEE}.`)).toBeTruthy();
    await press("Continue with Acme SSO");

    expect(navigateTo).toHaveBeenCalledExactlyOnceWith(`/api/v1/auth/oidc/acme/start?intent=invite&invitation=${TOKEN}`);
  });

  it("lists them for an address that has an account too, under the sign-in form", async () => {
    stubServer({ accountExists: true, providers: [{ slug: "acme", name: "Acme SSO" }, { slug: "other-idp", name: "Other IdP" }] });
    await openInvite();

    await screen.findByLabelText("Email");
    expect(screen.getByText("or")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Continue with/ }).map((button) => button.textContent)).toEqual(["Continue with Acme SSO", "Continue with Other IdP"]);
    await press("Continue with Other IdP");

    expect(navigateTo).toHaveBeenCalledExactlyOnceWith(`/api/v1/auth/oidc/other-idp/start?intent=invite&invitation=${TOKEN}`);
  });

  it("shows no provider buttons and no separator where no provider is configured", async () => {
    stubServer({ accountExists: false, providers: [] });
    await openInvite();

    await screen.findByRole("button", { name: "Create account and join" });
    expect(screen.queryByRole("button", { name: /^Continue with/ })).toBeNull();
    expect(screen.queryByText("or")).toBeNull();
  });

  it("shows no provider buttons to a signed-in account, which joins with one button or is told to sign out", async () => {
    stubServer({ viewer: "invitee", providers: [{ slug: "acme", name: "Acme SSO" }] });
    await openInvite();

    await screen.findByRole("button", { name: `Join ${WORKSPACE}` });
    expect(screen.queryByRole("button", { name: /^Continue with/ })).toBeNull();
  });

  it("has no accessibility violations", async () => {
    stubServer({ accountExists: false, providers: [{ slug: "acme", name: "Acme SSO" }] });
    await openInvite();
    await screen.findByRole("button", { name: "Create account and join" });

    expect((await axe(document.body, { rules: { region: { enabled: false } } })).violations.map(({ id }) => id)).toEqual([]);
  });
});

describe("an invitation for an address with an account, signed out", () => {
  it("shows the sign-in form with the invited address, stays on the page after signing in and then offers to join", async () => {
    const server = stubServer({ accountExists: true });
    await openInvite();

    expect(await screen.findByText(`${INVITEE} already has an account. Sign in to join.`)).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Email").value).toBe(INVITEE);
    typeInto("Password", "correct horse");
    await press("Sign in");

    expect(await screen.findByRole("button", { name: `Join ${WORKSPACE}` })).toBeTruthy();
    expect(window.location.pathname).toBe(INVITE_URL);
    expect(server.to("POST", LOGIN_PATH).map((call) => bodyOf(call))).toEqual([{ email: INVITEE, password: "correct horse", remember: false }]);
    // The invitation was read once, and the sign-in did not read it again.
    expect(server.to("POST", INSPECT_PATH)).toHaveLength(1);

    await press(`Join ${WORKSPACE}`);
    expect(await screen.findByRole("heading", { level: 1, name: HOME })).toBeTruthy();
  });

  it("returns to this page after the second factor", async () => {
    stubServer({ accountExists: true, login: () => json({ next: "mfa" }), afterLogin: "partial" });
    await openInvite();
    await screen.findByText(`${INVITEE} already has an account. Sign in to join.`);
    typeInto("Password", "correct horse");

    await press("Sign in");

    await waitFor(() => {
      expect(window.location.pathname).toBe("/login/mfa");
    });
    expect(new URLSearchParams(window.location.search).get("next")).toBe(INVITE_URL);
  });

  it("does not send the visitor to sign in or say that a session ended", async () => {
    stubServer({ accountExists: true });
    await openInvite();

    await screen.findByText(`${INVITEE} already has an account. Sign in to join.`);
    expect(window.location.pathname).toBe(INVITE_URL);
    expect(screen.queryByText("Your session has ended")).toBeNull();
  });
});

describe("a session that passed the password only", () => {
  it("is taken to the second step, which returns to the invitation", async () => {
    stubServer({ viewer: "partial" });
    await openInvite();

    await waitFor(() => {
      expect(window.location.pathname).toBe("/login/mfa");
    });
    expect(new URLSearchParams(window.location.search).get("next")).toBe(INVITE_URL);
  });
});

describe("an instance that has no account yet", () => {
  it("sends the visitor to set it up, and reads nothing of the invitation", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (request: Request) => {
      const { pathname } = new URL(request.url);
      calls.push(pathname);
      return Promise.resolve(pathname === "/api/config" ? json({ ...CONFIG_BODY, setupRequired: true, setupTokenRequired: false }) : problem(404, "not_found", "req-404"));
    });
    await openInvite();

    await waitFor(() => {
      expect(window.location.pathname).toBe("/setup");
    });
    expect(calls).not.toContain(INSPECT_PATH);
  });
});

describe("a link that does not work", () => {
  it("gives one explanation with a link to sign in, and nothing about the invitation", async () => {
    stubServer({ inspect: () => problem(410, "token_expired", "req-410", `invitation of ${INVITEE} was revoked`) });
    await openInvite();

    expect(await screen.findByText("This invitation link does not work")).toBeTruthy();
    const main = screen.getByRole("main");
    expect(main.textContent).toContain("An invitation link works once and only for a limited time.");
    expect(main.textContent).not.toMatch(/revoked|expired|used/i);
    expect(main.textContent).not.toContain(INVITEE);
    expect(within(main).getByRole("link", { name: "Go to sign in" }).getAttribute("href")).toBe("/login");
    expect(screen.queryByRole("button", { name: /join|create account/i })).toBeNull();
  });

  it("is written in German", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-AT"]);
    stubServer({ inspect: () => problem(410, "token_expired", "req-410") });
    await openInvite();

    expect(await screen.findByText("Dieser Einladungslink funktioniert nicht")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Zur Anmeldung" })).toBeTruthy();
  });

  it("offers another try when the invitation cannot be read, and shows it once the server answers", async () => {
    const server = stubServer({ inspect: (call) => (call === 1 ? problem(500, "internal", "req-500") : json({ ...PREVIEW, accountExists: false })) });
    await openInvite();

    expect((await screen.findByRole("alert")).textContent).toContain("The invitation cannot be shown right now.");
    await press("Try again");

    expect(await screen.findByRole("button", { name: "Create account and join" })).toBeTruthy();
    expect(server.to("POST", INSPECT_PATH)).toHaveLength(2);
  });

  it("shows the wait of a rate limit", async () => {
    stubServer({
      inspect: () =>
        new Response(JSON.stringify({ type: "t", title: "rate_limited", status: 429, code: "rate_limited", detail: "d", requestId: "r" }), {
          status: 429,
          headers: { "Content-Type": "application/problem+json", "Retry-After": "120" },
        }),
    });
    await openInvite();

    expect((await screen.findByRole("alert")).textContent).toContain("Too many attempts. Try again in 2 minutes.");
  });

  it("offers another try when the account cannot be looked up, without reading the invitation again", async () => {
    const server = stubServer({
      viewer: "invitee",
      intercept: (request, call) => (new URL(request.url).pathname === ME_PATH && call === 1 ? problem(500, "internal", "req-500") : undefined),
    });
    await openInvite();

    expect((await screen.findByRole("alert")).textContent).toContain("The invitation cannot be shown right now.");
    await press("Try again");

    expect(await screen.findByRole("button", { name: `Join ${WORKSPACE}` })).toBeTruthy();
    expect(server.to("POST", INSPECT_PATH)).toHaveLength(1);
  });

  it("shows the sign-in page for a visitor who follows the link", async () => {
    stubServer({ inspect: () => problem(410, "token_expired", "req-410") });
    await openInvite();
    await screen.findByText("This invitation link does not work");

    fireEvent.click(screen.getByRole("link", { name: "Go to sign in" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeTruthy();
  });
});

describe("the token", () => {
  it("reaches only the two invitation operations", async () => {
    const server = stubServer({ viewer: "invitee" });
    await openInvite();
    await screen.findByRole("button", { name: `Join ${WORKSPACE}` });
    await press(`Join ${WORKSPACE}`);
    await screen.findByRole("heading", { level: 1, name: HOME });

    const carrying = server.calls.filter((call) => `${call.url}${call.body}${call.headers}`.includes(TOKEN));
    expect(carrying.length).toBeGreaterThan(0);
    for (const call of carrying) {
      expect([INSPECT_PATH, ACCEPT_PATH]).toContain(call.path);
      expect(call.method).toBe("POST");
      expect(call.url).not.toContain(TOKEN);
    }
  });

  it("is sent to the start of a handshake and to no request of the page when a provider is chosen", async () => {
    const server = stubServer({ accountExists: false, providers: [{ slug: "acme", name: "Acme SSO" }] });
    await openInvite();
    await screen.findByRole("button", { name: "Create account and join" });

    await press("Continue with Acme SSO");

    expect(navigateTo).toHaveBeenCalledExactlyOnceWith(`/api/v1/auth/oidc/acme/start?intent=invite&invitation=${TOKEN}`);
    const carrying = server.calls.filter((call) => `${call.url}${call.body}${call.headers}`.includes(TOKEN));
    expect(carrying.map((call) => call.path)).toEqual([INSPECT_PATH]);
  });

  it("is not sent anywhere when the visitor signs out", async () => {
    const server = stubServer({ viewer: "other" });
    await openInvite();
    await screen.findByText("This invitation is for another address");

    await press("Sign out and continue");
    await screen.findByLabelText("Email");

    const carrying = server.calls.filter((call) => `${call.url}${call.body}${call.headers}`.includes(TOKEN));
    expect(carrying.map((call) => call.path)).toEqual([INSPECT_PATH]);
  });

  it("is read once per visit, also where the effect runs twice", async () => {
    const server = stubServer({ accountExists: false });
    await openInvite(INVITE_URL, true);

    await screen.findByRole("button", { name: "Create account and join" });
    expect(server.to("POST", INSPECT_PATH)).toHaveLength(1);
    expect(server.to("GET", ME_PATH)).toHaveLength(1);
  });

  it.each([
    ["the sign-up", { accountExists: false }, "Create account and join"],
    ["the sign-in", { accountExists: true }, "Sign in"],
    ["the join", { viewer: "invitee" as const }, `Join ${WORKSPACE}`],
    ["the mismatch", { viewer: "other" as const }, "Sign out and continue"],
    ["the dead link", { inspect: () => problem(410, "token_expired", "r") }, "Go to sign in"],
  ])("is not in the title of the document or the text of %s", async (_name, options, control) => {
    stubServer(options);
    await openInvite();

    await screen.findByText(control, { selector: "button, a" });
    expect(document.title).not.toContain(TOKEN);
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(new XMLSerializer().serializeToString(document.body)).not.toContain(TOKEN);
  });

  it("makes the page send no referrer while it is open, and its links carry the same policy", async () => {
    stubServer({ inspect: () => problem(410, "token_expired", "req-410") });
    await openInvite();

    await screen.findByText("This invitation link does not work");
    expect(document.head.querySelector("meta[name='referrer']")?.getAttribute("content")).toBe("no-referrer");
    const link = screen.getByRole("link", { name: "Go to sign in" });
    expect(link.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(link.getAttribute("rel")).toContain("noreferrer");

    fireEvent.click(link);
    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    expect(document.head.querySelector("meta[name='referrer']")).toBeNull();
  });

  it("stays out of the console and off the error page when the page itself fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // A name that is not text makes the page fail while it renders.
    stubServer({ viewer: "invitee", preview: { workspaceName: { not: "text" } } });
    await openInvite();

    expect(await screen.findByRole("heading", { level: 1, name: "Something went wrong" })).toBeTruthy();
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(document.title).not.toContain(TOKEN);
    for (const call of [...warn.mock.calls, ...error.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain(TOKEN);
    }
  });
});
