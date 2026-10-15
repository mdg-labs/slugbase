import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { createWebApp } from "../src/index.ts";
import { CONFIG_BODY, PRODUCT_NAME, SESSION_PATH, json, problem, renderApp, signedIn, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// /setup (doc 03 section 1.1, doc 04 section 10.2). The failure scenarios are a wizard that is reachable
// once setup is done, a signed-out route that does not lead to it while setup is pending, a server refusal
// that is shown on the wrong step or not at all, and a setup that reads as done when the server refused it.

type Transport = (request: Request) => Promise<Response>;

const SETUP_PATH = "/api/v1/setup";
const WORKSPACE_ID = "0192f3a0-dddd-7000-8000-000000000001";

interface Server {
  readonly fetch: ReturnType<typeof vi.fn<Transport>>;
  /** The paths the app asked for, in order. */
  readonly paths: () => string[];
  /** The JSON bodies the setup received. */
  readonly setups: () => Promise<unknown[]>;
}

interface ServerOptions {
  /** The `setupRequired` of the configuration; `"absent"` leaves it out. */
  setupRequired?: boolean | "absent";
  /** The `setupTokenRequired` of the configuration; true by default. */
  tokenRequired?: boolean;
  /** Answers the setup; by default it succeeds. */
  setup?: Transport;
}

/** A server with no account until a setup is answered with `201`; then the visitor is signed in. */
function stubServer({ setupRequired = true, tokenRequired = true, setup }: ServerOptions = {}): Server {
  let signed = false;
  const received: Request[] = [];
  const fetch = vi.fn<Transport>((request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/config") {
      return Promise.resolve(json(setupRequired === "absent" ? CONFIG_BODY : { ...CONFIG_BODY, setupRequired, setupTokenRequired: setupRequired && tokenRequired }));
    }
    if (pathname === SETUP_PATH) {
      received.push(request.clone());
      const answer = setup?.(request) ?? Promise.resolve(json({ workspaceId: WORKSPACE_ID }, { status: 201 }));
      return answer.then((response) => {
        signed ||= response.ok;
        return response;
      });
    }
    if (pathname === SESSION_PATH && !signed) {
      return Promise.resolve(problem(401, "unauthenticated", "req-session"));
    }
    return signedIn(request);
  });
  vi.stubGlobal("fetch", fetch);
  return {
    fetch,
    paths: () => fetch.mock.calls.map(([request]) => new URL(request.url).pathname),
    setups: () => Promise.all(received.map((request) => request.json() as Promise<unknown>)),
  };
}

async function open(path = "/setup"): Promise<void> {
  window.history.replaceState(null, "", path);
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
}

async function openWizard(): Promise<void> {
  await open();
  await screen.findByRole("heading", { level: 1, name: `Set up ${PRODUCT_NAME}` });
}

function typeInto(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function press(name: RegExp | string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
    await Promise.resolve();
  });
}

function step(): string {
  return screen.getByRole("progressbar").getAttribute("aria-valuetext") ?? "";
}

async function toStep2(token = "tok-printed"): Promise<void> {
  typeInto("Setup token", token);
  await press(/^Next/);
}

async function toStep3(): Promise<void> {
  await toStep2("tok-printed");
  await fillAccount();
}

async function fillAccount(): Promise<void> {
  typeInto("Name", "  Ada Lovelace ");
  typeInto("Email", " ada@example.org ");
  typeInto("Password", "correct horse battery staple");
  await press(/^Next/);
}

async function finish(): Promise<void> {
  typeInto("Workspace name", " Home ");
  await press(/^Create account/);
}

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("lang");
});

describe("while the instance has no account", () => {
  it.each(["/", "/settings/account/security", "/missing", "/login", "/login?next=%2Fsettings"])(
    "sends a signed-out visitor of %s to the wizard without asking for a session",
    async (path) => {
      const server = stubServer();

      await open(path);

      expect(await screen.findByRole("heading", { level: 1, name: `Set up ${PRODUCT_NAME}` })).toBeTruthy();
      expect(window.location.pathname).toBe("/setup");
      expect(window.location.search).toBe("");
      expect(server.paths()).not.toContain(SESSION_PATH);
      expect(screen.queryByRole("heading", { name: "Sign in" })).toBeNull();
      expect(screen.queryByText("Your session has ended")).toBeNull();
    },
  );
});

describe("once the instance has an account", () => {
  it.each([false, "absent" as const])("shows the not-found page at /setup when setupRequired is %s", async (setupRequired) => {
    stubServer({ setupRequired });

    await open("/setup");

    expect(await screen.findByRole("heading", { level: 1, name: "This page doesn't exist" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: `Set up ${PRODUCT_NAME}` })).toBeNull();
    expect(screen.queryByLabelText("Setup token")).toBeNull();
  });

  it("still sends a signed-out visitor to sign in", async () => {
    stubServer({ setupRequired: false });

    await open("/");

    expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeTruthy();
    expect(window.location.pathname).toBe("/login");
  });
});

describe("the wizard", () => {
  it("starts on the token step with a note that the token is in the server log", async () => {
    stubServer();
    await openWizard();

    expect(step()).toBe("Step 1 of 3");
    expect(screen.getByRole("heading", { level: 2, name: "Setup token" })).toBeTruthy();
    expect(screen.getByRole("note").textContent).toContain("printed the setup token to its log");
    expect(document.activeElement).toBe(screen.getByLabelText("Setup token"));
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.getByRole("button", { name: "Next" })).toBeTruthy();
  });

  it("collects the account on step 2 and the workspace on step 3, and Back keeps what was typed", async () => {
    stubServer();
    await openWizard();

    await toStep2("tok-printed");
    expect(step()).toBe("Step 2 of 3");
    expect(screen.getByLabelText<HTMLInputElement>("Email").type).toBe("email");
    expect(screen.getByLabelText<HTMLInputElement>("Password").type).toBe("password");
    typeInto("Name", "Ada Lovelace");
    typeInto("Email", "ada@example.org");
    typeInto("Password", "correct horse battery staple");
    await press(/^Next/);
    expect(step()).toBe("Step 3 of 3");
    expect(screen.getByRole("button", { name: "Create account" })).toBeTruthy();

    await press("Back");
    expect(step()).toBe("Step 2 of 3");
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("Ada Lovelace");
    await press("Back");
    expect(screen.getByLabelText<HTMLInputElement>("Setup token").value).toBe("tok-printed");
  });

  it("shows the strength of the password as it is typed", async () => {
    stubServer();
    await openWizard();
    await toStep2();

    expect(screen.queryByRole("meter")).toBeNull();
    typeInto("Password", "abc");
    expect(screen.getByRole("meter", { name: "Password strength" }).getAttribute("aria-valuetext")).toBe("Very weak");
    typeInto("Password", "correct horse battery staple 7!");
    expect(screen.getByRole("meter", { name: "Password strength" }).getAttribute("aria-valuenow")).toBe("4");
  });

  it("does not leave step 2 or finish step 3 with a required field empty", async () => {
    const server = stubServer();
    await openWizard();
    await toStep2();

    await press(/^Next/);
    expect(step()).toBe("Step 2 of 3");
    expect(screen.getByText("Enter your name.")).toBeTruthy();
    expect(screen.getByText("Enter your email address.")).toBeTruthy();
    expect(screen.getByText("Enter a password.")).toBeTruthy();
    expect(screen.getByLabelText("Name").getAttribute("aria-invalid")).toBe("true");

    typeInto("Name", "Ada");
    expect(screen.queryByText("Enter your name.")).toBeNull();
    typeInto("Email", "ada@example.org");
    typeInto("Password", "correct horse battery staple");
    await press(/^Next/);
    await press(/^Create account/);

    expect(step()).toBe("Step 3 of 3");
    expect(screen.getByText("Enter a name for the workspace.")).toBeTruthy();
    expect(server.paths()).not.toContain(SETUP_PATH);
  });
});

describe("the token step", () => {
  it("does not go on without the token when the server requires one", async () => {
    const server = stubServer();
    await openWizard();

    typeInto("Setup token", "   ");
    await press(/^Next/);

    expect(step()).toBe("Step 1 of 3");
    expect(screen.getByText("Enter the setup token.")).toBeTruthy();
    expect(screen.getByLabelText("Setup token").getAttribute("aria-invalid")).toBe("true");
    typeInto("Setup token", "tok-printed");
    expect(screen.queryByText("Enter the setup token.")).toBeNull();
    await press(/^Next/);
    expect(step()).toBe("Step 2 of 3");
    expect(server.paths()).not.toContain(SETUP_PATH);
  });

  it("is left out when the server requires no token: two steps, the account first, and no token sent", async () => {
    const server = stubServer({ tokenRequired: false });
    await openWizard();

    expect(step()).toBe("Step 1 of 2");
    expect(screen.getByRole("heading", { level: 2, name: "Your account" })).toBeTruthy();
    expect(screen.queryByLabelText("Setup token")).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));

    await fillAccount();
    expect(step()).toBe("Step 2 of 2");
    expect(screen.getByRole("button", { name: "Create account" })).toBeTruthy();
    await press("Back");
    expect(step()).toBe("Step 1 of 2");
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    await press(/^Next/);
    await finish();

    expect(await screen.findByRole("heading", { level: 2, name: "You are all set" })).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Setup complete" }).getAttribute("aria-valuenow")).toBe("2");
    const [body] = await server.setups();
    expect(body).not.toHaveProperty("setupToken");
  });

  it("stays on the workspace step when a server that asked for no token refuses one", async () => {
    stubServer({ tokenRequired: false, setup: () => Promise.resolve(problem(403, "forbidden", "req-7")) });
    await openWizard();
    await fillAccount();

    await finish();

    expect((await screen.findByRole("alert")).textContent).toContain("Setup is not possible right now.");
    expect(step()).toBe("Step 2 of 2");
    expect(screen.queryByLabelText("Setup token")).toBeNull();
  });

  it("sends the trimmed token when the server requires one", async () => {
    const server = stubServer();
    await openWizard();
    await toStep2("  tok-printed ");
    await fillAccount();

    await finish();

    await screen.findByRole("heading", { level: 2, name: "You are all set" });
    const [body] = await server.setups();
    expect(body).toHaveProperty("setupToken", "tok-printed");
  });
});

describe("a setup that goes through", () => {
  it("sends the trimmed values and the token, then shows the closing note and leads to Home", async () => {
    const server = stubServer();
    await openWizard();
    await toStep3();

    await finish();

    expect(await server.setups()).toEqual([
      {
        setupToken: "tok-printed",
        displayName: "Ada Lovelace",
        email: "ada@example.org",
        password: "correct horse battery staple",
        workspaceName: "Home",
      },
    ]);
    expect(await screen.findByRole("heading", { level: 2, name: "You are all set" })).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Setup complete" }).getAttribute("aria-valuenow")).toBe("3");
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    const note = screen.getByRole("note");
    expect(note.textContent).toContain("two-factor authentication");
    expect(within(note).getByRole("link", { name: "Open security settings" }).getAttribute("href")).toBe("/settings/account/security");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Go to Home" }));
      await Promise.resolve();
    });

    expect(await screen.findByRole("heading", { level: 1, name: `Welcome to ${PRODUCT_NAME}` })).toBeTruthy();
    expect(window.location.pathname).toBe("/");
  });

  it("opens the security page from the closing note, signed in", async () => {
    stubServer();
    await openWizard();
    await toStep3();
    await finish();
    await screen.findByRole("heading", { level: 2, name: "You are all set" });

    await act(async () => {
      fireEvent.click(screen.getByRole("link", { name: "Open security settings" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(window.location.pathname).toBe("/settings/account/security");
    });
    expect(screen.queryByRole("heading", { name: `Set up ${PRODUCT_NAME}` })).toBeNull();
  });

  it("shows the wizard as busy while the request runs and sends it once", async () => {
    let answer: (response: Response) => void = () => undefined;
    const server = stubServer({ setup: () => new Promise<Response>((resolve) => (answer = resolve)) });
    await openWizard();
    await toStep3();
    typeInto("Workspace name", "Home");

    await press(/^Create account/);
    fireEvent.submit(screen.getByLabelText("Workspace name").closest("form") ?? document.body);

    expect(screen.getByRole("button", { name: /^Create account/ }).hasAttribute("data-loading")).toBe(true);
    expect(screen.getByRole("button", { name: "Back" }).hasAttribute("disabled")).toBe(true);
    expect(await server.setups()).toHaveLength(1);
    await act(async () => {
      answer(json({ workspaceId: WORKSPACE_ID }, { status: 201 }));
      await Promise.resolve();
    });
    expect(await screen.findByRole("heading", { level: 2, name: "You are all set" })).toBeTruthy();
  });
});

describe("a setup the server refuses", () => {
  it("returns to the token step for a wrong token and keeps what was typed", async () => {
    stubServer({ setup: () => Promise.resolve(problem(403, "forbidden", "req-1", "token abc is wrong")) });
    await openWizard();
    await toStep3();

    await finish();

    expect(await screen.findByText(/The setup token is missing or wrong/)).toBeTruthy();
    expect(step()).toBe("Step 1 of 3");
    expect(screen.getByLabelText("Setup token").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByLabelText<HTMLInputElement>("Setup token").value).toBe("tok-printed");
    expect(document.body.textContent).not.toContain("token abc is wrong");
    expect(screen.queryByRole("heading", { name: "You are all set" })).toBeNull();

    typeInto("Setup token", "tok-new");
    expect(screen.queryByText(/The setup token is missing or wrong/)).toBeNull();
    await press(/^Next/);
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("  Ada Lovelace ");
  });

  it("says setup is completed in place, on the step it was sent from, and leads to sign in", async () => {
    stubServer({ setup: () => Promise.resolve(problem(403, "setup_completed", "req-2")) });
    await openWizard();
    await toStep3();

    await finish();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Setup was already completed on this server.");
    expect(step()).toBe("Step 3 of 3");
    expect(screen.queryByRole("heading", { name: "You are all set" })).toBeNull();

    await press("Go to sign in");

    expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeTruthy();
    expect(window.location.pathname).toBe("/login");
  });

  it.each([
    ["too_short", "Use at least 12 characters."],
    ["too_long", "Use at most 256 characters."],
    ["breached", "This password appears in a list of breached passwords. Choose a different one."],
    ["something_else", "Choose a stronger password."],
  ])("returns to the account step with the reason in the password field for a %s refusal", async (code, message) => {
    stubServer({
      setup: () =>
        Promise.resolve(
          json(
            {
              type: "t",
              title: "weak_password",
              status: 422,
              code: "weak_password",
              detail: "d",
              requestId: "r",
              errors: [{ path: "password", code }],
            },
            { status: 422, contentType: "application/problem+json" },
          ),
        ),
    });
    await openWizard();
    await toStep3();

    await finish();

    expect(await screen.findByText(message)).toBeTruthy();
    expect(step()).toBe("Step 2 of 3");
    expect(screen.getByLabelText("Password").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByLabelText<HTMLInputElement>("Password").value).toBe("correct horse battery staple");
    expect(screen.queryByRole("heading", { name: "You are all set" })).toBeNull();
  });

  it("shows a weak password with no field errors on the account step too", async () => {
    stubServer({ setup: () => Promise.resolve(problem(422, "weak_password", "req-3")) });
    await openWizard();
    await toStep3();

    await finish();

    expect(await screen.findByText("Choose a stronger password.")).toBeTruthy();
    expect(step()).toBe("Step 2 of 3");
  });

  it("stays on the workspace step for a refused workspace name", async () => {
    stubServer({
      setup: () =>
        Promise.resolve(
          json(
            {
              type: "t",
              title: "validation_failed",
              status: 422,
              code: "validation_failed",
              detail: "d",
              requestId: "r",
              errors: [{ path: "workspaceName", code: "too_small" }],
            },
            { status: 422, contentType: "application/problem+json" },
          ),
        ),
    });
    await openWizard();
    await toStep3();

    await finish();

    expect(await screen.findByText("Check the workspace name.")).toBeTruthy();
    expect(step()).toBe("Step 3 of 3");
  });

  it("returns to the account step for a refused email", async () => {
    stubServer({
      setup: () =>
        Promise.resolve(
          json(
            {
              type: "t",
              title: "validation_failed",
              status: 422,
              code: "validation_failed",
              detail: "d",
              requestId: "r",
              errors: [{ path: "email", code: "invalid_format" }],
            },
            { status: 422, contentType: "application/problem+json" },
          ),
        ),
    });
    await openWizard();
    await toStep3();

    await finish();

    expect(await screen.findByText("Check the email address.")).toBeTruthy();
    expect(step()).toBe("Step 2 of 3");
  });

  it.each([
    [42, "Too many setup attempts. Try again in 42 seconds."],
    [120, "Too many setup attempts. Try again in 2 minutes."],
  ])("shows the wait of a Retry-After of %s seconds and stays on the step", async (seconds, message) => {
    stubServer({
      setup: () =>
        Promise.resolve(
          new Response(JSON.stringify({ type: "t", title: "rate_limited", status: 429, code: "rate_limited", detail: "d", requestId: "r" }), {
            status: 429,
            headers: { "Content-Type": "application/problem+json", "Retry-After": String(seconds) },
          }),
        ),
    });
    await openWizard();
    await toStep3();

    await finish();

    expect((await screen.findByRole("alert")).textContent).toContain(message);
    expect(step()).toBe("Step 3 of 3");
    expect(screen.getByRole("button", { name: /^Create account/ }).hasAttribute("data-loading")).toBe(false);
  });

  it("says to try later when a 429 names no wait", async () => {
    stubServer({ setup: () => Promise.resolve(problem(429, "rate_limited", "req-4")) });
    await openWizard();
    await toStep3();

    await finish();

    expect((await screen.findByRole("alert")).textContent).toContain("Too many setup attempts. Try again later.");
  });

  it.each([
    ["an unavailable service", () => Promise.resolve(problem(503, "unavailable", "req-5", "database password is x"))],
    ["a network failure", () => Promise.reject(new TypeError("fetch failed"))],
    ["an answer without a problem document", () => Promise.resolve(new Response("oops", { status: 500 }))],
    ["a cross-site refusal", () => Promise.resolve(problem(403, "cross_site_request", "req-6"))],
  ])("says setup is not possible right now for %s, and can be tried again", async (_name, answer) => {
    let calls = 0;
    stubServer({
      setup: () => {
        calls += 1;
        return calls === 1 ? answer() : Promise.resolve(json({ workspaceId: WORKSPACE_ID }, { status: 201 }));
      },
    });
    await openWizard();
    await toStep3();

    await finish();

    expect((await screen.findByRole("alert")).textContent).toContain("Setup is not possible right now.");
    expect(document.body.textContent).not.toContain("database password");
    expect(step()).toBe("Step 3 of 3");
    expect(screen.queryByRole("heading", { name: "You are all set" })).toBeNull();

    await press(/^Create account/);

    expect(await screen.findByRole("heading", { level: 2, name: "You are all set" })).toBeTruthy();
  });
});

describe("the wizard on a phone and in German", () => {
  it("is written in German", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-AT"]);
    stubServer();
    await open();

    expect(await screen.findByRole("heading", { level: 1, name: `${PRODUCT_NAME} einrichten` })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Einrichtungs-Token" })).toBeTruthy();
    expect(step()).toBe("Schritt 1 von 3");
    expect(screen.getByRole("button", { name: "Weiter" })).toBeTruthy();
  });

  it.each(["light", "dark"] as const)("has no axe violations on any step in the %s theme", async (theme) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    stubServer();
    await openWizard();
    const check = async (): Promise<void> => {
      expect((await axe(document.body, { rules: { region: { enabled: false } } })).violations.map(({ id }) => id)).toEqual([]);
    };

    await check();
    await toStep2();
    await check();
    typeInto("Name", "Ada");
    typeInto("Email", "ada@example.org");
    typeInto("Password", "correct horse battery staple");
    await press(/^Next/);
    await check();
  });
});
