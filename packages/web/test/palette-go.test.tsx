import type { ComponentTypes } from "@slugbase/contracts";
import { createHandlers, createResolverHandlers } from "@slugbase/testing/msw";
import { createMockServer, readOpenApiDocument } from "@slugbase/testing/msw/node";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { navigateTo } from "../src/auth/navigate.ts";
import { createWebApp } from "../src/index.ts";
import { paletteModeOf } from "../src/palette/palette-query.ts";
import { ACCOUNT_BODY, WORKSPACE_NAME, allowSlowRender, meOf, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The palette's go mode (doc 02 section 9.2, doc 03 section 9, doc 10 T12) against the handlers generated from openapi.json. The failure
// scenarios are a link of another origin that is taken for a go link, a path after the slug that is passed through, a suggestion that
// fires on every key or that is chosen without the server resolving it, a destination followed before the server returned it or one that
// is not a web address, "Always use this" sent when it was not ticked, a failed lookup shown as nothing, and a not-found hint that offers
// to create a bookmark with a slug the grammar refuses.

vi.mock("../src/auth/navigate.ts", () => ({ navigateTo: vi.fn() }));

type GoResolution = ComponentTypes["schemas"]["GoResolution"];
type GoCandidate = ComponentTypes["schemas"]["GoCandidate"];
type GoSuggestion = ComponentTypes["schemas"]["GoSuggestion"];

const ORIGIN = "http://localhost:3000";

describe("which text puts the palette in go mode", () => {
  it.each([
    ["go docs", "docs"],
    ["GO Docs", "docs"],
    ["Go   docs  ", "docs"],
    ["  go docs", "docs"],
    ["go ", ""],
    ["go \tdocs", "docs"],
  ])("reads %j as the slug %j", (query, slug) => {
    expect(paletteModeOf(query, ORIGIN)).toEqual({ kind: "go", slug });
  });

  it.each([
    ["/go/docs", "docs"],
    [`${ORIGIN}/go/docs`, "docs"],
    [` ${ORIGIN}/go/Docs `, "docs"],
    ["/go/", ""],
    ["/go/docs/page", "docs/page"],
    [`${ORIGIN}/go/docs?x=1`, "docs?x=1"],
    [`${ORIGIN}/go/docs#top`, "docs"],
    ["/go/do%20cs", "do cs"],
    ["/go/%E0%A4%A", "%e0%a4%a"],
  ])("reads the pasted link %j as the slug %j", (query, slug) => {
    expect(paletteModeOf(query, ORIGIN)).toEqual({ kind: "go", slug });
  });

  it.each([
    "go",
    "gopher",
    "golang notes",
    "https://other.example/go/docs",
    "http://localhost:3001/go/docs",
    "https://localhost:3000/go/docs",
    "//other.example/go/docs",
    `${ORIGIN}/gox/docs`,
    `${ORIGIN}/bookmarks`,
    "docs /go/docs",
    "/gox",
    "javascript:/go/docs",
  ])("leaves %j to the search", (query) => {
    expect(paletteModeOf(query, ORIGIN)).toEqual({ kind: "search", text: query.trim() });
  });

  it("reads nothing as browsing", () => {
    expect(paletteModeOf("   ", ORIGIN)).toEqual({ kind: "browse" });
  });
});

const server = createMockServer();
const document_ = readOpenApiDocument();

const SUGGEST = "/api/v1/go/suggest";
const RESOLVE = "/api/v1/go/resolve";
const CHOOSE = "/api/v1/go/choose";
const SEARCH = "/api/v1/search";
const GRACE = { accountId: "0192f3a0-bbbb-7000-8000-000000000002", displayName: "Grace Hopper" };
const ADA = { accountId: "0192f3a0-bbbb-7000-8000-000000000001", displayName: "Ada Lovelace" };
const WORKSPACE_B = { id: "0192f3a0-cccc-7000-8000-000000000002", name: "Workspace B" };
const DOCS_URL = "https://docs.example.org/handbook";

function candidate(n: number, overrides: Partial<GoCandidate> = {}): GoCandidate {
  return {
    id: `0192f3a0-aaaa-7000-8000-${String(n).padStart(12, "0")}`,
    title: `Docs ${String(n)}`,
    host: `docs${String(n)}.example.org`,
    owner: null,
    sharedVia: null,
    ...overrides,
  };
}

function suggestion(n: number, slug: string, overrides: Partial<GoSuggestion> = {}): GoSuggestion {
  const { id, title, host, owner, sharedVia } = candidate(n);
  return { slug, bookmarkId: id, title, host, owner, sharedVia, ...overrides };
}

const OWN_DOCS = suggestion(1, "docs");
const OWN_DOCKER = suggestion(2, "docker");
const SHARED_DOCS_API = suggestion(3, "docs-api", { owner: GRACE, sharedVia: "team" });

interface Call {
  readonly method: string;
  readonly path: string;
  readonly search: URLSearchParams;
  readonly body: unknown;
  readonly signal: AbortSignal;
}

let calls: Call[] = [];

function to(method: string, path: string): Call[] {
  return calls.filter((call) => call.method === method && call.path === path);
}

function prefixes(): (string | null)[] {
  return to("GET", SUGGEST).map((call) => call.search.get("prefix"));
}

function slugsResolved(): unknown[] {
  return to("POST", RESOLVE).map((call) => call.body);
}

type Resolver = (request: Request) => Response | Promise<Response>;

let steered: Readonly<Record<string, Resolver>> = {};

function use(resolvers: Readonly<Record<string, Resolver>> = {}): void {
  steered = { ...steered, ...resolvers };
  server.use(...createResolverHandlers(document_, steered), ...createHandlers(document_, { scenario: { name: "palette-go", fixtures: { getMe: meOf(ACCOUNT_BODY), listBookmarks: { items: [], nextCursor: null, total: 0 } } } }));
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { ...init, headers: { "Content-Type": "application/json", ...(init.headers as Record<string, string> | undefined) } });
}

function failure(): Response {
  return json({ type: "https://slugbase.app/problems/internal", title: "internal", status: 503, code: "unavailable", detail: "x", requestId: "r" }, { status: 503, headers: { "Content-Type": "application/problem+json" } });
}

function suggestions(...found: readonly GoSuggestion[]): void {
  use({ suggestSlugs: () => json({ suggestions: found }) });
}

function resolves(answer: GoResolution | ((slug: string) => GoResolution)): void {
  use({ resolveSlug: async (request) => json(typeof answer === "function" ? answer(((await request.clone().json()) as { slug: string }).slug) : answer) });
}

function chooses(answer: Resolver = () => json({ url: DOCS_URL })): void {
  use({ chooseSlug: answer });
}

function deferred(): { readonly promise: Promise<Response>; readonly resolve: (response: Response) => void } {
  let resolve: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let restoreWait: () => void = () => undefined;

beforeAll(() => {
  restoreWait = allowSlowRender();
  server.listen({ onUnhandledRequest: "error" });
  server.events.on("request:start", ({ request }) => {
    const url = new URL(request.url);
    const clone = request.clone();
    const body = request.method !== "GET" ? clone.text().then((text) => (text === "" ? undefined : (JSON.parse(text) as unknown))) : Promise.resolve(undefined);
    const call = { method: request.method, path: url.pathname, search: url.searchParams, body: undefined as unknown, signal: request.signal };
    calls.push(call);
    void body.then((parsed) => {
      (call as { body: unknown }).body = parsed;
    });
  });
});

afterAll(() => {
  restoreWait();
  server.close();
});

beforeEach(() => {
  calls = [];
  stubBrowserApis();
  stubMatchMedia();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
  vi.mocked(navigateTo).mockClear();
  window.history.replaceState(null, "", "/");
  steered = {};
  use({ search: () => json({ bookmarks: [], folders: [], tags: [] }) });
  suggestions(OWN_DOCS, OWN_DOCKER, SHARED_DOCS_API);
});

afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});

async function key(init: KeyboardEventInit, target: Element | Window = window): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(target, init);
    await Promise.resolve();
  });
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

async function openGo(text: string): Promise<HTMLElement> {
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
  await screen.findByRole("main", { hidden: true });
  await key({ key: "k", ctrlKey: true });
  const dialog = await screen.findByRole("dialog", { name: "Command palette" });
  fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: text } });
  return dialog;
}

async function enter(dialog: HTMLElement, init: KeyboardEventInit = {}): Promise<void> {
  await key({ key: "Enter", ...init }, within(dialog).getByRole("combobox"));
}

function labels(dialog: HTMLElement): string[] {
  return within(dialog).queryAllByRole("option").map((option) => option.querySelector("span.truncate")?.textContent ?? "");
}

async function suggested(dialog: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const group = within(dialog).getByRole("group", { name: "Slugs" });
    expect(within(group).getAllByRole("option").length).toBeGreaterThan(0);
    return group;
  });
}

describe("entering go mode", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("shows the Go chip and lists the slugs that start with what is typed, own first, without searching", async () => {
    const dialog = await openGo("go do");

    const group = await suggested(dialog);
    expect(within(dialog).getByText("Go", { selector: "kbd" })).toBeTruthy();
    expect(labels(group)).toEqual(["Docs 1", "Docs 2", "Docs 3"]);
    expect(within(group).getAllByRole("option").map((option) => option.querySelector("[data-slot='slug-chip']")?.textContent)).toEqual(["/go/docs", "/go/docker", "/go/docs-api"]);
    expect(within(group).getAllByRole("option")[2]?.textContent).toContain("Shared by Grace Hopper · through a team");
    expect(within(dialog).getAllByRole("option")[0]?.textContent).toContain("Go to /go/do");
    expect(prefixes()).toEqual(["do"]);
    expect(to("GET", SEARCH)).toHaveLength(0);
  });

  it("asks once, after the typing pauses, for the whole slug, in lower case", async () => {
    const App = createWebApp({ extensions: [] });
    await renderApp(<App />);
    await screen.findByRole("main", { hidden: true });
    await key({ key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    const input = within(dialog).getByRole("combobox");

    fireEvent.change(input, { target: { value: "go d" } });
    fireEvent.change(input, { target: { value: "go do" } });
    fireEvent.change(input, { target: { value: "GO DOC" } });

    expect(prefixes()).toEqual([]);
    await suggested(dialog);
    expect(prefixes()).toEqual(["doc"]);
  });

  it("does not take a longer word that starts with go, or go alone, for the mode", async () => {
    const dialog = await openGo("gopher");

    await waitFor(() => {
      expect(to("GET", SEARCH)).toHaveLength(1);
    });
    expect(within(dialog).queryByText("Go", { selector: "kbd" })).toBeNull();
    expect(to("GET", SUGGEST)).toHaveLength(0);
  });

  it.each([
    ["a pasted /go/ path", "/go/docs"],
    ["a pasted link on this origin", `${window.location.origin}/go/docs`],
  ])("enters the mode for %s and resolves the slug on Enter", async (_name, pasted) => {
    resolves({ result: "single", bookmark: candidate(1) });
    chooses();
    const dialog = await openGo(pasted);

    expect(within(dialog).getByText("Go", { selector: "kbd" })).toBeTruthy();
    await suggested(dialog);
    expect(prefixes()).toEqual(["docs"]);
    await enter(dialog);

    await waitFor(() => {
      expect(navigateTo).toHaveBeenCalledExactlyOnceWith(DOCS_URL);
    });
    expect(slugsResolved()).toEqual([{ slug: "docs" }]);
  });

  it("treats a link on another origin as text to search for", async () => {
    const address = "https://other.example.com/go/docs";
    const dialog = await openGo(address);

    await waitFor(() => {
      expect(to("GET", SEARCH)).toHaveLength(1);
    });
    expect(to("GET", SEARCH)[0]?.search.get("q")).toBe(address);
    expect(within(dialog).queryByText("Go", { selector: "kbd" })).toBeNull();
    expect(to("GET", SUGGEST)).toHaveLength(0);
    expect(to("POST", RESOLVE)).toHaveLength(0);
  });

  it("asks for a slug when nothing follows go, without asking the server", async () => {
    const dialog = await openGo("go ");

    expect(await within(dialog).findByText("Go to a slug")).toBeTruthy();
    expect(within(dialog).getByText("Go", { selector: "kbd" })).toBeTruthy();
    await enter(dialog);
    expect(to("GET", SUGGEST)).toHaveLength(0);
    expect(to("POST", RESOLVE)).toHaveLength(0);
  });

  it("shows skeleton rows while the suggestions load and a retry row when they fail, and Go to still works", async () => {
    const pending = deferred();
    use({ suggestSlugs: () => pending.promise });
    resolves({ result: "single", bookmark: candidate(1) });
    chooses();
    const dialog = await openGo("go doc");

    await waitFor(() => {
      expect(prefixes()).toEqual(["doc"]);
    });
    expect(within(dialog).getByRole("group", { name: "Slugs" }).querySelectorAll("[data-slot='skeleton']")).toHaveLength(3);
    pending.resolve(failure());
    const retry = await within(dialog).findByRole("option", { name: /The slugs could not be loaded/ });

    suggestions(OWN_DOCS);
    await click(retry);
    await suggested(dialog);
    expect(prefixes()).toEqual(["doc", "doc"]);
    await enter(dialog);
    await waitFor(() => {
      expect(navigateTo).toHaveBeenCalledTimes(1);
    });
  });

  it("does not ask for suggestions of text that no slug can start with", async () => {
    const dialog = await openGo("go docs/page");

    await within(dialog).findByRole("option", { name: "Go to /go/docs/page" });
    await new Promise((done) => setTimeout(done, 300));
    expect(to("GET", SUGGEST)).toHaveLength(0);
  });
});

describe("resolving on Enter", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it.each(["single", "preferred"] as const)("chooses the bookmark of a %s resolution and goes where the server says, only after it said", async (result) => {
    resolves({ result, bookmark: candidate(1) });
    const pending = deferred();
    chooses(() => pending.promise);
    const dialog = await openGo("go docs");
    await suggested(dialog);

    await enter(dialog);

    await waitFor(() => {
      expect(to("POST", CHOOSE)).toHaveLength(1);
    });
    expect(to("POST", CHOOSE)[0]?.body).toEqual({ slug: "docs", bookmarkId: candidate(1).id, remember: false });
    expect(navigateTo).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("group").querySelectorAll("[data-slot='skeleton']").length).toBeGreaterThan(0);
    await act(async () => {
      pending.resolve(json({ url: DOCS_URL }));
      await pending.promise;
    });
    await waitFor(() => {
      expect(navigateTo).toHaveBeenCalledExactlyOnceWith(DOCS_URL);
    });
  });

  it("resolves the slug of a suggestion that is chosen, instead of going to it directly", async () => {
    resolves({ result: "single", bookmark: candidate(2) });
    chooses();
    const dialog = await openGo("go do");
    const group = await suggested(dialog);

    await click(within(group).getAllByRole("option")[1] as HTMLElement);

    await waitFor(() => {
      expect(navigateTo).toHaveBeenCalledTimes(1);
    });
    expect(slugsResolved()).toEqual([{ slug: "docker" }]);
    expect(to("POST", CHOOSE)[0]?.body).toEqual({ slug: "docker", bookmarkId: candidate(2).id, remember: false });
  });

  it("does not follow a destination that is not a web address, and says the bookmark could not be opened", async () => {
    resolves({ result: "single", bookmark: candidate(1) });
    chooses(() => json({ url: "javascript:alert(1)" }));
    const dialog = await openGo("go docs");
    await suggested(dialog);

    await enter(dialog);

    expect(await within(dialog).findByRole("option", { name: /That bookmark could not be opened/ })).toBeTruthy();
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it("says the lookup failed, and looks the slug up again from Try again", async () => {
    use({ resolveSlug: () => failure() });
    const dialog = await openGo("go docs");
    await suggested(dialog);

    await enter(dialog);
    const retry = await within(dialog).findByRole("option", { name: /This slug could not be looked up/ });
    expect(navigateTo).not.toHaveBeenCalled();

    resolves({ result: "single", bookmark: candidate(1) });
    chooses();
    await click(retry);

    await waitFor(() => {
      expect(navigateTo).toHaveBeenCalledExactlyOnceWith(DOCS_URL);
    });
    expect(slugsResolved()).toEqual([{ slug: "docs" }, { slug: "docs" }]);
  });

  it("drops the answer of an earlier Enter when the text changes", async () => {
    const pending = deferred();
    use({ resolveSlug: () => pending.promise });
    const dialog = await openGo("go docs");
    await suggested(dialog);
    await enter(dialog);
    await waitFor(() => {
      expect(to("POST", RESOLVE)).toHaveLength(1);
    });

    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "go docs-api" } });
    chooses();
    await act(async () => {
      pending.resolve(json({ result: "single", bookmark: candidate(1) }));
      await new Promise((done) => setTimeout(done, 50));
    });

    expect(to("POST", CHOOSE)).toHaveLength(0);
    expect(navigateTo).not.toHaveBeenCalled();
    expect(await within(dialog).findByRole("option", { name: "Go to /go/docs-api" })).toBeTruthy();
  });

  it("resolves a path after the slug as the server does, as no match, and offers no bookmark to create", async () => {
    resolves((slug) => ({ result: "none", otherWorkspaces: slug === "docs/page" ? [] : [WORKSPACE_B] }));
    const dialog = await openGo("/go/docs/page");

    await within(dialog).findByRole("option", { name: "Go to /go/docs/page" });
    await enter(dialog);

    expect(await within(dialog).findByText(`No bookmark has the slug docs/page in ${WORKSPACE_NAME}.`)).toBeTruthy();
    expect(slugsResolved()).toEqual([{ slug: "docs/page" }]);
    expect(to("POST", CHOOSE)).toHaveLength(0);
    expect(within(dialog).queryByRole("option", { name: "Create a bookmark with this slug" })).toBeNull();
    expect(navigateTo).not.toHaveBeenCalled();
  });
});

describe("several bookmarks share the slug", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  const CANDIDATES = [candidate(1, { owner: GRACE, sharedVia: "direct" }), candidate(2, { owner: ADA, sharedVia: "team" })];

  async function atCandidates(): Promise<HTMLElement> {
    resolves({ result: "multiple", candidates: CANDIDATES });
    const dialog = await openGo("go docs");
    await suggested(dialog);
    await enter(dialog);
    await within(dialog).findByRole("option", { name: /Always use this for docs/ });
    return dialog;
  }

  it("lists the candidates inline with who shared them and an unticked Always use this", async () => {
    const dialog = await atCandidates();

    const group = within(dialog).getByRole("group", { name: "go/docs matches 2 bookmarks" });
    expect(within(group).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Docs 1docs1.example.orgShared by Grace Hopper · directly",
      "Docs 2docs2.example.orgShared by Ada Lovelace · through a team",
      "Always use this for docs",
    ]);
    expect(within(dialog).getByRole("option", { name: /Always use this for docs/ }).getAttribute("aria-checked")).toBe("false");
    expect(to("POST", CHOOSE)).toHaveLength(0);
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it("chooses the picked candidate without remembering it", async () => {
    chooses();
    const dialog = await atCandidates();

    await click(within(dialog).getByRole("option", { name: /Docs 2/ }));

    await waitFor(() => {
      expect(navigateTo).toHaveBeenCalledExactlyOnceWith(DOCS_URL);
    });
    expect(to("POST", CHOOSE)[0]?.body).toEqual({ slug: "docs", bookmarkId: candidate(2).id, remember: false });
  });

  it("remembers the choice once Always use this is ticked, and keeps the palette open while ticking", async () => {
    chooses();
    const dialog = await atCandidates();

    await click(within(dialog).getByRole("option", { name: /Always use this for docs/ }));
    expect(within(dialog).getByRole("option", { name: /Always use this for docs/ }).getAttribute("aria-checked")).toBe("true");
    expect(to("POST", CHOOSE)).toHaveLength(0);
    await click(within(dialog).getByRole("option", { name: /Docs 1/ }));

    await waitFor(() => {
      expect(navigateTo).toHaveBeenCalledExactlyOnceWith(DOCS_URL);
    });
    expect(to("POST", CHOOSE)[0]?.body).toEqual({ slug: "docs", bookmarkId: candidate(1).id, remember: true });
  });

  it("reads the candidates again from the retry row when the choice is refused", async () => {
    chooses(() => json({ type: "https://slugbase.app/problems/not-found", title: "n", status: 404, code: "slug_not_found", detail: "x", requestId: "r" }, { status: 404, headers: { "Content-Type": "application/problem+json" } }));
    const dialog = await atCandidates();

    await click(within(dialog).getByRole("option", { name: /Docs 1/ }));
    const retry = await within(dialog).findByRole("option", { name: /That bookmark could not be opened/ });
    expect(navigateTo).not.toHaveBeenCalled();
    await click(retry);

    await within(dialog).findByRole("option", { name: /Always use this for docs/ });
    expect(slugsResolved()).toEqual([{ slug: "docs" }, { slug: "docs" }]);
  });
});

describe("nothing has the slug", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  async function atNotFound(others: readonly { id: string; name: string }[] = []): Promise<HTMLElement> {
    resolves({ result: "none", otherWorkspaces: [...others] });
    const dialog = await openGo("go mail");
    await enter(dialog);
    await within(dialog).findByText(/No bookmark has the slug mail in/);
    return dialog;
  }

  it("says no bookmark has the slug in the workspace and offers to create one with the slug", async () => {
    const dialog = await atNotFound();

    expect(within(dialog).getByText(`No bookmark has the slug mail in ${WORKSPACE_NAME}.`)).toBeTruthy();
    expect(labels(dialog)).toEqual(["Create a bookmark with this slug"]);
    expect(navigateTo).not.toHaveBeenCalled();

    await click(within(dialog).getByRole("option", { name: "Create a bookmark with this slug" }));

    const modal = await screen.findByRole("dialog", { name: "New bookmark" });
    expect(within(modal).getByLabelText<HTMLInputElement>("Slug").value).toBe("mail");
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  });

  it("lists the member's other workspaces that have the slug, and goes on in the one chosen", async () => {
    let switched = false;
    use({
      setActiveWorkspace: () => {
        switched = true;
        return new Response(null, { status: 204 });
      },
    });
    resolves(() => (switched ? { result: "single", bookmark: candidate(5) } : { result: "none", otherWorkspaces: [WORKSPACE_B] }));
    chooses();
    const dialog = await openGo("go mail");
    await enter(dialog);

    await click(await within(dialog).findByRole("option", { name: "Found in: Workspace B — switch and continue" }));

    await waitFor(() => {
      expect(navigateTo).toHaveBeenCalledExactlyOnceWith(DOCS_URL);
    });
    expect(to("PUT", "/api/v1/session/active-workspace").map((call) => call.body)).toEqual([{ workspaceId: WORKSPACE_B.id }]);
    expect(slugsResolved()).toEqual([{ slug: "mail" }, { slug: "mail" }]);
    expect(to("POST", CHOOSE)[0]?.body).toEqual({ slug: "mail", bookmarkId: candidate(5).id, remember: false });
  });

  it("stays in the hint and says so when the switch is refused", async () => {
    use({ setActiveWorkspace: () => json({ type: "https://slugbase.app/problems/not-found", title: "n", status: 404, code: "not_found", detail: "x", requestId: "r" }, { status: 404, headers: { "Content-Type": "application/problem+json" } }) });
    const dialog = await atNotFound([WORKSPACE_B]);

    await click(within(dialog).getByRole("option", { name: "Found in: Workspace B — switch and continue" }));

    expect((await screen.findAllByText("You are no longer a member of that workspace.")).length).toBeGreaterThan(0);
    expect(navigateTo).not.toHaveBeenCalled();
  });
});
