import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebApp } from "../src/index.ts";
import type { WebExtension } from "../src/index.ts";
import { CONFIG_BODY, PRODUCT_NAME, SESSION_PATH, json, problem, renderApp, signedIn, stubBrowserApis, stubMatchMedia } from "./support.tsx";

type Transport = (request: Request) => Promise<Response>;

const REGISTER_PATH = "/api/v1/auth/register";
const RESEND_PATH = "/api/v1/auth/verify-email/resend";
const PASSWORD = "correct horse battery staple";

const MAIL = { ai: false, mail: true };
const OPEN = { ...CONFIG_BODY, features: MAIL, signIn: { registration: true, oidc: [] } };
const OPEN_WITHOUT_MAIL = { ...CONFIG_BODY, features: { ai: false, mail: false }, signIn: { registration: true, oidc: [] } };
const CLOSED = { ...CONFIG_BODY, signIn: { registration: false, oidc: [] } };

interface Server {
  readonly registrations: () => Promise<unknown[]>;
  readonly resends: () => Promise<unknown[]>;
}

/** A server with nobody signed in; `register` and `resend` answer the two calls the page makes. */
function stubServer(config: object, register: Transport, resend: Transport = () => Promise.resolve(new Response(null, { status: 202 }))): Server {
  const registered: Request[] = [];
  const resent: Request[] = [];
  vi.stubGlobal("fetch", (request: Request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/config") {
      return Promise.resolve(json(config));
    }
    if (pathname === REGISTER_PATH) {
      registered.push(request.clone());
      return register(request);
    }
    if (pathname === RESEND_PATH) {
      resent.push(request.clone());
      return resend(request);
    }
    return pathname === SESSION_PATH ? Promise.resolve(problem(401, "unauthenticated", "req-session")) : signedIn(request);
  });
  return {
    registrations: () => Promise.all(registered.map((request) => request.json() as Promise<unknown>)),
    resends: () => Promise.all(resent.map((request) => request.json() as Promise<unknown>)),
  };
}

const accepted = (): Promise<Response> => Promise.resolve(new Response(null, { status: 202 }));

function rateLimited(seconds: number): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify({ type: "t", title: "rate_limited", status: 429, code: "rate_limited", detail: "d", requestId: "r" }), {
      status: 429,
      headers: { "Content-Type": "application/problem+json", "Retry-After": String(seconds) },
    }),
  );
}

async function openRegister(extensions: readonly WebExtension[] = []): Promise<void> {
  window.history.replaceState(null, "", "/register");
  const App = createWebApp({ extensions });
  await renderApp(<App />);
  await screen.findByRole("heading", { level: 1 });
}

function typeInto(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function submit(): Promise<void> {
  await act(async () => {
    fireEvent.submit(screen.getByRole("button", { name: "Create account" }).closest("form") ?? document.body);
    await Promise.resolve();
  });
}

async function fillAndSubmit(): Promise<void> {
  typeInto("Name", " Ada Lovelace ");
  typeInto("Email", " ada@example.org ");
  typeInto("Password", PASSWORD);
  await submit();
}

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("lang");
});

describe("the registration page", () => {
  it("collects the name, the email and the password with the strength meter", async () => {
    stubServer(OPEN, accepted);
    await openRegister();

    expect(screen.getByRole("heading", { level: 1, name: "Create an account" })).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Name").autocomplete).toBe("name");
    expect(screen.getByLabelText<HTMLInputElement>("Email").type).toBe("email");
    expect(screen.getByLabelText<HTMLInputElement>("Password").type).toBe("password");
    expect(screen.queryByRole("meter")).toBeNull();

    typeInto("Password", PASSWORD);

    expect(screen.getByRole("meter", { name: "Password strength" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Already have an account? Sign in" }).getAttribute("href")).toBe("/login");
  });

  it("renders the slot auth.register.footer under the form, and nothing when no extension fills it", async () => {
    stubServer(OPEN, accepted);
    const terms: WebExtension = { id: "terms", slots: { "auth.register.footer": () => <p>Terms of the fixture</p> } };
    await openRegister([terms]);

    const form = screen.getByRole("button", { name: "Create account" }).closest("form");
    expect(within(form ?? document.body).getByText("Terms of the fixture")).toBeTruthy();
  });

  it("is written in German", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-AT"]);
    stubServer(OPEN, accepted);
    await openRegister();

    expect(screen.getByRole("heading", { level: 1, name: "Konto erstellen" })).toBeTruthy();
    expect(screen.getByLabelText("Passwort")).toBeTruthy();
  });

  it("shows the closed card instead of the form while registration is closed", async () => {
    const server = stubServer(CLOSED, accepted);
    await openRegister();

    expect(screen.getByRole("heading", { level: 1, name: "Registration is closed" })).toBeTruthy();
    expect(screen.getByText("Ask an admin for an invitation.")).toBeTruthy();
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(screen.getByRole("link", { name: "Back to sign in" }).getAttribute("href")).toBe("/login");
    expect(await server.registrations()).toEqual([]);
  });

  it("shows the closed card for a configuration that does not mention registration", async () => {
    stubServer(CONFIG_BODY, accepted);
    await openRegister();

    expect(screen.getByRole("heading", { level: 1, name: "Registration is closed" })).toBeTruthy();
  });

  it("sends a signed-in visitor home", async () => {
    vi.stubGlobal("fetch", (request: Request) =>
      new URL(request.url).pathname === "/api/config" ? Promise.resolve(json(OPEN)) : signedIn(request),
    );
    window.history.replaceState(null, "", "/register");
    const App = createWebApp({ extensions: [] });
    await renderApp(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: `Welcome to ${PRODUCT_NAME}` })).toBeTruthy();
    expect(window.location.pathname).toBe("/");
  });
});

describe("registering", () => {
  it("sends the trimmed name and email and the password, then asks to check the email", async () => {
    const server = stubServer(OPEN, accepted);
    await openRegister();

    await fillAndSubmit();

    expect(await screen.findByRole("heading", { level: 1, name: "Check your email" })).toBeTruthy();
    expect(await server.registrations()).toEqual([{ displayName: "Ada Lovelace", email: "ada@example.org", password: PASSWORD }]);
    expect(screen.getByText(/ada@example\.org/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send the link again" })).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("tells the person the account is ready and offers sign-in, with no check-email state, when the server has no mail", async () => {
    const server = stubServer(OPEN_WITHOUT_MAIL, accepted);
    await openRegister();

    await fillAndSubmit();

    expect(await screen.findByRole("heading", { level: 1, name: "Your account is ready" })).toBeTruthy();
    expect(await server.registrations()).toEqual([{ displayName: "Ada Lovelace", email: "ada@example.org", password: PASSWORD }]);
    expect(screen.getByRole("link", { name: "Go to sign in" }).getAttribute("href")).toBe("/login");
    expect(screen.queryByRole("heading", { name: "Check your email" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^(Send the link again|Send again in)/ })).toBeNull();
    expect(await server.resends()).toEqual([]);
  });

  it("names the empty fields and sends nothing", async () => {
    const server = stubServer(OPEN, accepted);
    await openRegister();

    await submit();

    expect(screen.getByText("Enter your name.")).toBeTruthy();
    expect(screen.getByText("Enter your email address.")).toBeTruthy();
    expect(screen.getByText("Enter a password.")).toBeTruthy();
    expect(await server.registrations()).toEqual([]);
  });

  it.each([
    ["too_short", "Use at least 12 characters."],
    ["too_long", "Use at most 256 characters."],
    ["breached", "This password appears in a list of breached passwords. Choose a different one."],
  ])("shows the refused password (%s) next to the field", async (code, message) => {
    stubServer(OPEN, () =>
      Promise.resolve(
        json(
          { type: "t", title: "weak", status: 422, code: "weak_password", detail: "d", requestId: "r", errors: [{ path: "password", code }] },
          { status: 422, contentType: "application/problem+json" },
        ),
      ),
    );
    await openRegister();

    await fillAndSubmit();

    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.getByLabelText("Password").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("heading", { level: 1, name: "Create an account" })).toBeTruthy();
  });

  it("shows the closed card when the server says registration is closed", async () => {
    stubServer(OPEN, () => Promise.resolve(problem(403, "registration_closed", "req-1")));
    await openRegister();

    await fillAndSubmit();

    expect(await screen.findByRole("heading", { level: 1, name: "Registration is closed" })).toBeTruthy();
  });

  it.each([
    [() => problem(403, "registration_refused", "req-1"), "An account cannot be created with that email address."],
    [() => problem(503, "mail_unavailable", "req-1"), "Registration needs email, and this server cannot send any right now. Ask an administrator."],
    [() => problem(503, "unavailable", "req-1"), "Registration is not possible right now. Try again in a moment."],
    [() => problem(422, "validation_failed", "req-1"), "Check your entries and try again."],
  ])("says what went wrong and keeps the form (%#)", async (answer, message) => {
    stubServer(OPEN, () => Promise.resolve(answer()));
    await openRegister();

    await fillAndSubmit();

    expect((await screen.findByRole("alert")).textContent).toContain(message);
    expect(screen.getByLabelText<HTMLInputElement>("Email").value).toBe("ada@example.org");
    expect(screen.getByRole("button", { name: "Create account" }).hasAttribute("data-loading")).toBe(false);
  });

  it("shows the wait of a rate-limited registration", async () => {
    stubServer(OPEN, () => rateLimited(120));
    await openRegister();

    await fillAndSubmit();

    expect((await screen.findByRole("alert")).textContent).toContain("Too many registrations. Try again in 2 minutes.");
  });
});

describe("the Check your email state", () => {
  async function registered(resend: Transport): Promise<Server> {
    const server = stubServer(OPEN, accepted, resend);
    await openRegister();
    await fillAndSubmit();
    await screen.findByRole("heading", { level: 1, name: "Check your email" });
    return server;
  }

  async function press(): Promise<void> {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^(Send the link again|Send again in)/ }));
      await Promise.resolve();
    });
  }

  it("sends the link again to the address that was registered", async () => {
    const server = await registered(accepted);

    await press();

    expect((await screen.findByRole("status")).textContent).toContain("a new link is on its way");
    expect(await server.resends()).toEqual([{ email: "ada@example.org" }]);
  });

  it("counts down the Retry-After of a rate-limited resend and sends nothing meanwhile", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const server = await registered(() => rateLimited(65));

    await press();

    expect((await screen.findByRole("button", { name: "Send again in 1:05" })).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Too many requests. Wait before asking again.")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Send again in 1:00" })).toBeTruthy();
    await press();
    expect(await server.resends()).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Send the link again" }).hasAttribute("disabled")).toBe(false);
    expect(screen.queryByText("Too many requests. Wait before asking again.")).toBeNull();
  });

  it("says so when the link could not be sent", async () => {
    await registered(() => Promise.resolve(problem(503, "unavailable", "req-1")));

    await press();

    expect((await screen.findByRole("alert")).textContent).toContain("The link could not be sent right now.");
    expect(screen.getByRole("button", { name: "Send the link again" }).hasAttribute("disabled")).toBe(false);
  });
});
