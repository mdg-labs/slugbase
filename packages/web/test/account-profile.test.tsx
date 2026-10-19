import type { ComponentTypes } from "@slugbase/contracts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebApp } from "../src/index.ts";
import { SESSION_PATH, json, meOf, problem, renderApp, signedIn, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// /settings/account (doc 03 section 11.1): the profile form over a stubbed transport. The failure
// scenarios are a save that is reported as done when the server refused it, a language that stays
// behind until a reload, and a profile that cannot be loaded shown as an empty form.

type Transport = (request: Request) => Promise<Response>;
type Account = ComponentTypes["schemas"]["Account"];

const ME_PATH = "/api/v1/me";
const LOGOUT_PATH = "/api/v1/auth/logout";

const ACCOUNT: Account = {
  id: "0192f3a0-bbbb-7000-8000-000000000001",
  email: "ada@example.org",
  displayName: "Ada Lovelace",
  locale: "en",
  theme: "system",
  accent: null,
  defaultView: "grid",
  singleKeyShortcuts: true,
  signinAlerts: true,
  aiOptOut: false,
  analyticsConsent: "unset",
  onboarding: { browserSetupDone: false, importDone: false, checklistDismissed: false },
  emailVerified: true,
  hasPassword: true,
  mfaEnabled: false,
  pendingEmail: null,
};

function me(account: Account): ComponentTypes["schemas"]["Me"] {
  return meOf(account);
}

interface Server {
  readonly fetch: ReturnType<typeof vi.fn<Transport>>;
  /** The JSON bodies the profile update received. */
  readonly patches: () => Promise<unknown[]>;
}

/**
 * A server with a signed-in account. `get` answers the profile read and `patch` the update; the default
 * of `patch` applies the change to the account it holds, as the server does.
 */
function stubServer({ get, patch }: { get?: Transport; patch?: Transport } = {}): Server {
  let account = ACCOUNT;
  let signedOut = false;
  const received: Request[] = [];
  const fetch = vi.fn<Transport>(async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === LOGOUT_PATH) {
      signedOut = true;
      return new Response(null, { status: 204 });
    }
    if (pathname === SESSION_PATH && signedOut) {
      return problem(401, "unauthenticated", "req-session");
    }
    if (pathname !== ME_PATH) {
      return signedIn(request);
    }
    if (request.method === "GET") {
      return get === undefined ? json(me(account)) : get(request);
    }
    received.push(request.clone());
    if (patch !== undefined) {
      return patch(request);
    }
    account = { ...account, ...((await request.json()) as Partial<Account>) };
    return json(account);
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, patches: () => Promise.all(received.map((request) => request.json() as Promise<unknown>)) };
}

async function openProfile(path = "/settings/account"): Promise<void> {
  window.history.replaceState(null, "", path);
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
  await screen.findByRole("heading", { level: 1, name: /^(Profile|Profil)$/ });
}

function nameInput(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>("textbox", { name: "Name" });
}

/** The initials of the avatar preview in the page; the account menu's avatar is a stand-in icon, and the workspace switcher's monogram is in the sidebar. */
function avatarText(): string | null | undefined {
  return document.querySelector('main [data-slot="avatar"][aria-hidden="true"]')?.textContent;
}

/** The text of every alert on the page: the toasts, which are announced at once when they report an error. */
async function alertsText(): Promise<string> {
  return (await screen.findAllByRole("alert")).map((alert) => alert.textContent).join(" ");
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>("button", { name: /^(Save|Speichern)/ });
}

async function chooseLanguage(select: string, option: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("combobox", { name: select }));
    await Promise.resolve();
  });
  await act(async () => {
    const found = await screen.findByRole("option", { name: option });
    // Base UI commits a click only after the press began on the item.
    fireEvent.pointerDown(found);
    fireEvent.click(found);
    await Promise.resolve();
  });
}

async function submit(): Promise<void> {
  await act(async () => {
    fireEvent.submit(saveButton().closest("form") ?? document.body);
    await Promise.resolve();
  });
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

describe("the profile page", () => {
  it("renders inside the settings layout with the name, the read-only email, the language and the avatar preview", async () => {
    stubServer();
    await openProfile();

    const nav = screen.getByRole("navigation", { name: "Settings" });
    expect(within(nav).getByRole("link", { name: "Profile" }).getAttribute("aria-current")).toBe("page");
    expect(nameInput().value).toBe("Ada Lovelace");
    const email = screen.getByRole<HTMLInputElement>("textbox", { name: "Email" });
    expect(email.value).toBe("ada@example.org");
    expect(email.readOnly).toBe(true);
    expect(screen.getByRole("combobox", { name: "Language" }).textContent).toContain("English");
    expect(avatarText()).toBe("AL");
    expect(saveButton().disabled).toBe(true);
    expect(document.documentElement.lang).toBe("en");
  });

  it("is where /settings leads", async () => {
    stubServer();
    await openProfile("/settings");
    expect(window.location.pathname).toBe("/settings/account");
  });

  it("opens from the Account settings entry of the account menu", async () => {
    stubServer();
    window.history.replaceState(null, "", "/");
    const App = createWebApp({ extensions: [] });
    await renderApp(<App />);
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Account" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("menuitem", { name: "Account settings" }));
      await Promise.resolve();
    });

    expect(await screen.findByRole("heading", { level: 1, name: "Profile" })).toBeTruthy();
    expect(window.location.pathname).toBe("/settings/account");
  });

  it("sends only what changed, shows the saving state while the request is out, and reports the save", async () => {
    let answer: (response: Response) => void = () => undefined;
    const server = stubServer({
      patch: () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });
    await openProfile();

    fireEvent.change(nameInput(), { target: { value: "  Ada King  " } });
    expect(saveButton().disabled).toBe(false);
    await submit();

    await waitFor(() => {
      expect(saveButton().getAttribute("data-loading")).not.toBeNull();
    });
    expect(saveButton().disabled).toBe(true);
    expect(nameInput().disabled).toBe(true);
    await act(async () => {
      answer(json({ ...ACCOUNT, displayName: "Ada King" }));
      await Promise.resolve();
    });

    expect(await server.patches()).toEqual([{ displayName: "Ada King" }]);
    expect(await screen.findByText("Profile saved")).toBeTruthy();
    await waitFor(() => {
      expect(nameInput().disabled).toBe(false);
    });
    expect(nameInput().value).toBe("  Ada King  ");
    expect(saveButton().disabled).toBe(true);
    expect(avatarText()).toBe("AK");
  });

  it("re-renders the app in the chosen language after the save, without a reload", async () => {
    const server = stubServer();
    await openProfile();
    expect(document.documentElement.lang).toBe("en");

    await chooseLanguage("Language", "Deutsch");
    await submit();

    expect(await server.patches()).toEqual([{ locale: "de" }]);
    expect(await screen.findByRole("heading", { level: 1, name: "Profil" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Speichern" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Sprache" }).textContent).toContain("Deutsch");
    expect(screen.getByRole("navigation", { name: "Einstellungen" })).toBeTruthy();
    expect(await screen.findByText("Profil gespeichert")).toBeTruthy();
    expect(document.documentElement.lang).toBe("de");
    expect(window.location.pathname).toBe("/settings/account");
  });

  it("uses the saved language for the shell the next time the page is opened in the same session", async () => {
    stubServer();
    await openProfile();
    await chooseLanguage("Language", "Deutsch");
    await submit();
    await screen.findByRole("heading", { level: 1, name: "Profil" });

    await act(async () => {
      fireEvent.click(screen.getByRole("link", { name: "Start" }));
      await Promise.resolve();
    });
    expect(await screen.findByRole("heading", { level: 1, name: /^Willkommen bei/ })).toBeTruthy();
  });

  it("does not carry the language of the account that signed out to the sign-in page", async () => {
    stubServer();
    await openProfile();
    await chooseLanguage("Language", "Deutsch");
    await submit();
    await screen.findByRole("heading", { level: 1, name: "Profil" });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Konto" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("menuitem", { name: "Abmelden" }));
      await Promise.resolve();
    });

    expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeTruthy();
    expect(document.documentElement.lang).toBe("en");
  });

  it("refuses a blank name before any request and names the field", async () => {
    const server = stubServer();
    await openProfile();

    fireEvent.change(nameInput(), { target: { value: "   " } });
    await submit();

    expect(screen.getByText("Enter your name.")).toBeTruthy();
    expect(nameInput().getAttribute("aria-invalid")).toBe("true");
    expect(await server.patches()).toEqual([]);

    fireEvent.change(nameInput(), { target: { value: "Ada" } });
    expect(screen.queryByText("Enter your name.")).toBeNull();
  });

  it("sends a name of 100 astral-plane characters and does not cut the input at 100 UTF-16 units", async () => {
    const server = stubServer();
    await openProfile();
    const hundred = "\u{1F600}".repeat(100);

    expect(nameInput().getAttribute("maxlength")).toBeNull();
    fireEvent.change(nameInput(), { target: { value: `  ${hundred}  ` } });
    await submit();

    expect(await server.patches()).toEqual([{ displayName: hundred }]);
    expect(screen.queryByText("Use at most 100 characters.")).toBeNull();
  });

  it("refuses a name of 101 characters before any request, however many UTF-16 units it takes", async () => {
    const server = stubServer();
    await openProfile();

    fireEvent.change(nameInput(), { target: { value: "\u{1F600}".repeat(101) } });
    await submit();

    expect(screen.getByText("Use at most 100 characters.")).toBeTruthy();
    expect(await server.patches()).toEqual([]);
  });

  it("names the field the server refused and raises the error toast, and keeps what was typed", async () => {
    const server = stubServer({
      patch: () =>
        Promise.resolve(
          json(
            {
              type: "https://slugbase.app/problems/validation_failed",
              title: "validation_failed",
              status: 422,
              code: "validation_failed",
              detail: "The request did not pass validation.",
              requestId: "req-422",
              errors: [{ path: "displayName", code: "too_small" }],
            },
            { status: 422, contentType: "application/problem+json" },
          ),
        ),
    });
    await openProfile();

    fireEvent.change(nameInput(), { target: { value: "Ada King" } });
    await submit();

    expect(await screen.findByText("Check the name.")).toBeTruthy();
    const alerts = await alertsText();
    expect(alerts).toContain("The change was not saved");
    expect(alerts).toContain("Request ID: req-422");
    expect(nameInput().value).toBe("Ada King");
    expect(await server.patches()).toEqual([{ displayName: "Ada King" }]);
    expect(screen.queryByText("Profile saved")).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it("raises the error toast for a failed update, keeps the language and offers the save again", async () => {
    const server = stubServer({ patch: () => Promise.resolve(problem(503, "unavailable", "req-503")) });
    await openProfile();

    await chooseLanguage("Language", "Deutsch");
    await submit();

    expect(await alertsText()).toContain("The change was not saved");
    expect(screen.getByRole("heading", { level: 1, name: "Profile" })).toBeTruthy();
    expect(document.documentElement.lang).toBe("en");
    expect(screen.queryByText("Profile saved")).toBeNull();
    expect(saveButton().disabled).toBe(false);
    expect(await server.patches()).toEqual([{ locale: "de" }]);
  });

  it("raises the error toast when the request cannot be made at all", async () => {
    stubServer({ patch: () => Promise.reject(new TypeError("Failed to fetch")) });
    await openProfile();

    fireEvent.change(nameInput(), { target: { value: "Ada King" } });
    await submit();

    expect(await alertsText()).toContain("The change was not saved");
    expect(screen.queryByText("Profile saved")).toBeNull();
    expect(nameInput().value).toBe("Ada King");
  });

  it("does not show an empty form when the profile cannot be loaded, and loads it on retry", async () => {
    let failing = true;
    stubServer({ get: () => Promise.resolve(failing ? problem(503, "unavailable", "req-get") : json(me(ACCOUNT))) });
    await openProfile();

    expect(await screen.findByText("Your profile could not be loaded", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();

    failing = false;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(nameInput().value).toBe("Ada Lovelace");
    });
    expect(screen.queryByText("Your profile could not be loaded")).toBeNull();
  });

  it("leaves a session that ended while saving to the session handler: no error toast, the visitor is sent to sign in", async () => {
    stubServer({ patch: () => Promise.resolve(problem(401, "unauthenticated", "req-401")) });
    await openProfile();

    fireEvent.change(nameInput(), { target: { value: "Ada King" } });
    await submit();

    expect(await screen.findByText("Your session has ended")).toBeTruthy();
    expect(screen.queryByText("The change was not saved")).toBeNull();
    expect(screen.queryByText("Profile saved")).toBeNull();
  });
});

describe("the settings navigation on a narrow screen", () => {
  it("is a Select of the settings pages that shows the current one", async () => {
    stubMatchMedia(true);
    stubServer();
    await openProfile();

    expect(screen.queryByRole("navigation", { name: "Settings" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Settings" }).textContent).toContain("Profile");
  });
});
