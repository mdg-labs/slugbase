import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp, useApiClient, type WebExtension } from "../src/index.ts";
import { upgradeActionExtension, VERSION_PAGE_PATH, versionPageExtension } from "./fixture-extension.tsx";
import { SESSION_PATH, json, problem, renderApp, signedIn, stubBrowserApis, stubMatchMedia } from "./support.tsx";

type Transport = (request: Request) => Promise<Response>;

const VERSION_BODY = { name: "SlugBase", version: "1.2.3", commit: "abc1234", builtAt: "2026-01-01T00:00:00Z" } as const;

/** A server whose `GET /version` answers `version`; once that answers `401 unauthenticated` the session check fails too. */
function stubServer(version: () => Response): void {
  let ended = false;
  const transport: Transport = (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === SESSION_PATH && ended) {
      return Promise.resolve(problem(401, "unauthenticated", "req-session"));
    }
    return signedIn(request, (call) => {
      if (new URL(call.url).pathname !== "/version") {
        return Promise.reject(new Error("unexpected call"));
      }
      const response = version();
      ended ||= response.status === 401;
      return Promise.resolve(response);
    });
  };
  vi.stubGlobal("fetch", vi.fn<Transport>(transport));
}

async function open(extensions: readonly WebExtension[]): Promise<void> {
  window.history.replaceState(null, "", VERSION_PAGE_PATH);
  const App = createWebApp({ extensions });
  await renderApp(<App />);
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

describe("an extension route using the public entry", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("shows the data of an operation read through useApiClient() and the filler another extension registered", async () => {
    stubServer(() => json(VERSION_BODY));

    await open([versionPageExtension, upgradeActionExtension]);

    expect(await screen.findByText("SlugBase 1.2.3")).toBeTruthy();
    const page = screen.getByRole("region", { name: "Status page" });
    expect(Array.from(page.children, (child) => child.tagName)).toEqual(["H1", "P", "A"]);
    expect(screen.getByRole("link", { name: "Upgrade now" }).getAttribute("href")).toBe("/upgrade");
  });

  it("renders no element for a slot no extension fills", async () => {
    stubServer(() => json(VERSION_BODY));

    await open([versionPageExtension]);

    await screen.findByText("SlugBase 1.2.3");
    const page = screen.getByRole("region", { name: "Status page" });
    expect(Array.from(page.children, (child) => child.tagName)).toEqual(["H1", "P"]);
  });

  it("sees ApiProblemError with its code, status and request id on a problem answer", async () => {
    stubServer(() => problem(400, "validation_failed", "req-version"));

    await open([versionPageExtension, upgradeActionExtension]);

    expect(await screen.findByText("problem validation_failed 400 req-version")).toBeTruthy();
    expect(window.location.pathname).toBe(VERSION_PAGE_PATH);
  });

  it("takes the member to sign in when its call is answered with a 401 that ends the session", async () => {
    stubServer(() => problem(401, "unauthenticated", "req-version"));

    await open([versionPageExtension]);

    await waitFor(() => {
      expect(window.location.pathname).toBe("/login");
    });
    expect(window.location.search).toBe(`?next=${encodeURIComponent(VERSION_PAGE_PATH)}`);
    expect(await screen.findByText("Your session has ended")).toBeTruthy();
  });
});

describe("useApiClient", () => {
  it("refuses to run outside the web app", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    function Probe(): null {
      useApiClient();
      return null;
    }
    expect(() => render(<Probe />)).toThrow(/inside the web app/);
  });
});
