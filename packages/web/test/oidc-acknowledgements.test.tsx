import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { navigateTo } from "../src/auth/navigate.ts";
import { createWebApp } from "../src/index.ts";
import type { WebExtension } from "../src/index.ts";
import { CONFIG_BODY, SESSION_PATH, json, problem, renderApp, signedIn, stubBrowserApis, stubMatchMedia } from "./support.tsx";

vi.mock("../src/auth/navigate.ts", () => ({ navigateTo: vi.fn() }));

// The acknowledgements an extension declares (doc 03 sections 1.2 and 1.5) beside the provider buttons of the sign-in page
// and of the invitation page, built through createWebApp: each one a required checkbox that keeps the handshake from
// starting until it is ticked, then carried in the start's `acknowledgements` parameter (doc 04 section 4.5). The
// re-authentication buttons start no account and show none.

const TOKEN = "invitation-token-for-tests";
const INSPECT_PATH = "/api/v1/invitations/inspect";
const PROVIDERS = [{ slug: "acme", name: "Acme SSO" }];
const ACKNOWLEDGED = [
  { id: "terms", version: "2026-03" },
  { id: "privacy", version: "v4" },
];
const ENCODED = encodeURIComponent(JSON.stringify(ACKNOWLEDGED));

const LEGAL: WebExtension = {
  id: "legal",
  acknowledgements: [
    {
      id: "terms",
      version: "2026-03",
      label: (
        <>
          I accept the <a href="/terms">Terms of Service</a>
        </>
      ),
    },
    { id: "privacy", version: "v4", label: "I have read the privacy notice" },
  ],
};

/** Stubs the server and returns how many requests it has received. */
function stubServer(accountExists = false): () => number {
  const transport = vi.fn((request: Request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/config") {
      return Promise.resolve(json({ ...CONFIG_BODY, signIn: { oidc: PROVIDERS } }));
    }
    if (pathname === INSPECT_PATH) {
      return Promise.resolve(json({ workspaceName: "Compilers", inviterName: "Ada", email: "grace@example.org", role: "admin", accountExists }));
    }
    return pathname === SESSION_PATH || pathname === "/api/v1/me" ? Promise.resolve(problem(401, "unauthenticated", "req")) : signedIn(request);
  });
  vi.stubGlobal("fetch", transport);
  return () => transport.mock.calls.length;
}

async function open(path: string, extensions: readonly WebExtension[]): Promise<void> {
  window.history.replaceState(null, "", path);
  const App = createWebApp({ extensions });
  await renderApp(<App />);
}

async function press(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
    await Promise.resolve();
  });
}

/** The acknowledgement checkboxes of the whole page: the sign-in form's "remember" box and the like are none of them. */
function ackBoxes(): HTMLElement[] {
  return screen.queryAllByRole("checkbox", { name: /Terms of Service|privacy notice/ });
}

function ackAlerts(text: string): HTMLElement[] {
  return screen.queryAllByRole("alert").filter((alert) => alert.textContent === text);
}

function tick(name: string | RegExp): void {
  fireEvent.click(screen.getByRole("checkbox", { name }));
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

const PAGES = [
  {
    name: "sign-in page",
    path: "/login",
    ready: () => screen.findByRole("heading", { level: 1, name: "Sign in" }),
    started: `/api/v1/auth/oidc/acme/start?returnTo=%2F&acknowledgements=${ENCODED}`,
    plain: "/api/v1/auth/oidc/acme/start?returnTo=%2F",
    accountExists: true,
  },
  {
    name: "invitation page",
    path: `/invite/${TOKEN}`,
    ready: () => screen.findByRole("button", { name: "Create account and join" }),
    started: `/api/v1/auth/oidc/acme/start?intent=invite&invitation=${TOKEN}&acknowledgements=${ENCODED}`,
    plain: `/api/v1/auth/oidc/acme/start?intent=invite&invitation=${TOKEN}`,
    accountExists: false,
  },
  {
    name: "invitation page for an address with an account",
    path: `/invite/${TOKEN}`,
    ready: () => screen.findByRole("button", { name: "Sign in" }),
    started: `/api/v1/auth/oidc/acme/start?intent=invite&invitation=${TOKEN}&acknowledgements=${ENCODED}`,
    plain: `/api/v1/auth/oidc/acme/start?intent=invite&invitation=${TOKEN}`,
    accountExists: true,
  },
] as const;

describe.each(PAGES)("the provider buttons of the $name with declared acknowledgements", { timeout: HEAVY_TEST_TIMEOUT_MS }, ({ path, ready, started, accountExists }) => {
  it("shows exactly one required checkbox per acknowledgement, in order, labelled by its content, above the provider button", async () => {
    stubServer(accountExists);
    await open(path, [LEGAL]);
    await ready();

    const boxes = ackBoxes();
    expect(boxes).toHaveLength(2);
    expect(boxes.map((box) => box.getAttribute("aria-required"))).toEqual(["true", "true"]);
    expect(boxes[0]?.closest("label")?.textContent).toBe("I accept the Terms of Service");
    expect(boxes[1]?.closest("label")?.textContent).toBe("I have read the privacy notice");
    expect(screen.getAllByRole("link", { name: "Terms of Service" })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Terms of Service" }).getAttribute("href")).toBe("/terms");
    const button = screen.getByRole("button", { name: "Continue with Acme SSO" });
    for (const box of boxes) {
      expect(box.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("starts nothing while no box is ticked, marks each one and focuses the first", async () => {
    const requests = stubServer(accountExists);
    await open(path, [LEGAL]);
    await ready();
    const before = requests();

    await press("Continue with Acme SSO");

    expect(navigateTo).not.toHaveBeenCalled();
    expect(requests()).toBe(before);
    expect(ackAlerts("Tick this box to continue.")).toHaveLength(2);
    expect(document.activeElement).toBe(screen.getByRole("checkbox", { name: /Terms of Service/ }));
  });

  it("starts nothing while one box is unticked, marks only that one and focuses it", async () => {
    stubServer(accountExists);
    await open(path, [LEGAL]);
    await ready();
    tick(/Terms of Service/);

    await press("Continue with Acme SSO");

    expect(navigateTo).not.toHaveBeenCalled();
    expect(ackAlerts("Tick this box to continue.")).toHaveLength(1);
    const privacy = screen.getByRole("checkbox", { name: "I have read the privacy notice" });
    expect(privacy.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("checkbox", { name: /Terms of Service/ }).getAttribute("aria-invalid")).not.toBe("true");
    expect(document.activeElement).toBe(privacy);

    tick(/privacy notice/);
    expect(ackAlerts("Tick this box to continue.")).toHaveLength(0);
  });

  it("starts the handshake by navigating, with the ticked acknowledgements, once every box is ticked", async () => {
    const requests = stubServer(accountExists);
    await open(path, [LEGAL]);
    await ready();
    const before = requests();
    tick(/Terms of Service/);
    tick(/privacy notice/);

    await press("Continue with Acme SSO");

    expect(navigateTo).toHaveBeenCalledExactlyOnceWith(started);
    expect(requests()).toBe(before);
  });

  it("is written in German", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-AT"]);
    stubServer(accountExists);
    await open(path, [LEGAL]);
    await screen.findByRole("heading", { level: 1 });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Acme SSO/ }));
      await Promise.resolve();
    });

    expect(navigateTo).not.toHaveBeenCalled();
    expect(ackAlerts("Setze dieses Häkchen, um fortzufahren.")).toHaveLength(2);
  });
});

describe.each(PAGES)("the provider buttons of the $name with no acknowledgement declared", { timeout: HEAVY_TEST_TIMEOUT_MS }, ({ path, ready, plain, accountExists }) => {
  it("have no checkbox and start the handshake at once, with no acknowledgements parameter", async () => {
    stubServer(accountExists);
    await open(path, []);
    await ready();

    // The sign-in form has its own "remember" box; the provider buttons have none, and are the same list as before.
    const buttons = screen.getByRole("button", { name: "Continue with Acme SSO" }).parentElement;
    expect(buttons?.className).toBe("flex flex-col gap-2");
    expect(within(buttons ?? document.body).queryAllByRole("checkbox")).toEqual([]);
    expect(buttons?.parentElement?.contains(screen.getByRole("button", { name: "Continue with Acme SSO" }))).toBe(true);
    await press("Continue with Acme SSO");

    expect(navigateTo).toHaveBeenCalledExactlyOnceWith(plain);
  });
});
