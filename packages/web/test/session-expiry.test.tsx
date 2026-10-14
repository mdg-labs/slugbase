import { ThemeProvider } from "@slugbase/ui";
import { FeedbackToastProvider } from "@slugbase/ui/patterns";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, useRouter } from "@tanstack/react-router";
import { act, screen, waitFor } from "@testing-library/react";
import { useEffect, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/api/client.ts";
import { ConfigProvider } from "../src/config/config-context.tsx";
import { ExtensionsProvider, type WebExtension } from "../src/extensions/index.ts";
import { createWebApp } from "../src/index.ts";
import { I18nProvider } from "../src/i18n/i18n-provider.tsx";
import { createQueryClient } from "../src/query-client.ts";
import { createAppRouter } from "../src/router.ts";
import { createSessionExpiry, SessionExpiryHandler } from "../src/shell/session-expiry.tsx";
import { CONFIG_BODY, SESSION_PATH, problem, renderApp, signedIn, stubBrowserApis, stubMatchMedia } from "./support.tsx";

type Transport = (request: Request) => Promise<Response>;

/**
 * A server whose session check passes until `other` answers `401 unauthenticated` to a call: from then on the
 * session is gone, and the check fails as well.
 */
function stubApi(other: Transport): ReturnType<typeof vi.fn<Transport>> {
  let ended = false;
  const fetch = vi.fn<Transport>((request) => {
    if (new URL(request.url).pathname === SESSION_PATH && ended) {
      return Promise.resolve(problem(401, "unauthenticated", "req-1"));
    }
    return signedIn(request, async (call) => {
      const response = await other(call);
      ended ||= response.status === 401 && !(await response.clone().text()).includes("reauth_required");
      return response;
    });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/** A server whose session check answers `code`, as for a visitor who is not signed in; `ok` is a signed-in visitor. */
function stubSessionCheck(code: "ok" | "unauthenticated" | "unavailable", status: number): void {
  vi.stubGlobal(
    "fetch",
    vi.fn<Transport>((request) =>
      code !== "ok" && new URL(request.url).pathname === SESSION_PATH
        ? Promise.resolve(problem(status, code, "req-1"))
        : signedIn(request, () => Promise.reject(new Error("unexpected call"))),
    ),
  );
}

function CallsApi({ calls }: { calls: number }): ReactElement {
  const { api } = useRouter().options.context;
  useEffect(() => {
    for (let call = 0; call < calls; call += 1) {
      api.GET("/version").catch(() => undefined);
    }
  }, [api, calls]);
  return <h1>Protected page</h1>;
}

function protectedPage(calls = 1): WebExtension {
  return { id: "fixture", routes: [{ path: "/protected", component: () => <CallsApi calls={calls} /> }] };
}

async function open(path: string, extension: WebExtension): Promise<void> {
  window.history.replaceState(null, "", path);
  const App = createWebApp({ extensions: [extension] });
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

describe("an API call answered 401", () => {
  it("takes the member to /login?next=<current path> and says why in an info toast", async () => {
    stubApi(() => Promise.resolve(problem(401, "unauthenticated", "req-1")));

    await open("/protected?tab=plan#top", protectedPage());

    await waitFor(() => {
      expect(window.location.pathname).toBe("/login");
    });
    expect(window.location.search).toBe(`?next=${encodeURIComponent("/protected?tab=plan#top")}`);
    expect(await screen.findByText("Your session has ended")).toBeTruthy();
    expect(screen.getByText("Sign in again to continue.")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Notifications" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says why in German", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-AT"]);
    stubApi(() => Promise.resolve(problem(401, "unauthenticated", "req-1")));

    await open("/protected", protectedPage());

    expect(await screen.findByText("Deine Sitzung ist abgelaufen")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Mitteilungen" })).toBeTruthy();
  });

  it("takes the member there once, however many calls fail", async () => {
    stubApi(() => Promise.resolve(problem(401, "unauthenticated", "req-1")));

    await open("/protected", protectedPage(3));

    await screen.findByText("Your session has ended");
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getAllByText("Your session has ended")).toHaveLength(1);
    expect(window.location.search).toBe(`?next=${encodeURIComponent("/protected")}`);
  });

  it("does not leave the page for a re-authentication request", async () => {
    stubApi(() => Promise.resolve(problem(401, "reauth_required", "req-1")));

    await open("/protected", protectedPage());

    expect(await screen.findByRole("heading", { name: "Protected page" })).toBeTruthy();
    await act(async () => {
      await Promise.resolve();
    });
    expect(window.location.pathname).toBe("/protected");
    expect(screen.queryByText("Your session has ended")).toBeNull();
  });

  it("does not leave the page for any other failure", async () => {
    stubApi(() => Promise.resolve(problem(403, "forbidden", "req-1")));

    await open("/protected", protectedPage());

    expect(await screen.findByRole("heading", { name: "Protected page" })).toBeTruthy();
    await act(async () => {
      await Promise.resolve();
    });
    expect(window.location.pathname).toBe("/protected");
  });
});

describe("a visitor who is not signed in", () => {
  it("is sent to /login?next=<the page they asked for> before the page is shown", async () => {
    stubSessionCheck("unauthenticated", 401);

    await open("/protected?tab=plan#top", protectedPage());

    await waitFor(() => {
      expect(window.location.pathname).toBe("/login");
    });
    expect(window.location.search).toBe(`?next=${encodeURIComponent("/protected?tab=plan#top")}`);
    expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Protected page" })).toBeNull();
    expect(screen.getAllByText("Your session has ended")).toHaveLength(1);
  });

  it("is sent to /login from the home page too", async () => {
    stubSessionCheck("unauthenticated", 401);

    await open("/", protectedPage());

    expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeTruthy();
    expect(window.location.pathname).toBe("/login");
  });

  it("sees the error page, not the app, when the session check fails for another reason", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    stubSessionCheck("unavailable", 503);

    await open("/protected", protectedPage());

    expect(await screen.findByText("Something went wrong")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Protected page" })).toBeNull();
    expect(window.location.pathname).toBe("/protected");
  });
});

describe("a 401 from /api/config", () => {
  it("shows the failure view and does not navigate", async () => {
    vi.stubGlobal("fetch", vi.fn<Transport>(() => Promise.resolve(problem(401, "unauthenticated", "req-1"))));
    window.history.replaceState(null, "", "/protected");
    const App = createWebApp({ extensions: [] });

    await renderApp(<App />);

    expect(await screen.findByText("The app could not be loaded")).toBeTruthy();
    expect(window.location.pathname).toBe("/protected");
  });
});

describe("the session expiry handler with a memory history", () => {
  function mount(entry: string, session: "in" | "out" = "in") {
    stubSessionCheck(session === "in" ? "ok" : "unauthenticated", session === "in" ? 200 : 401);
    const history = createMemoryHistory({ initialEntries: [entry] });
    const queryClient = createQueryClient();
    const expiry = createSessionExpiry();
    const router = createAppRouter({ queryClient, api: createApiClient({ onUnauthenticated: expiry.notify }) }, [], history);
    return {
      history,
      expiry,
      ui: (
        <ThemeProvider>
          <ConfigProvider config={{ ...CONFIG_BODY, locales: ["en", "de"] }}>
            <I18nProvider>
              <QueryClientProvider client={queryClient}>
                <FeedbackToastProvider regionLabel="Notifications">
                  <SessionExpiryHandler expiry={expiry} router={router} />
                  <ExtensionsProvider extensions={[]}>
                    <RouterProvider router={router} />
                  </ExtensionsProvider>
                </FeedbackToastProvider>
              </QueryClientProvider>
            </I18nProvider>
          </ConfigProvider>
        </ThemeProvider>
      ),
    };
  }

  it("replaces the current entry with the sign-in page that remembers the path, search and hash", async () => {
    const { history, expiry, ui } = mount("/missing/page?tab=plan#top");
    await renderApp(ui);
    await screen.findByRole("main");

    act(() => {
      expiry.notify();
    });

    expect(history.location.pathname).toBe("/login");
    expect(history.location.search).toBe(`?next=${encodeURIComponent("/missing/page?tab=plan#top")}`);
    expect(await screen.findByText("Your session has ended")).toBeTruthy();
    expect(history.length).toBe(1);
  });

  it("leaves the sign-in page where it is, without a second toast", async () => {
    const { history, expiry, ui } = mount("/login?next=%2Fprotected", "out");
    await renderApp(ui);
    await screen.findByRole("main");

    act(() => {
      expiry.notify();
      expiry.notify();
    });

    expect(history.location.href).toBe("/login?next=%2Fprotected");
    expect(history.length).toBe(1);
    expect(screen.queryByText("Your session has ended")).toBeNull();
  });
});
