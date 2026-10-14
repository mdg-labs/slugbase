import { ThemeProvider } from "@slugbase/ui";
import { FeedbackToastProvider } from "@slugbase/ui/patterns";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/api/client.ts";
import { ConfigProvider } from "../src/config/config-context.tsx";
import { ExtensionsProvider } from "../src/extensions/index.ts";
import { I18nProvider } from "../src/i18n/i18n-provider.tsx";
import { createQueryClient } from "../src/query-client.ts";
import { createAppRouter } from "../src/router.ts";
import { MutationErrorToasts } from "../src/shell/mutation-error-toasts.tsx";
import { createSessionExpiry, SessionExpiryHandler } from "../src/shell/session-expiry.tsx";
import { CONFIG_BODY, PRODUCT_NAME, SESSION_PATH, problem, renderApp, signedIn, stubBrowserApis, stubMatchMedia } from "./support.tsx";

type Transport = (request: Request) => Promise<Response>;

const LOGOUT_PATH = "/api/v1/auth/logout";

/** The app signed in at `/`, with `logout` answering the sign-out. Once it answers `204` or `401` there is no session. */
function mount(logout: Transport) {
  let ended = false;
  const fetch = vi.fn<Transport>((request) => {
    const { pathname } = new URL(request.url);
    if (pathname === LOGOUT_PATH) {
      return logout(request).then((response) => {
        ended ||= response.status === 204 || response.status === 401;
        return response;
      });
    }
    if (pathname === SESSION_PATH && ended) {
      return Promise.resolve(problem(401, "unauthenticated", "req-session"));
    }
    return signedIn(request);
  });
  vi.stubGlobal("fetch", fetch);
  const history = createMemoryHistory({ initialEntries: ["/"] });
  const queryClient = createQueryClient();
  const expiry = createSessionExpiry();
  const api = createApiClient({
    onUnauthenticated: () => {
      queryClient.clear();
      expiry.notify();
    },
  });
  const router = createAppRouter({ queryClient, api }, [], history);
  const ui = (
    <ThemeProvider>
      <ConfigProvider config={{ ...CONFIG_BODY, locales: ["en", "de"] }}>
        <I18nProvider>
          <QueryClientProvider client={queryClient}>
            <FeedbackToastProvider regionLabel="Notifications">
              <MutationErrorToasts />
              <SessionExpiryHandler expiry={expiry} router={router} />
              <ExtensionsProvider extensions={[]}>
                <RouterProvider router={router} />
              </ExtensionsProvider>
            </FeedbackToastProvider>
          </QueryClientProvider>
        </I18nProvider>
      </ConfigProvider>
    </ThemeProvider>
  );
  return { fetch, history, queryClient, ui };
}

async function chooseSignOut(): Promise<void> {
  await act(async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Account" }));
    await Promise.resolve();
  });
  await act(async () => {
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    await Promise.resolve();
  });
}

const callsTo = (fetch: ReturnType<typeof vi.fn<Transport>>, path: string): Request[] =>
  fetch.mock.calls.map(([request]) => request).filter((request) => new URL(request.url).pathname === path);

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Sign out in the account menu", () => {
  it("posts to /auth/logout, clears the cached queries and routes to /login", async () => {
    const { fetch, history, queryClient, ui } = mount(() => Promise.resolve(new Response(null, { status: 204 })));
    await renderApp(ui);
    await screen.findByRole("heading", { level: 1, name: `Welcome to ${PRODUCT_NAME}` });
    queryClient.setQueryData(["bookmarks"], ["cached for the signed-in account"]);

    await chooseSignOut();

    expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeTruthy();
    const logouts = callsTo(fetch, LOGOUT_PATH);
    expect(logouts).toHaveLength(1);
    expect(logouts[0]?.method).toBe("POST");
    expect(history.location.pathname).toBe("/login");
    expect(history.location.search).toBe("");
    expect(queryClient.getQueryData(["bookmarks"])).toBeUndefined();
    expect(queryClient.getQueryCache().getAll().filter((query) => query.queryKey[0] === "bookmarks")).toHaveLength(0);
    expect(screen.queryByText("Your session has ended")).toBeNull();
  });

  it("is written in German", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-AT"]);
    const { ui } = mount(() => Promise.resolve(new Response(null, { status: 204 })));
    await renderApp(ui);

    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Konto" }));
      await Promise.resolve();
    });

    expect(await screen.findByRole("menuitem", { name: "Abmelden" })).toBeTruthy();
  });

  it("stays signed in and says so when the server could not end the session", async () => {
    const { history, queryClient, ui } = mount(() => Promise.resolve(problem(503, "unavailable", "req-1")));
    await renderApp(ui);
    await screen.findByRole("heading", { level: 1, name: `Welcome to ${PRODUCT_NAME}` });
    queryClient.setQueryData(["bookmarks"], ["cached"]);

    await chooseSignOut();

    expect((await screen.findAllByText("You are still signed in")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Signing out did not work. Try again.").length).toBeGreaterThan(0);
    expect(history.location.pathname).toBe("/");
    expect(queryClient.getQueryData(["bookmarks"])).toEqual(["cached"]);
    expect(screen.queryByText("The change was not saved")).toBeNull();
  });

  it("stays signed in and says so when the request cannot be sent", async () => {
    const { history, ui } = mount(() => Promise.reject(new TypeError("fetch failed")));
    await renderApp(ui);
    await screen.findByRole("heading", { level: 1, name: `Welcome to ${PRODUCT_NAME}` });

    await chooseSignOut();

    expect((await screen.findAllByText("You are still signed in")).length).toBeGreaterThan(0);
    expect(history.location.pathname).toBe("/");
  });

  it("lands on the sign-in page, with the session-ended toast, when the session had already ended", async () => {
    const { history, ui } = mount(() => Promise.resolve(problem(401, "unauthenticated", "req-1")));
    await renderApp(ui);
    await screen.findByRole("heading", { level: 1, name: `Welcome to ${PRODUCT_NAME}` });

    await chooseSignOut();

    await waitFor(() => {
      expect(history.location.pathname).toBe("/login");
    });
    expect((await screen.findAllByText("Your session has ended")).length).toBeGreaterThan(0);
    expect(screen.queryByText("You are still signed in")).toBeNull();
  });
});
