import { ThemeProvider } from "@slugbase/ui";
import { FeedbackToastProvider } from "@slugbase/ui/patterns";
import { createHandlers, type Scenario } from "@slugbase/testing/msw";
import { createMockServer, readOpenApiDocument } from "@slugbase/testing/msw/node";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { act, fireEvent, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/api/client.ts";
import { ConfigProvider } from "../src/config/config-context.tsx";
import { ExtensionsProvider } from "../src/extensions/index.ts";
import { I18nProvider } from "../src/i18n/i18n-provider.tsx";
import { createWebApp } from "../src/index.ts";
import { createQueryClient } from "../src/query-client.ts";
import { createAppRouter } from "../src/router.ts";
import { CONFIG_BODY, PRODUCT_NAME, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The sign-in page against the handlers generated from openapi.json, through the app's own API client:
// the generated 200, 401 and 429 answers of the sign-in operation and the 200 and 401 of the session check.
// The request bodies, a delayed answer and the answers the document does not declare stay in login.test.tsx,
// which stubs the transport.

const server = createMockServer();
const document_ = readOpenApiDocument();

function answer(name: string, statuses: Scenario["statuses"]): void {
  server.use(...createHandlers(document_, { scenario: { name, statuses } }));
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function openLoginSignedOut(): Promise<void> {
  answer("signed-out", { listSessions: 401 });
  window.history.replaceState(null, "", "/login?next=%2Fmissing");
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
  await screen.findByRole("heading", { level: 1, name: "Sign in" });
}

async function signIn(): Promise<void> {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.org" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await Promise.resolve();
  });
}

/** The app signed out at `path`, on its own query client and a memory history so the cache and the route can be read. */
async function mountLogin(path: string) {
  answer("signed-out", { listSessions: 401 });
  const history = createMemoryHistory({ initialEntries: [path] });
  const queryClient = createQueryClient();
  const router = createAppRouter({ queryClient, api: createApiClient({ onUnauthenticated: () => undefined }) }, [], history);
  await renderApp(
    <ThemeProvider>
      <ConfigProvider config={{ ...CONFIG_BODY, locales: ["en", "de"] }}>
        <I18nProvider>
          <QueryClientProvider client={queryClient}>
            <FeedbackToastProvider regionLabel="Notifications">
              <ExtensionsProvider extensions={[]}>
                <RouterProvider router={router} />
              </ExtensionsProvider>
            </FeedbackToastProvider>
          </QueryClientProvider>
        </I18nProvider>
      </ConfigProvider>
    </ThemeProvider>,
  );
  await screen.findByRole("heading", { level: 1, name: "Sign in" });
  return { history, queryClient };
}

describe("the sign-in page against the generated handlers", () => {
  it("clears the cache and goes to the page named by a relative next, with its search and hash, when the sign-in operation answers 200", async () => {
    const { history, queryClient } = await mountLogin(`/login?next=${encodeURIComponent("/missing/page?tab=plan#top")}`);
    queryClient.setQueryData(["bookmarks"], ["cached for the previous visitor"]);
    answer("signed-in", { login: 200 });

    await signIn();

    expect(await screen.findByRole("heading", { level: 1, name: "This page doesn't exist" })).toBeTruthy();
    expect(history.location.pathname + history.location.search + history.location.hash).toBe("/missing/page?tab=plan#top");
    expect(queryClient.getQueryData(["bookmarks"])).toBeUndefined();
  });

  it.each([
    ["an absolute URL", "https://evil.example/phish"],
    ["a protocol-relative URL", "//evil.example/phish"],
    ["a javascript: value", "javascript:alert(1)"],
    ["a backslash host", "/\\evil.example"],
    ["a tab inside the slashes", "/\t/evil.example"],
    ["a bare word", "missing"],
  ])("goes home when the sign-in operation answers 200 and next is %s", async (_name, next) => {
    const { history } = await mountLogin(`/login?next=${encodeURIComponent(next)}`);
    answer("signed-in", { login: 200 });

    await signIn();

    expect(await screen.findByRole("heading", { level: 1, name: `Welcome to ${PRODUCT_NAME}` })).toBeTruthy();
    expect(history.location.pathname).toBe("/");
    expect(window.location.origin).toBe("http://localhost:3000");
  });

  it("sends a signed-in visitor away from /login when the session check answers 200", async () => {
    window.history.replaceState(null, "", "/login");
    const App = createWebApp({ extensions: [] });

    await renderApp(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "Welcome to SlugBase Mock" })).toBeTruthy();
    expect(window.location.pathname).toBe("/");
  });

  it("shows the generic message when the sign-in operation answers 401", async () => {
    await openLoginSignedOut();
    answer("wrong-credentials", { listSessions: 401, login: 401 });

    await signIn();

    expect((await screen.findByRole("alert")).textContent).toContain("The email address or the password is wrong.");
    expect(window.location.pathname).toBe("/login");
  });

  it("shows a wait message when the sign-in operation answers 429", async () => {
    await openLoginSignedOut();
    answer("rate-limited", { listSessions: 401, login: 429 });

    await signIn();

    expect((await screen.findByRole("alert")).textContent).toContain("Too many sign-in attempts.");
    expect(window.location.pathname).toBe("/login");
  });
});
