import { createHandlers, type Scenario } from "@slugbase/testing/msw";
import { createMockServer, readOpenApiDocument } from "@slugbase/testing/msw/node";
import { act, fireEvent, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebApp } from "../src/index.ts";
import { renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The sign-in page against the handlers generated from openapi.json, through the app's own API client:
// the generated 401 and 429 answers of the sign-in operation and the 200 and 401 of the session check.
// The generated 200 of the sign-in operation carries a placeholder `Set-Cookie` value that the MSW
// server cannot store, so the successful sign-in is covered in login.test.tsx with a stubbed transport.

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

describe("the sign-in page against the generated handlers", () => {
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
