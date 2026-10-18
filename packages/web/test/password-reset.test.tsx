import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebApp } from "../src/index.ts";
import { CONFIG_BODY, SESSION_PATH, json, problem, renderApp, signedIn, stubBrowserApis, stubMatchMedia } from "./support.tsx";

type Transport = (request: Request) => Promise<Response>;

const FORGOT_PATH = "/api/v1/auth/password/forgot";
const RESET_PATH = "/api/v1/auth/password/reset";
const PASSWORD = "correct horse battery staple";

const WITH_MAIL = { ...CONFIG_BODY, features: { ai: false, mail: true } };
const WITHOUT_MAIL = { ...CONFIG_BODY, features: { ai: false, mail: false } };

interface Server {
  readonly requests: () => Promise<unknown[]>;
  readonly resets: () => Promise<unknown[]>;
}

const accepted = (): Promise<Response> => Promise.resolve(new Response(null, { status: 202 }));
const done = (): Promise<Response> => Promise.resolve(json({ next: "done" }));

function rateLimited(seconds: number): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify({ type: "t", title: "rate_limited", status: 429, code: "rate_limited", detail: "d", requestId: "r" }), {
      status: 429,
      headers: { "Content-Type": "application/problem+json", "Retry-After": String(seconds) },
    }),
  );
}

/** A server with nobody signed in until the reset is answered with `200`; `forgot` and `reset` answer the two calls the pages make. */
function stubServer(config: object, forgot: Transport = accepted, reset: Transport = done, sessionAfter: Transport = signedIn): Server {
  let signed = false;
  const asked: Request[] = [];
  const redeemed: Request[] = [];
  vi.stubGlobal("fetch", (request: Request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/config") {
      return Promise.resolve(json(config));
    }
    if (pathname === FORGOT_PATH) {
      asked.push(request.clone());
      return forgot(request);
    }
    if (pathname === RESET_PATH) {
      redeemed.push(request.clone());
      return reset(request).then((response) => {
        signed ||= response.ok;
        return response;
      });
    }
    if (pathname === SESSION_PATH && !signed) {
      return Promise.resolve(problem(401, "unauthenticated", "req-session"));
    }
    return sessionAfter(request);
  });
  return {
    requests: () => Promise.all(asked.map((request) => request.json() as Promise<unknown>)),
    resets: () => Promise.all(redeemed.map((request) => request.json() as Promise<unknown>)),
  };
}

async function open(address: string): Promise<void> {
  window.history.replaceState(null, "", address);
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
  await screen.findByRole("heading", { level: 1 });
}

function typeInto(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function submitForm(button: string): Promise<void> {
  await act(async () => {
    fireEvent.submit(screen.getByRole("button", { name: button }).closest("form") ?? document.body);
    await Promise.resolve();
  });
}

const askForLink = (): Promise<void> => submitForm("Send the link");
const saveAndSignIn = (): Promise<void> => submitForm("Save password and sign in");

function weakPassword(code: string): Transport {
  return () =>
    Promise.resolve(
      json(
        { type: "t", title: "weak", status: 422, code: "weak_password", detail: "d", requestId: "r", errors: [{ path: "newPassword", code }] },
        { status: 422, contentType: "application/problem+json" },
      ),
    );
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

describe("the sign-in page", () => {
  it("links to the page that asks for a reset link", async () => {
    stubServer(WITH_MAIL);
    window.history.replaceState(null, "", "/login");
    const App = createWebApp({ extensions: [] });
    await renderApp(<App />);
    await screen.findByRole("heading", { level: 1, name: "Sign in" });

    expect(screen.getByRole("link", { name: "Forgot password?" }).getAttribute("href")).toBe("/forgot-password");
  });
});

describe("the forgot-password page", () => {
  it("asks for the email address and sends the trimmed address", async () => {
    const server = stubServer(WITH_MAIL);
    await open("/forgot-password");

    expect(screen.getByRole("heading", { level: 1, name: "Forgot your password?" })).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Email").type).toBe("email");
    typeInto("Email", " ada@example.org ");
    await askForLink();

    expect((await screen.findByRole("status")).textContent).toBe("If an account exists for that address, we sent a link.");
    expect(await server.requests()).toEqual([{ email: "ada@example.org" }]);
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(screen.getByRole("link", { name: "Back to sign in" }).getAttribute("href")).toBe("/login");
  });

  it("names an empty address and sends nothing", async () => {
    const server = stubServer(WITH_MAIL);
    await open("/forgot-password");

    await askForLink();

    expect(screen.getByText("Enter your email address.")).toBeTruthy();
    expect(await server.requests()).toEqual([]);
  });

  it("tells the visitor to ask the instance admin, without the form, when the server has no mail", async () => {
    const server = stubServer(WITHOUT_MAIL);
    await open("/forgot-password");

    expect(screen.getByText("Ask your instance admin to send you a reset link")).toBeTruthy();
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send the link" })).toBeNull();
    expect(screen.getByRole("link", { name: "Back to sign in" }).getAttribute("href")).toBe("/login");
    expect(await server.requests()).toEqual([]);
  });

  it.each([
    [() => problem(503, "unavailable", "req-1"), "The link could not be requested right now. Try again in a moment."],
    [() => problem(422, "validation_failed", "req-1"), "Check the email address."],
  ])("says what went wrong and keeps the form (%#)", async (answer, message) => {
    stubServer(WITH_MAIL, () => Promise.resolve(answer()));
    await open("/forgot-password");
    typeInto("Email", "ada@example.org");

    await askForLink();

    expect((await screen.findByRole("alert")).textContent).toContain(message);
    expect(screen.getByLabelText<HTMLInputElement>("Email").value).toBe("ada@example.org");
    expect(screen.getByRole("button", { name: "Send the link" }).hasAttribute("data-loading")).toBe(false);
    expect(screen.queryByText("If an account exists for that address, we sent a link.")).toBeNull();
  });

  it("shows the wait of a rate-limited request", async () => {
    stubServer(WITH_MAIL, () => rateLimited(120));
    await open("/forgot-password");
    typeInto("Email", "ada@example.org");

    await askForLink();

    expect((await screen.findByRole("alert")).textContent).toContain("Too many requests. Try again in 2 minutes.");
  });

  it("is written in German", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-AT"]);
    stubServer(WITH_MAIL);
    await open("/forgot-password");

    expect(screen.getByRole("heading", { level: 1, name: "Passwort vergessen?" })).toBeTruthy();
  });
});

describe("the reset-password page", () => {
  it("asks for the new password with the strength meter and says other sessions are signed out", async () => {
    stubServer(WITH_MAIL);
    await open("/reset-password#token=abc123");

    expect(screen.getByRole("heading", { level: 1, name: "Choose a new password" })).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Password").autocomplete).toBe("new-password");
    expect(screen.getByText("Saving it signs you out of every other session of this account.")).toBeTruthy();
    typeInto("Password", PASSWORD);
    expect(screen.getByRole("meter", { name: "Password strength" })).toBeTruthy();
  });

  it("sends the token from the fragment with the new password and goes home", async () => {
    const server = stubServer(WITH_MAIL);
    await open("/reset-password#token=abc123");
    typeInto("Password", PASSWORD);

    await saveAndSignIn();

    expect(await screen.findByRole("heading", { level: 1, name: /^Welcome to / })).toBeTruthy();
    expect(await server.resets()).toEqual([{ token: "abc123", newPassword: PASSWORD }]);
    expect(window.location.pathname).toBe("/");
  });

  it("continues at the second step of the sign-in when the account has a second factor", async () => {
    stubServer(
      WITH_MAIL,
      accepted,
      () => Promise.resolve(json({ next: "mfa" })),
      (request) => (new URL(request.url).pathname === "/api/config" ? signedIn(request) : Promise.resolve(problem(401, "mfa_required", "req-mfa"))),
    );
    await open("/reset-password#token=abc123");
    typeInto("Password", PASSWORD);

    await saveAndSignIn();

    await act(async () => {
      await Promise.resolve();
    });
    expect(window.location.pathname).toBe("/login/mfa");
  });

  it("asks for a password before sending anything", async () => {
    const server = stubServer(WITH_MAIL);
    await open("/reset-password#token=abc123");

    await saveAndSignIn();

    expect(screen.getByText("Enter a password.")).toBeTruthy();
    expect(await server.resets()).toEqual([]);
  });

  it.each([
    ["too_short", "Use at least 12 characters."],
    ["too_long", "Use at most 256 characters."],
    ["breached", "This password appears in a list of breached passwords. Choose a different one."],
  ])("shows a refused password (%s) next to the field and keeps the form", async (code, message) => {
    stubServer(WITH_MAIL, accepted, weakPassword(code));
    await open("/reset-password#token=abc123");
    typeInto("Password", "short");

    await saveAndSignIn();

    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.getByLabelText("Password").getAttribute("aria-invalid")).toBe("true");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a plain weak_password answer as a hint to choose a stronger one", async () => {
    stubServer(WITH_MAIL, accepted, () =>
      Promise.resolve(
        json(
          { type: "t", title: "weak", status: 422, code: "weak_password", detail: "d", requestId: "r" },
          { status: 422, contentType: "application/problem+json" },
        ),
      ),
    );
    await open("/reset-password#token=abc123");
    typeInto("Password", "short");

    await saveAndSignIn();

    expect(await screen.findByText("Choose a stronger password.")).toBeTruthy();
  });

  it.each([
    [() => problem(503, "unavailable", "req-1"), "Your password could not be reset right now. Try again in a moment."],
    [() => problem(422, "validation_failed", "req-1"), "Check your entries and try again."],
  ])("says what went wrong and keeps the form (%#)", async (answer, message) => {
    stubServer(WITH_MAIL, accepted, () => Promise.resolve(answer()));
    await open("/reset-password#token=abc123");
    typeInto("Password", PASSWORD);

    await saveAndSignIn();

    expect((await screen.findByRole("alert")).textContent).toContain(message);
    expect(screen.getByRole("button", { name: "Save password and sign in" }).hasAttribute("data-loading")).toBe(false);
  });

  it("shows the wait of a rate-limited attempt", async () => {
    stubServer(WITH_MAIL, accepted, () => rateLimited(30));
    await open("/reset-password#token=abc123");
    typeInto("Password", PASSWORD);

    await saveAndSignIn();

    expect((await screen.findByRole("alert")).textContent).toContain("Too many attempts. Try again in 30 seconds.");
  });

  it("is written in German", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-AT"]);
    stubServer(WITH_MAIL);
    await open("/reset-password#token=abc123");

    expect(screen.getByRole("heading", { level: 1, name: "Neues Passwort wählen" })).toBeTruthy();
  });
});

describe("an expired reset link", () => {
  it("shows a banner with a link to request a new one when the server refuses the token", async () => {
    stubServer(WITH_MAIL, accepted, () => Promise.resolve(problem(410, "token_expired", "req-1")));
    await open("/reset-password#token=abc123");
    typeInto("Password", PASSWORD);

    await saveAndSignIn();

    expect(await screen.findByText("This link is not valid or has expired")).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.getByRole("link", { name: "Request a new link" }).getAttribute("href")).toBe("/forgot-password");
  });

  it("is shown at once for an address without a token, and redeems nothing", async () => {
    const server = stubServer(WITH_MAIL);
    await open("/reset-password");

    expect(screen.getByText("This link is not valid or has expired")).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.getByRole("link", { name: "Request a new link" }).getAttribute("href")).toBe("/forgot-password");
    expect(await server.resets()).toEqual([]);
  });
});
