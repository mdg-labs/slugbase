import { createHandlers, scenarioFromSearch, type Scenario } from "@slugbase/testing/msw";
import { createMockServer, readOpenApiDocument } from "@slugbase/testing/msw/node";
import { screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiProblemError, createApiClient } from "../src/api/client.ts";
import { createWebApp } from "../src/index.ts";
import { renderApp, stubMatchMedia } from "./support.tsx";

// The web app against the handlers generated from openapi.json (doc 08 section 7),
// through the app's own API client and no stubbed transport: the same handlers
// `pnpm dev:web --mock` serves in the browser.

const server = createMockServer();

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
  stubMatchMedia();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
});

function answerConfigWith(status: number): void {
  const scenario: Scenario = { name: "config-error", statuses: { getApiConfig: status } };
  server.use(...createHandlers(readOpenApiDocument(), { scenario }));
}

describe("the web app against the generated handlers", () => {
  it("reads /api/config through the API client", async () => {
    const { data } = await createApiClient().GET("/api/config");
    expect(data?.product.name).toBe("SlugBase Mock");
  });

  it("renders the shell with the product name of the mocked /api/config", async () => {
    const App = createWebApp({ extensions: [] });

    await renderApp(<App />);

    expect(await screen.findByRole("heading", { name: "Welcome to SlugBase Mock" })).toBeTruthy();
  });

  it("turns a declared problem response into an ApiProblemError", async () => {
    answerConfigWith(400);

    const error = await createApiClient()
      .GET("/api/config")
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(ApiProblemError);
    expect(error).toMatchObject({ code: "bad_request", status: 400, requestId: "mock-request" });
  });

  it("shows the failure view with the mock request id when /api/config answers a problem", async () => {
    answerConfigWith(400);
    const App = createWebApp({ extensions: [] });

    await renderApp(<App />);

    expect(await screen.findByText("The app could not be loaded")).toBeTruthy();
    expect(screen.getByText("mock-request")).toBeTruthy();
  });

  it("follows the scenario the search string names", () => {
    expect(scenarioFromSearch("?scenario=default").name).toBe("default");
  });
});
