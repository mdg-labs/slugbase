import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { navigateTo } from "../src/auth/navigate.ts";
import { createWebApp } from "../src/index.ts";
import { CONFIG_BODY, SESSION_PATH, json, problem, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

vi.mock("../src/auth/navigate.ts", () => ({ navigateTo: vi.fn() }));

// The provider buttons of /login (doc 03 section 1.2) and the generic failure the OIDC callback redirects with
// (doc 04 section 4.5). The failure scenarios are a button that is shown for no provider or hidden for a configured one,
// a start that is reached by a request instead of a navigation, a failure page that says more than it should, and a
// provider name from the configuration that is rendered as markup.

type Providers = readonly { slug: string; name: string }[] | undefined;

/** Stubs the server and returns how many requests it has received. */
function stubServer(providers: Providers): () => number {
  const transport = vi.fn((request: Request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/config") {
      return Promise.resolve(json(providers === undefined ? CONFIG_BODY : { ...CONFIG_BODY, signIn: { oidc: providers } }));
    }
    if (pathname === SESSION_PATH) {
      return Promise.resolve(problem(401, "unauthenticated", "req-session"));
    }
    return Promise.reject(new Error(`unexpected call to ${pathname}`));
  });
  vi.stubGlobal("fetch", transport);
  return () => transport.mock.calls.length;
}

async function openLogin(path = "/login"): Promise<void> {
  window.history.replaceState(null, "", path);
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
  await screen.findByRole("heading", { level: 1, name: "Sign in" });
}

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

describe("the provider buttons", () => {
  it("lists one button per configured provider under the form, separated from it by 'or'", async () => {
    stubServer([
      { slug: "acme", name: "Acme SSO" },
      { slug: "town-hall", name: "Town Hall" },
    ]);
    await openLogin();

    const form = screen.getByRole("button", { name: "Sign in" }).closest("form");
    expect(form).not.toBeNull();
    expect(screen.getByLabelText("Email")).toBeTruthy();
    expect(screen.getByText("or")).toBeTruthy();
    const buttons = ["Continue with Acme SSO", "Continue with Town Hall"].map((name) => screen.getByRole("button", { name }));
    expect(buttons).toHaveLength(2);
    // The provider buttons are outside the password form: pressing one does not submit it.
    for (const button of buttons) {
      expect(form?.contains(button)).toBe(false);
    }
  });

  it("starts the handshake by navigating the browser, with the page to come back to", async () => {
    const requests = stubServer([{ slug: "acme", name: "Acme SSO" }]);
    await openLogin("/login?next=%2Fgo%2Fdocs");
    const before = requests();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue with Acme SSO" }));
      await Promise.resolve();
    });

    expect(navigateTo).toHaveBeenCalledExactlyOnceWith("/api/v1/auth/oidc/acme/start?returnTo=%2Fgo%2Fdocs");
    // A request would not carry the browser to the provider: the start is never fetched.
    expect(requests()).toBe(before);
  });

  it("does not take a foreign next address along as the page to come back to", async () => {
    stubServer([{ slug: "acme", name: "Acme SSO" }]);
    await openLogin("/login?next=https%3A%2F%2Fevil.example%2F");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue with Acme SSO" }));
      await Promise.resolve();
    });

    expect(navigateTo).toHaveBeenCalledExactlyOnceWith("/api/v1/auth/oidc/acme/start?returnTo=%2F");
  });

  it.each([
    ["a configuration without a signIn document", undefined],
    ["an empty provider list", []],
  ] as const)("shows only the email and password form for %s", async (_name, providers) => {
    stubServer(providers);
    await openLogin();

    expect(screen.getByLabelText("Email")).toBeTruthy();
    expect(screen.queryByText("or")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Continue with/ })).toBeNull();
  });

  it("renders a provider name as text, never as markup", async () => {
    const name = '<img src="x" onerror="alert(1)"> Acme';
    stubServer([{ slug: "acme", name }]);
    await openLogin();

    const button = screen.getByRole("button", { name: `Continue with ${name}` });
    expect(button.textContent).toBe(`Continue with ${name}`);
    expect(button.querySelector("img")).toBeNull();
  });
});

describe("the sign-in failure of the OIDC callback", () => {
  it("says the sign-in did not work, in one generic message", async () => {
    stubServer([{ slug: "acme", name: "Acme SSO" }]);
    await openLogin("/login?error=oidc_failed");

    const alert = screen.getByRole("alert");
    expect(within(alert).getByText(/Signing in with that provider did not work/)).toBeTruthy();
    expect(alert.textContent).not.toMatch(/state|nonce|token|account|exist/i);
  });

  it("is shown in the language of the page", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-DE", "de"]);
    stubServer(undefined);
    window.history.replaceState(null, "", "/login?error=oidc_failed");
    const App = createWebApp({ extensions: [] });
    await renderApp(<App />);

    expect(await screen.findByText(/Die Anmeldung mit diesem Anbieter hat nicht funktioniert/)).toBeTruthy();
  });

  it("ignores any other error value and does not show it", async () => {
    stubServer(undefined);
    await openLogin("/login?error=%3Cb%3Eaccount%20does%20not%20exist%3C%2Fb%3E");

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/does not exist/)).toBeNull();
  });
});
