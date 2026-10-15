import type { ComponentTypes } from "@slugbase/contracts";
import { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createWebApp } from "../src/index.ts";
import { ACCOUNT_BODY, CONFIG_BODY, ME_PATH, SESSION_PATH, SESSION_BODY, json, problem, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// /settings/account/tokens (doc 03 section 11.3). The failure scenarios are a secret that stays in the cache or on the
// page after the card closed, a card that can be closed before the secret was saved, a refusal (limit, name, re-authentication)
// that is shown as a success or not shown, a revoke that is sent without the confirmation or that leaves the list stale, and
// a list that failed to load shown as an empty one.

type Transport = (request: Request) => Promise<Response>;
type ApiToken = ComponentTypes["schemas"]["ApiToken"];

const TOKENS_PATH = "/api/v1/me/api-tokens";
const OTHER_WORKSPACE = "0192f3a0-dddd-7000-8000-000000000002";
const ACTIVE_WORKSPACE = "0192f3a0-dddd-7000-8000-000000000001";
const FAKE_SECRET = "slb_test-only-secret";

const DEPLOY: ApiToken = {
  id: "0192f3a0-eeee-7000-8000-000000000001",
  name: "Deploy script",
  workspaceId: ACTIVE_WORKSPACE,
  workspaceName: "Home",
  scope: "read-write",
  prefix: "aaaaaa",
  createdAt: "2026-10-01T08:00:00.000Z",
  lastUsedAt: "2026-10-14T09:30:00.000Z",
  expiresAt: "2027-01-01T08:00:00.000Z",
};
const REPORTS: ApiToken = {
  ...DEPLOY,
  id: "0192f3a0-eeee-7000-8000-000000000002",
  name: "Reports",
  workspaceName: "Team",
  workspaceId: OTHER_WORKSPACE,
  scope: "read",
  prefix: "bbbbbb",
  lastUsedAt: null,
  expiresAt: null,
};

interface Call {
  readonly method: string;
  readonly path: string;
  readonly contentType: string | null;
  readonly body: unknown;
}

interface Handlers {
  list?: (call: number) => Response | Promise<Response>;
  create?: (call: number) => Response | Promise<Response> | undefined;
  revoke?: (call: number) => Response | Promise<Response> | undefined;
}

interface Server {
  readonly calls: Call[];
  readonly to: (method: string, path: string) => Call[];
}

function reauthRequired(): Response {
  return problem(401, "reauth_required", "req-reauth");
}

function withErrors(status: number, code: string, errors: readonly { path: string; code: string }[]): Response {
  return json(
    { type: `https://slugbase.app/problems/${code}`, title: code, status, code, detail: "x", requestId: "req-422", errors },
    { status, contentType: "application/problem+json" },
  );
}

const ME_WITH_WORKSPACES = {
  account: ACCOUNT_BODY,
  memberships: [
    { workspaceId: ACTIVE_WORKSPACE, name: "Home", role: "owner" },
    { workspaceId: OTHER_WORKSPACE, name: "Team", role: "member" },
  ],
  activeWorkspaceId: OTHER_WORKSPACE,
};

/** A server with a signed-in account whose tokens are `initial`; a created token joins the list and a revoked one leaves it. */
function stubServer(handlers: Handlers = {}, initial: readonly ApiToken[] = [DEPLOY, REPORTS], me: object = ME_WITH_WORKSPACES): Server {
  let listed = [...initial];
  const calls: Call[] = [];
  const count = (method: string, path: string): number => calls.filter((call) => call.method === method && call.path === path).length;
  const fetch = vi.fn<Transport>(async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/config") {
      return json(CONFIG_BODY);
    }
    const text = request.method === "GET" || request.method === "HEAD" ? "" : await request.clone().text();
    calls.push({
      method: request.method,
      path: pathname,
      contentType: request.headers.get("Content-Type"),
      body: text === "" ? undefined : (JSON.parse(text) as unknown),
    });
    if (pathname === ME_PATH) {
      return json(me);
    }
    if (pathname === SESSION_PATH) {
      return json(SESSION_BODY);
    }
    if (pathname === "/api/v1/me/reauth") {
      return new Response(null, { status: 204 });
    }
    if (pathname === TOKENS_PATH && request.method === "GET") {
      return handlers.list?.(count("GET", TOKENS_PATH)) ?? json({ items: listed, nextCursor: null });
    }
    if (pathname === TOKENS_PATH && request.method === "POST") {
      const answer = await (handlers.create?.(count("POST", TOKENS_PATH)) ?? undefined);
      if (answer !== undefined) {
        return answer;
      }
      const body = JSON.parse(text) as { name: string; scope: ApiToken["scope"]; workspaceId: string };
      const created: ApiToken = { ...DEPLOY, id: "0192f3a0-eeee-7000-8000-000000000003", name: body.name, scope: body.scope, prefix: "cccccc" };
      listed = [created, ...listed];
      return json({ ...created, token: FAKE_SECRET }, { status: 201 });
    }
    if (request.method === "DELETE" && pathname.startsWith(`${TOKENS_PATH}/`)) {
      const answer = await (handlers.revoke?.(count("DELETE", pathname)) ?? undefined);
      if (answer !== undefined) {
        return answer;
      }
      const id = pathname.slice(TOKENS_PATH.length + 1);
      listed = listed.filter((token) => token.id !== id);
      return new Response(null, { status: 204 });
    }
    return problem(404, "not_found", "req-404");
  });
  vi.stubGlobal("fetch", fetch);
  return { calls, to: (method, path) => calls.filter((call) => call.method === method && call.path === path) };
}

/** The QueryClient the app mounted: `QueryClientProvider` calls `mount()` on the client it was given. */
let mounted: MockInstance<QueryClient["mount"]>;

/** Everything the app's query and mutation caches hold, as text, so a secret cannot hide in a key, a variable or a result. */
function cacheContents(): string {
  const client = mounted.mock.contexts[0] as QueryClient | undefined;
  expect(client).toBeDefined();
  const queries = client?.getQueryCache().getAll() ?? [];
  const mutations = client?.getMutationCache().getAll() ?? [];
  // The tokens query is in the cache, so an empty read cannot make the assertions below pass.
  expect(queries.some((query) => JSON.stringify(query.queryKey).includes("api-tokens"))).toBe(true);
  return JSON.stringify([
    ...queries.map((query) => [query.queryKey, query.state.data, query.state.error]),
    ...mutations.map((mutation) => [mutation.options.mutationKey, mutation.state]),
  ]);
}

async function openTokens(): Promise<void> {
  window.history.replaceState(null, "", "/settings/account/tokens");
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
  await screen.findByRole("heading", { level: 1, name: "API tokens" });
}

async function act_(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

async function click(name: string | RegExp, scope?: HTMLElement): Promise<void> {
  const root = scope === undefined ? screen : within(scope);
  await act_(() => {
    fireEvent.click(root.getByRole("button", { name }));
  });
}

async function choose(select: string, option: string): Promise<void> {
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

function tokenRows(): HTMLElement[] {
  return within(screen.getByRole("table", { name: "API tokens" })).getAllByRole("row").slice(1);
}

async function openCreate(): Promise<HTMLElement> {
  await screen.findByRole("table", { name: "API tokens" });
  await waitFor(() => {
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "New token" }).disabled).toBe(false);
  });
  await click("New token");
  return screen.findByRole("dialog", { name: "New API token" });
}

async function fillAndCreate(dialog: HTMLElement, name = "CI"): Promise<void> {
  fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: name } });
  await click("Create token", dialog);
}

beforeEach(() => {
  mounted = vi.spyOn(QueryClient.prototype, "mount");
  stubBrowserApis();
  stubMatchMedia(false);
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("lang");
});

describe("the tokens page", () => {
  it("opens from the API tokens link of the settings navigation", async () => {
    stubServer();
    window.history.replaceState(null, "", "/settings/account");
    const App = createWebApp({ extensions: [] });
    await renderApp(<App />);
    const nav = await screen.findByRole("navigation", { name: "Settings" });

    await act_(() => {
      fireEvent.click(within(nav).getByRole("link", { name: "API tokens" }));
    });

    expect(await screen.findByRole("heading", { level: 1, name: "API tokens" })).toBeTruthy();
    expect(window.location.pathname).toBe("/settings/account/tokens");
    expect(within(screen.getByRole("navigation", { name: "Settings" })).getByRole("link", { name: "API tokens" }).getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("lists name, workspace, scope, prefix, created, last used and expiry, with Never and No expiry for the empty dates", async () => {
    stubServer();
    await openTokens();
    await waitFor(() => {
      expect(tokenRows()).toHaveLength(2);
    });

    const [deploy, reports] = tokenRows() as [HTMLElement, HTMLElement];
    const cells = (row: HTMLElement): string[] => within(row).getAllByRole("cell").map((cell) => cell.textContent);
    expect(cells(deploy).slice(0, 4)).toEqual(["Deploy script", "Home", "Read and write", "slb_aaaaaa"]);
    expect(cells(deploy)[4]).toContain("2026");
    expect(cells(deploy)[5]).toContain("2026");
    expect(cells(deploy)[6]).toContain("2027");
    expect(cells(reports).slice(0, 4)).toEqual(["Reports", "Team", "Read", "slb_bbbbbb"]);
    expect(cells(reports).slice(5, 7)).toEqual(["Never", "No expiry"]);
    expect(within(deploy).getByText("slb_aaaaaa").className).toContain("font-mono");
  });

  it("says there are no tokens, and how to make one, when the list is empty", async () => {
    stubServer({}, []);
    await openTokens();

    expect(await screen.findByText("No tokens yet")).toBeTruthy();
    expect(screen.getByText("Create one to authenticate scripts or integrations.")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "API tokens" })).toBeNull();
  });

  it("shows a loading skeleton until the list arrives", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubServer({
      list: async () => {
        await gate;
        return json({ items: [DEPLOY], nextCursor: null });
      },
    });
    await openTokens();

    expect(screen.getByRole("status", { name: "Loading" })).toBeTruthy();
    expect(screen.queryByText("No tokens yet")).toBeNull();
    await act(async () => {
      release();
      await gate;
    });
    await waitFor(() => {
      expect(tokenRows()).toHaveLength(1);
    });
    expect(screen.queryByRole("status", { name: "Loading" })).toBeNull();
  });

  it("says the list could not be loaded, instead of showing it as empty, and loads it again on retry", async () => {
    stubServer({ list: (call) => (call <= 3 ? problem(503, "unavailable", "req-503") : json({ items: [DEPLOY], nextCursor: null })) });
    await openTokens();

    expect(await screen.findByText("Your API tokens could not be loaded", undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText("No tokens yet")).toBeNull();
    await click("Try again");

    await waitFor(() => {
      expect(tokenRows()).toHaveLength(1);
    });
    expect(screen.queryByText("Your API tokens could not be loaded")).toBeNull();
  });
});

describe("creating a token", () => {
  it("offers the memberships with the active workspace chosen, Read, and 90 days, and sends what was chosen", async () => {
    const server = stubServer();
    await openTokens();
    const dialog = await openCreate();

    expect(within(dialog).getByRole("combobox", { name: "Workspace" }).textContent).toContain("Team");
    expect(within(dialog).getByRole<HTMLInputElement>("radio", { name: "Read" }).getAttribute("aria-checked")).toBe("true");
    expect(within(dialog).getByRole("combobox", { name: "Expires" }).textContent).toContain("90 days");

    await choose("Workspace", "Home");
    await act_(() => {
      fireEvent.click(within(dialog).getByRole("radio", { name: "Read and write" }));
    });
    await choose("Expires", "Never");
    await fillAndCreate(dialog, "  CI  ");

    await screen.findByRole("dialog", { name: "Copy your token" });
    expect(server.to("POST", TOKENS_PATH).map((call) => call.body)).toEqual([
      { name: "CI", scope: "read-write", expiresInDays: null, workspaceId: ACTIVE_WORKSPACE },
    ]);
    expect(server.to("POST", TOKENS_PATH)[0]?.contentType).toBe("application/json");
  });

  it("sends the defaults when nothing else is chosen", async () => {
    const server = stubServer();
    await openTokens();
    const dialog = await openCreate();

    await fillAndCreate(dialog);

    await screen.findByRole("dialog", { name: "Copy your token" });
    expect(server.to("POST", TOKENS_PATH).map((call) => call.body)).toEqual([
      { name: "CI", scope: "read", expiresInDays: 90, workspaceId: OTHER_WORKSPACE },
    ]);
  });

  it("asks for a name before sending anything", async () => {
    const server = stubServer();
    await openTokens();
    const dialog = await openCreate();

    await click("Create token", dialog);

    expect(within(dialog).getByText("Enter a name.")).toBeTruthy();
    expect(within(dialog).getByLabelText("Name").getAttribute("aria-invalid")).toBe("true");
    expect(server.to("POST", TOKENS_PATH)).toEqual([]);
  });

  it("shows the secret once with a curl example for the deployment origin and the placeholder, and keeps Done disabled until it is acknowledged", async () => {
    stubServer();
    await openTokens();
    const dialog = await openCreate();
    await fillAndCreate(dialog);

    const result = await screen.findByRole("dialog", { name: "Copy your token" });
    expect(within(result).getByRole<HTMLInputElement>("textbox", { name: "API token" }).value).toBe(FAKE_SECRET);
    const example = within(result).getByRole<HTMLInputElement>("textbox", { name: "Example request" }).value;
    expect(example).toBe(`curl -H "Authorization: Bearer <your API token>" ${CONFIG_BODY.origin}/api/v1/me`);
    expect(example).not.toContain(FAKE_SECRET);
    expect(within(result).getByRole<HTMLButtonElement>("button", { name: "Done" }).disabled).toBe(true);
    expect(within(result).queryByRole("button", { name: "Cancel" })).toBeNull();

    // Escape does not drop a secret that was not saved.
    await act_(() => {
      fireEvent.keyDown(result, { key: "Escape" });
    });
    expect(screen.getByRole("dialog", { name: "Copy your token" })).toBeTruthy();

    await act_(() => {
      fireEvent.click(within(result).getByRole("checkbox", { name: "I have saved this token" }));
    });
    expect(within(result).getByRole<HTMLButtonElement>("button", { name: "Done" }).disabled).toBe(false);
  });

  it("drops the secret from the page and from the caches when the card closes, and lists the new token", async () => {
    const server = stubServer();
    await openTokens();
    const listsBefore = server.to("GET", TOKENS_PATH).length;
    const dialog = await openCreate();
    await fillAndCreate(dialog, "CI");
    const result = await screen.findByRole("dialog", { name: "Copy your token" });
    await act_(() => {
      fireEvent.click(within(result).getByRole("checkbox", { name: "I have saved this token" }));
    });
    expect(cacheContents()).not.toContain(FAKE_SECRET);

    await click("Done", result);

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Copy your token" })).toBeNull();
    });
    expect(document.body.textContent).not.toContain(FAKE_SECRET);
    expect(screen.queryByDisplayValue(FAKE_SECRET)).toBeNull();
    expect(cacheContents()).not.toContain(FAKE_SECRET);
    await waitFor(() => {
      expect(server.to("GET", TOKENS_PATH).length).toBeGreaterThan(listsBefore);
      expect(tokenRows().map((row) => within(row).getAllByRole("cell")[0]?.textContent)).toEqual(["CI", "Deploy script", "Reports"]);
    });
  });

  it("opens the re-authentication prompt on reauth_required, and creates the token once the password is confirmed", async () => {
    const server = stubServer({ create: (call) => (call === 1 ? reauthRequired() : undefined) });
    await openTokens();
    const dialog = await openCreate();

    await fillAndCreate(dialog);
    const prompt = await screen.findByRole("dialog", { name: "Confirm it is you" });
    expect(screen.queryByRole("dialog", { name: "Copy your token" })).toBeNull();
    fireEvent.change(within(prompt).getByLabelText("Password"), { target: { value: "old password 1" } });
    await click("Confirm", prompt);

    expect(await screen.findByRole("dialog", { name: "Copy your token" })).toBeTruthy();
    expect(server.to("POST", "/api/v1/me/reauth").map((call) => call.body)).toEqual([{ password: "old password 1" }]);
    expect(server.to("POST", TOKENS_PATH)).toHaveLength(2);
  });

  it("says in the form that it needs the member's confirmation when they close the re-authentication prompt, and creates nothing", async () => {
    const server = stubServer({ create: () => reauthRequired() });
    await openTokens();
    const dialog = await openCreate();

    await fillAndCreate(dialog);
    const prompt = await screen.findByRole("dialog", { name: "Confirm it is you" });
    await click("Cancel", prompt);

    expect(await screen.findByText("Confirm it is you to continue.")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Copy your token" })).toBeNull();
    expect(server.to("POST", TOKENS_PATH)).toHaveLength(1);
  });

  it("explains the limit of 10 tokens under the name from the field error, and shows no secret", async () => {
    stubServer({ create: () => withErrors(422, "validation_failed", [{ path: "name", code: "api_token_limit_reached" }]) });
    await openTokens();
    const dialog = await openCreate();

    await fillAndCreate(dialog);

    expect(await within(dialog).findByText(/reached the limit of 10 tokens/)).toBeTruthy();
    expect(within(dialog).getByLabelText("Name").getAttribute("aria-invalid")).toBe("true");
    expect(screen.queryByRole("dialog", { name: "Copy your token" })).toBeNull();
    expect(document.body.textContent).not.toContain(FAKE_SECRET);
  });

  it("says the name is taken under the name", async () => {
    stubServer({ create: () => problem(409, "name_taken", "req-409") });
    await openTokens();
    const dialog = await openCreate();

    await fillAndCreate(dialog);

    expect(await within(dialog).findByText("You already have a token with this name. Choose another name.")).toBeTruthy();
    expect(within(dialog).getByLabelText("Name").getAttribute("aria-invalid")).toBe("true");
  });

  it.each([
    ["a server failure", () => problem(503, "unavailable", "req-503"), "That did not work. Try again in a moment."],
    [
      "too many requests",
      () => json({ type: "x", title: "x", status: 429, code: "rate_limited", detail: "x", requestId: "r" }, { status: 429, contentType: "application/problem+json", headers: { "Retry-After": "120" } }),
      "Too many attempts. Try again in 2 minutes.",
    ],
  ])("says so in the form on %s, without a result card", async (_name, answer, message) => {
    stubServer({ create: answer });
    await openTokens();
    const dialog = await openCreate();

    await fillAndCreate(dialog);

    expect(await within(dialog).findByText(message)).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Copy your token" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Create token" })).toBeTruthy();
  });

  it("offers no new token to an account without a workspace membership", async () => {
    stubServer({}, [], { account: ACCOUNT_BODY, memberships: [], activeWorkspaceId: null });
    await openTokens();
    await screen.findByText("No tokens yet");

    expect(screen.getByRole<HTMLButtonElement>("button", { name: "New token" }).disabled).toBe(true);
  });
});

describe("revoking a token", () => {
  it("sends nothing before the confirmation, and then revokes the token and reloads the list", async () => {
    const server = stubServer();
    await openTokens();
    await waitFor(() => {
      expect(tokenRows()).toHaveLength(2);
    });

    await click("Revoke the token Deploy script");
    const confirm = await screen.findByRole("alertdialog", { name: "Revoke Deploy script?" });
    expect(server.calls.filter((call) => call.method === "DELETE")).toEqual([]);
    await click("Revoke", confirm);

    await waitFor(() => {
      expect(tokenRows()).toHaveLength(1);
    });
    expect(server.to("DELETE", `${TOKENS_PATH}/${DEPLOY.id}`)).toHaveLength(1);
    expect(screen.getByText("Token revoked")).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("does not revoke when the confirmation is cancelled", async () => {
    const server = stubServer();
    await openTokens();
    await waitFor(() => {
      expect(tokenRows()).toHaveLength(2);
    });

    await click("Revoke the token Deploy script");
    const confirm = await screen.findByRole("alertdialog", { name: "Revoke Deploy script?" });
    await click("Cancel", confirm);

    expect(server.calls.filter((call) => call.method === "DELETE")).toEqual([]);
    expect(tokenRows()).toHaveLength(2);
  });

  it("shows an error toast, keeps the token listed and asks for the list again when the revocation fails", async () => {
    const server = stubServer({ revoke: () => problem(503, "unavailable", "req-503") });
    await openTokens();
    await waitFor(() => {
      expect(tokenRows()).toHaveLength(2);
    });
    const listsBefore = server.to("GET", TOKENS_PATH).length;

    await click("Revoke the token Deploy script");
    await click("Revoke", await screen.findByRole("alertdialog", { name: "Revoke Deploy script?" }));

    expect((await screen.findAllByText("The change was not saved")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Request ID: req-503/).length).toBeGreaterThan(0);
    expect(screen.queryByText("Token revoked")).toBeNull();
    expect(tokenRows()).toHaveLength(2);
    await waitFor(() => {
      expect(server.to("GET", TOKENS_PATH).length).toBeGreaterThan(listsBefore);
    });
  });
});

describe("in German", () => {
  it("shows the page in the catalog's words", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-DE", "de"]);
    stubServer({}, [], { account: { ...ACCOUNT_BODY, locale: "de" }, memberships: [], activeWorkspaceId: null });
    window.history.replaceState(null, "", "/settings/account/tokens");
    const App = createWebApp({ extensions: [] });
    await renderApp(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "API-Tokens" })).toBeTruthy();
    expect(await screen.findByText("Noch keine Tokens")).toBeTruthy();
    expect(screen.getByText("Erstelle eines, um Skripte oder Integrationen zu authentifizieren.")).toBeTruthy();
  });
});
