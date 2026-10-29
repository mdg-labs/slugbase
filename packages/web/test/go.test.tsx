import type { ComponentTypes } from "@slugbase/contracts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { navigateTo } from "../src/auth/navigate.ts";
import { createWebApp } from "../src/index.ts";
import {
  ACCOUNT_BODY,
  ACTIVE_WORKSPACE_PATH,
  ME_PATH,
  WORKSPACES_PATH,
  WORKSPACE_ID,
  WORKSPACE_LIST_BODY,
  WORKSPACE_NAME,
  allowSlowRender,
  json,
  problem,
  renderApp,
  signedIn,
  stubBrowserApis,
  stubMatchMedia,
} from "./support.tsx";

// The page of /go/<slug> (doc 03 section 10, doc 02 sections 6.2 to 6.4) through the app's own API client, against a stubbed transport
// that resolves a slug per workspace the way POST /go/resolve does and answers POST /go/choose with the destination of a candidate.
// The failure scenarios are a page that forwards before it has asked, a failed lookup shown as "no bookmark", a choice sent without
// the box the member ticked or with it ticked when they did not, a destination that is not a web address followed, a switch that
// forwards in the old workspace or that is reported as done when the server refused it, and a slug the address spoils (a query
// string or a path after it) that is looked up as if it were a slug.

vi.mock("../src/auth/navigate.ts", () => ({ navigateTo: vi.fn() }));

type GoResolution = ComponentTypes["schemas"]["GoResolution"];
type GoCandidate = ComponentTypes["schemas"]["GoCandidate"];
type Transport = (request: Request) => Promise<Response>;

const WORKSPACE_B = { id: "0192f3a0-cccc-7000-8000-000000000002", name: "Workspace B" };
const GRACE = { accountId: "0192f3a0-bbbb-7000-8000-000000000002", displayName: "Grace Hopper" };
const ADA = { accountId: "0192f3a0-bbbb-7000-8000-000000000001", displayName: "Ada Lovelace" };
const MAIL_URL = "https://mail.example.com/inbox";

function candidate(n: number, overrides: Partial<GoCandidate> = {}): GoCandidate {
  return {
    id: `0192f3a0-aaaa-7000-8000-${String(n).padStart(12, "0")}`,
    title: `Mail ${String(n)}`,
    host: `mail${String(n)}.example.com`,
    owner: GRACE,
    sharedVia: "direct",
    ...overrides,
  };
}

const CANDIDATES: GoCandidate[] = [candidate(1), candidate(2, { owner: ADA, sharedVia: "team" }), candidate(3, { sharedVia: "folder" })];

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

interface Answers {
  /** What a slug resolves to in a workspace; the default is nothing, in no other workspace. */
  readonly resolve?: (slug: string, workspaceId: string) => Response | GoResolution;
  /** Holds every resolution until it settles. */
  readonly hold?: Promise<void>;
  /** Replaces the answer to a choice. */
  readonly choose?: (call: Call) => Response | undefined;
  /** Replaces the answer to a switch of the workspace. */
  readonly switchTo?: () => Response | undefined;
  /** The theme of the account. */
  readonly theme?: string;
}

interface Server {
  readonly calls: Call[];
  readonly to: (method: string, path: string) => Call[];
}

function stubServer(answers: Answers = {}): Server {
  const calls: Call[] = [];
  let active = WORKSPACE_ID;
  const workspaces = [...WORKSPACE_LIST_BODY.items, { id: WORKSPACE_B.id, name: WORKSPACE_B.name, role: "member", memberCount: 3 }];
  vi.stubGlobal(
    "fetch",
    vi.fn<Transport>((request) => {
      const url = new URL(request.url);
      if (url.pathname === ME_PATH && request.method === "GET") {
        return Promise.resolve(
          json({
            account: { ...ACCOUNT_BODY, locale: window.navigator.languages.some((language) => language.startsWith("de")) ? "de" : "en", theme: answers.theme ?? ACCOUNT_BODY.theme },
            memberships: workspaces.map((workspace) => ({ workspaceId: workspace.id, name: workspace.name, role: workspace.role })),
            activeWorkspaceId: active,
          }),
        );
      }
      if (url.pathname === WORKSPACES_PATH && request.method === "GET") {
        return Promise.resolve(json({ items: workspaces, canCreate: false }));
      }
      return signedIn(request, async (other) => {
        const text = other.method === "GET" ? "" : await other.clone().text();
        const call: Call = { method: other.method, path: url.pathname, body: text === "" ? undefined : (JSON.parse(text) as unknown) };
        if (url.pathname === "/api/v1/folders" || url.pathname === "/api/v1/tags" || (url.pathname === "/api/v1/bookmarks" && other.method === "GET")) {
          return json({ items: [], nextCursor: null, total: 0 });
        }
        calls.push(call);
        if (url.pathname === ACTIVE_WORKSPACE_PATH && other.method === "PUT") {
          const custom = answers.switchTo?.();
          if (custom !== undefined) {
            return custom;
          }
          active = (call.body as { workspaceId: string }).workspaceId;
          return new Response(null, { status: 204 });
        }
        if (url.pathname === "/api/v1/go/resolve" && other.method === "POST") {
          await answers.hold;
          const resolution = answers.resolve?.((call.body as { slug: string }).slug, active) ?? { result: "none", otherWorkspaces: [] };
          return resolution instanceof Response ? resolution : json(resolution);
        }
        if (url.pathname === "/api/v1/go/choose" && other.method === "POST") {
          return answers.choose?.(call) ?? json({ url: MAIL_URL });
        }
        return problem(404, "not_found", "req-404");
      });
    }),
  );
  return { calls, to: (method, path) => calls.filter((call) => call.method === method && call.path === path) };
}

let restoreWait: () => void = () => undefined;

beforeAll(() => {
  restoreWait = allowSlowRender();
});

afterAll(() => {
  restoreWait();
});

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
  vi.mocked(navigateTo).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function openApp(path: string): Promise<void> {
  window.history.replaceState(null, "", path);
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
}

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

const RESOLVE = "/api/v1/go/resolve";
const CHOOSE = "/api/v1/go/choose";

describe("a slug with nothing behind it", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("resolves the slug on load and says that no bookmark has it in the workspace, on a page without the sidebar", async () => {
    const server = stubServer();
    await openApp("/go/mail");

    await screen.findByRole("heading", { level: 1, name: `No bookmark has the slug mail in ${WORKSPACE_NAME}.` });
    expect(server.to("POST", RESOLVE).map((call) => call.body)).toEqual([{ slug: "mail" }]);
    expect(screen.queryByRole("navigation", { name: "Main navigation" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Bookmarks" })).toBeNull();
    expect(server.to("POST", CHOOSE)).toHaveLength(0);
    expect(navigateTo).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /switch and continue/ })).toBeNull();
  });

  it("looks the slug up as the server does: trimmed and in lower case", async () => {
    const server = stubServer();
    await openApp("/go/Mail%20");

    await screen.findByRole("heading", { level: 1, name: `No bookmark has the slug mail in ${WORKSPACE_NAME}.` });
    expect(server.to("POST", RESOLVE).map((call) => call.body)).toEqual([{ slug: "mail" }]);
  });

  it("opens the bookmark modal with the slug filled in from Create a bookmark with this slug", async () => {
    stubServer();
    await openApp("/go/mail");

    const link = await screen.findByRole("link", { name: "Create a bookmark with this slug" });
    expect(link.getAttribute("href")).toBe("/bookmarks?new=1&slug=mail");
    await press(link);

    const dialog = await screen.findByRole("dialog", { name: "New bookmark" });
    expect(window.location.pathname).toBe("/bookmarks");
    expect(within(dialog).getByLabelText<HTMLInputElement>("Slug").value).toBe("mail");
  });

  it("offers each other workspace that has the slug, and switching re-opens the slug in it", async () => {
    const server = stubServer({
      resolve: (_slug, workspaceId) =>
        workspaceId === WORKSPACE_ID ? { result: "none", otherWorkspaces: [WORKSPACE_B] } : { result: "single", bookmark: candidate(7, { owner: null, sharedVia: null }) },
    });
    await openApp("/go/mail");

    await press(await screen.findByRole("button", { name: "Found in: Workspace B — switch and continue" }));

    await waitFor(() => {
      expect(navigateTo).toHaveBeenCalledExactlyOnceWith(MAIL_URL);
    });
    expect(server.to("PUT", ACTIVE_WORKSPACE_PATH).map((call) => call.body)).toEqual([{ workspaceId: WORKSPACE_B.id }]);
    // The slug was resolved in the workspace the member switched to, and only then was a bookmark chosen.
    expect(server.to("POST", RESOLVE)).toHaveLength(2);
    expect(server.to("POST", CHOOSE).map((call) => call.body)).toEqual([{ slug: "mail", bookmarkId: candidate(7).id, remember: false }]);
  });

  it("stays on the page and says so when the switch is refused", async () => {
    const server = stubServer({
      resolve: () => ({ result: "none", otherWorkspaces: [WORKSPACE_B] }),
      switchTo: () => problem(404, "not_found", "req-switch"),
    });
    await openApp("/go/mail");

    await press(await screen.findByRole("button", { name: "Found in: Workspace B — switch and continue" }));

    expect((await screen.findAllByText("You are no longer a member of that workspace.")).length).toBeGreaterThan(0);
    expect(server.to("PUT", ACTIVE_WORKSPACE_PATH)).toHaveLength(1);
    expect(navigateTo).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 1, name: `No bookmark has the slug mail in ${WORKSPACE_NAME}.` })).toBeTruthy();
  });
});

describe("a slug with one answer", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it.each(["single", "preferred"] as const)("goes to the bookmark of a %s resolution after choosing it, and remembers nothing", async (result) => {
    const server = stubServer({ resolve: () => ({ result, bookmark: candidate(4, { owner: null, sharedVia: null }) }) });
    await openApp("/go/mail");

    await waitFor(() => {
      expect(navigateTo).toHaveBeenCalledExactlyOnceWith(MAIL_URL);
    });
    expect(server.to("POST", CHOOSE).map((call) => call.body)).toEqual([{ slug: "mail", bookmarkId: candidate(4).id, remember: false }]);
    expect(screen.queryByRole("navigation", { name: "Main navigation" })).toBeNull();
  });

  it("does not follow a destination that is not a web address", async () => {
    stubServer({
      resolve: () => ({ result: "single", bookmark: candidate(4) }),
      choose: () => json({ url: "javascript:alert(1)" }),
    });
    await openApp("/go/mail");

    expect(await screen.findByText("The bookmark could not be opened")).toBeTruthy();
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it("says when the choice failed, and reads the slug again from Try again", async () => {
    let refuse = true;
    const server = stubServer({
      resolve: () => ({ result: "single", bookmark: candidate(4) }),
      choose: () => (refuse ? problem(404, "slug_not_found", "req-choose") : undefined),
    });
    await openApp("/go/mail");

    await screen.findByText("The bookmark could not be opened");
    expect(navigateTo).not.toHaveBeenCalled();
    refuse = false;
    await press(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => {
      expect(navigateTo).toHaveBeenCalledExactlyOnceWith(MAIL_URL);
    });
    expect(server.to("POST", RESOLVE)).toHaveLength(2);
  });
});

describe("a slug with several bookmarks", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("lists the candidates with their title, host, owner and how they are shared, and a link to the remembered choices", async () => {
    stubServer({ resolve: () => ({ result: "multiple", candidates: CANDIDATES }) });
    await openApp("/go/mail");

    await screen.findByRole("heading", { level: 1, name: "go/mail matches 3 bookmarks" });
    const group = screen.getByRole("group", { name: "Bookmarks with this slug" });
    const cards = within(group).getAllByRole("button");
    expect(cards.map((card) => card.textContent)).toEqual([
      "mMail 1mail1.example.comShared by Grace Hopper · directly",
      "mMail 2mail2.example.comShared by Ada Lovelace · through a team",
      "mMail 3mail3.example.comShared by Grace Hopper · through a shared folder",
    ]);
    expect(Array.from(group.querySelectorAll("img")).map((img) => img.getAttribute("src"))).toEqual([
      "/api/v1/favicons/mail1.example.com",
      "/api/v1/favicons/mail2.example.com",
      "/api/v1/favicons/mail3.example.com",
    ]);
    expect(screen.getByRole("link", { name: "Manage remembered choices →" }).getAttribute("href")).toBe("/forwarding");
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it("names a bookmark of the member's own and one whose owner has left", async () => {
    stubServer({ resolve: () => ({ result: "multiple", candidates: [candidate(1, { owner: null, sharedVia: null }), candidate(2, { owner: null, sharedVia: "team" })] }) });
    await openApp("/go/mail");

    const group = await screen.findByRole("group", { name: "Bookmarks with this slug" });
    expect(within(group).getAllByRole("button").map((card) => card.textContent)).toEqual([
      "mMail 1mail1.example.comYour bookmark",
      "mMail 2mail2.example.comShared with you · through a team",
    ]);
  });

  it("chooses the bookmark that was pressed, remembers nothing unless asked, and goes to its destination", async () => {
    const server = stubServer({ resolve: () => ({ result: "multiple", candidates: CANDIDATES }), choose: () => json({ url: "https://two.example.com/" }) });
    await openApp("/go/mail");

    await press(await screen.findByRole("button", { name: /^Mail 2/ }));

    await waitFor(() => {
      expect(navigateTo).toHaveBeenCalledExactlyOnceWith("https://two.example.com/");
    });
    expect(server.to("POST", CHOOSE).map((call) => call.body)).toEqual([{ slug: "mail", bookmarkId: candidate(2).id, remember: false }]);
  });

  it("sends remember when Always use this for mail is ticked", async () => {
    const server = stubServer({ resolve: () => ({ result: "multiple", candidates: CANDIDATES }) });
    await openApp("/go/mail");

    const box = await screen.findByRole("checkbox", { name: "Always use this for mail" });
    expect(box.getAttribute("aria-checked")).toBe("false");
    await press(box);
    expect(box.getAttribute("aria-checked")).toBe("true");
    await press(screen.getByRole("button", { name: /^Mail 3/ }));

    await waitFor(() => {
      expect(navigateTo).toHaveBeenCalledExactlyOnceWith(MAIL_URL);
    });
    expect(server.to("POST", CHOOSE).map((call) => call.body)).toEqual([{ slug: "mail", bookmarkId: candidate(3).id, remember: true }]);
  });

  it("keeps the list and says so when the choice is refused, and reads the candidates again from Try again", async () => {
    let refuse = true;
    const server = stubServer({
      resolve: () => ({ result: "multiple", candidates: CANDIDATES }),
      choose: () => (refuse ? problem(404, "slug_not_found", "req-choose") : undefined),
    });
    await openApp("/go/mail");

    await press(await screen.findByRole("button", { name: /^Mail 1/ }));

    expect(await screen.findByText("That bookmark could not be opened")).toBeTruthy();
    expect(navigateTo).not.toHaveBeenCalled();
    expect(screen.getAllByRole("button", { name: /^Mail \d/ })).toHaveLength(3);
    refuse = false;
    await press(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => {
      expect(server.to("POST", RESOLVE)).toHaveLength(2);
    });
    await press(await screen.findByRole("button", { name: /^Mail 1/ }));
    await waitFor(() => {
      expect(navigateTo).toHaveBeenCalledExactlyOnceWith(MAIL_URL);
    });
  });
});

describe("the states of the page", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("shows a loading skeleton until the slug is resolved", async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubServer({ hold });
    await openApp("/go/mail");

    expect(await screen.findByRole("status", { name: "Loading" })).toBeTruthy();
    expect(screen.queryByText(/No bookmark has the slug/)).toBeNull();
    await act(async () => {
      release();
      await Promise.resolve();
    });

    await screen.findByRole("heading", { level: 1, name: `No bookmark has the slug mail in ${WORKSPACE_NAME}.` });
    expect(screen.queryByRole("status", { name: "Loading" })).toBeNull();
  });

  it("shows an error banner, not an empty result, when the slug cannot be resolved, and tries again", async () => {
    let fail = true;
    const server = stubServer({ resolve: () => (fail ? problem(503, "unavailable", "req-503") : { result: "none", otherWorkspaces: [] }) });
    await openApp("/go/mail");

    const banner = await screen.findByRole("alert");
    expect(within(banner).getByText("This slug could not be looked up")).toBeTruthy();
    expect(screen.queryByText(/No bookmark has the slug/)).toBeNull();
    fail = false;
    await press(within(banner).getByRole("button", { name: "Try again" }));

    await screen.findByRole("heading", { level: 1, name: `No bookmark has the slug mail in ${WORKSPACE_NAME}.` });
    expect(server.to("POST", RESOLVE)).toHaveLength(2);
  });

  it.each([
    ["a slug outside the grammar", "/go/-mail"],
    ["a query string after the slug", "/go/mail?next=1"],
    ["a path after the slug", "/go/mail/inbox"],
    ["no slug", "/go/"],
  ])("shows the page that does not exist for %s, and resolves nothing", async (_name, path) => {
    const server = stubServer();
    await openApp(path);

    await screen.findByRole("heading", { level: 1, name: "This page doesn't exist" });
    expect(screen.queryByRole("navigation", { name: "Main navigation" })).toBeNull();
    expect(server.to("POST", RESOLVE)).toHaveLength(0);
    expect(server.to("POST", CHOOSE)).toHaveLength(0);
  });

  it("applies the theme of the account and is in German with the account's language", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-DE", "de"]);
    stubServer({ theme: "dark", resolve: () => ({ result: "multiple", candidates: CANDIDATES }) });
    await openApp("/go/mail");

    await screen.findByRole("heading", { level: 1, name: "go/mail passt zu 3 Lesezeichen" });
    expect(screen.getByRole("checkbox", { name: "Immer dieses für mail verwenden" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Gemerkte Auswahl verwalten →" })).toBeTruthy();
    expect([...document.documentElement.classList]).toContain("dark");
  });
});
