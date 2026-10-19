import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebApp } from "../src/index.ts";
import { ACCOUNT_BODY, CONFIG_BODY, ME_PATH, SESSION_BODY, SESSION_PATH, WORKSPACES_PATH, WORKSPACE_LIST_BODY, json, meOf, problem, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

type Transport = (request: Request) => Promise<Response>;

const LOGIN_PATH = "/api/v1/auth/login";
const RESEND_PATH = "/api/v1/auth/verify-email/resend";

const OPEN = { ...CONFIG_BODY, signIn: { registration: true, oidc: [] } };
const CLOSED = { ...CONFIG_BODY, signIn: { registration: false, oidc: [] } };

function rateLimited(seconds: number): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify({ type: "t", title: "rate_limited", status: 429, code: "rate_limited", detail: "d", requestId: "r" }), {
      status: 429,
      headers: { "Content-Type": "application/problem+json", "Retry-After": String(seconds) },
    }),
  );
}

const accepted = (): Promise<Response> => Promise.resolve(new Response(null, { status: 202 }));

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

describe("the sign-in page and registration", () => {
  async function openLogin(config: object): Promise<void> {
    vi.stubGlobal("fetch", (request: Request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/config") {
        return Promise.resolve(json(config));
      }
      return Promise.resolve(problem(401, "unauthenticated", "req-session"));
    });
    window.history.replaceState(null, "", "/login");
    const App = createWebApp({ extensions: [] });
    await renderApp(<App />);
    await screen.findByRole("heading", { level: 1, name: "Sign in" });
  }

  it("offers Create an account when registration is open", async () => {
    await openLogin(OPEN);

    expect(screen.getByRole("link", { name: "Create an account" }).getAttribute("href")).toBe("/register");
  });

  it.each([
    ["closed", CLOSED],
    ["not mentioned", CONFIG_BODY],
  ])("does not offer Create an account when registration is %s", async (_name, config) => {
    await openLogin(config);

    expect(screen.queryByRole("link", { name: "Create an account" })).toBeNull();
  });
});

describe("signing in with an unverified address", () => {
  function stubServer(resend: Transport): Request[] {
    const resent: Request[] = [];
    vi.stubGlobal("fetch", (request: Request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/config") {
        return Promise.resolve(json(CONFIG_BODY));
      }
      if (pathname === LOGIN_PATH) {
        return Promise.resolve(problem(403, "email_unverified", "req-1"));
      }
      if (pathname === RESEND_PATH) {
        resent.push(request.clone());
        return resend(request);
      }
      return Promise.resolve(problem(401, "unauthenticated", "req-session"));
    });
    return resent;
  }

  async function signIn(): Promise<void> {
    window.history.replaceState(null, "", "/login");
    const App = createWebApp({ extensions: [] });
    await renderApp(<App />);
    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: " ada@example.org " } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse" } });
    await act(async () => {
      fireEvent.submit(screen.getByRole("button", { name: "Sign in" }).closest("form") ?? document.body);
      await Promise.resolve();
    });
  }

  it("says Verify your email and sends the link again to the address that was used", async () => {
    const resent = stubServer(accepted);
    await signIn();

    const banner = await screen.findByText("Verify your email");
    expect(banner).toBeTruthy();
    expect(screen.queryByText("The email address or the password is wrong.")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send the link again" }));
      await Promise.resolve();
    });

    expect(await screen.findByText(/a new link is on its way/)).toBeTruthy();
    expect(await Promise.all(resent.map((request) => request.json() as Promise<unknown>))).toEqual([{ email: "ada@example.org" }]);
    expect(window.location.pathname).toBe("/login");
  });

  it("counts down a rate-limited resend", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    stubServer(() => rateLimited(30));
    await signIn();
    await screen.findByText("Verify your email");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send the link again" }));
      await Promise.resolve();
    });

    expect((await screen.findByRole("button", { name: "Send again in 0:30" })).hasAttribute("disabled")).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Send again in 0:20" })).toBeTruthy();
  });
});

describe("the banner for an unverified account", () => {
  function stubServer(config: object, emailVerified: boolean, resend: Transport = accepted): Request[] {
    const resent: Request[] = [];
    vi.stubGlobal("fetch", (request: Request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/config") {
        return Promise.resolve(json(config));
      }
      if (pathname === ME_PATH) {
        return Promise.resolve(json(meOf({ ...ACCOUNT_BODY, emailVerified })));
      }
      if (pathname === RESEND_PATH) {
        resent.push(request.clone());
        return resend(request);
      }
      if (pathname === WORKSPACES_PATH) {
        return Promise.resolve(json(WORKSPACE_LIST_BODY));
      }
      return pathname === SESSION_PATH ? Promise.resolve(json(SESSION_BODY)) : Promise.reject(new Error("unexpected call"));
    });
    return resent;
  }

  async function openHome(): Promise<void> {
    const App = createWebApp({ extensions: [] });
    await renderApp(<App />);
    await screen.findByRole("main");
  }

  it("offers a resend above the page while the address is not verified", async () => {
    const resent = stubServer({ ...CONFIG_BODY, features: { ai: false, mail: true } }, false);
    await openHome();

    const main = screen.getByRole("main");
    const banner = within(main).getByText("Your email address is not verified");
    expect(banner).toBeTruthy();
    expect(within(main).getByText(/We sent a link to ada@example\.org/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(main).getByRole("button", { name: "Send the link again" }));
      await Promise.resolve();
    });

    expect(await within(main).findByText(/a new link is on its way/)).toBeTruthy();
    expect(await Promise.all(resent.map((request) => request.json() as Promise<unknown>))).toEqual([{ email: "ada@example.org" }]);
  });

  it("is not shown for a verified account", async () => {
    stubServer({ ...CONFIG_BODY, features: { ai: false, mail: true } }, true);
    await openHome();

    expect(screen.queryByText("Your email address is not verified")).toBeNull();
  });

  it("is not shown where the server cannot send the link", async () => {
    stubServer(CONFIG_BODY, false);
    await openHome();

    expect(screen.queryByText("Your email address is not verified")).toBeNull();
  });
});
