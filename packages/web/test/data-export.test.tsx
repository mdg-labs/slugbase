import { createHandlers, createResolverHandlers } from "@slugbase/testing/msw";
import { createMockServer, readOpenApiDocument } from "@slugbase/testing/msw/node";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp } from "../src/index.ts";
import { allowSlowRender, json, meBody, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The export of /settings/account/data (doc 03 section 11.5, doc 02 section 13.2) and the Import and Export commands of the palette (doc 02
// section 9.2), against the handlers generated from openapi.json. The failure scenarios are a refused download (a 429, a failure, no
// connection) that saves a file or does not say why or how long to wait, a second download started while one runs, a file name taken from
// a response that is a path or has another extension, an object URL that is never revoked, and a shared checkbox shown without the grant.

const server = createMockServer();
const document_ = readOpenApiDocument();

const JSON_FILE = '{"format":"slugbase-export","version":1,"bookmarks":[]}';
const HTML_FILE = "<!DOCTYPE NETSCAPE-Bookmark-file-1><DL></DL>";
const JSON_NAME = "slugbase-export-2026-05-05.json";
const HTML_NAME = "slugbase-export-2026-05-05.html";

interface Seen {
  readonly path: string;
  readonly includeShared: string | null;
}

interface World {
  seen: Seen[];
  sharing: { members: boolean; teams: boolean };
  /** Answers an export in place of the file, when it returns a response. */
  answer: (seen: Seen) => Response | Promise<Response | undefined> | undefined;
  /** What the browser was asked to save, in order: the anchor's address and file name at the click. */
  clicks: { readonly href: string; readonly download: string; readonly attached: boolean }[];
  created: Blob[];
  revoked: string[];
}

let world: World;

function newWorld(): World {
  return { seen: [], sharing: { members: true, teams: true }, answer: () => undefined, clicks: [], created: [], revoked: [] };
}

function problemOf(status: number, code: string, headers: Record<string, string> = {}): Response {
  return json(
    { type: `https://slugbase.app/problems/${code}`, title: code, status, code, detail: "Hostile <b>English</b> detail of the server", requestId: "req-export" },
    { status, contentType: "application/problem+json", headers },
  );
}

function fileOf(body: string, contentType: string, disposition: string): Response {
  return new Response(body, { headers: { "Content-Type": contentType, "Content-Disposition": disposition } });
}

function entitlementsBody() {
  return {
    entitlements: {
      "bookmarks.max": "unlimited",
      "seats.max": "unlimited",
      "workspaces.ownMax": "unlimited",
      "ai.suggestions": true,
      "sharing.members": world.sharing.members,
      "sharing.teams": world.sharing.teams,
      "members.invite": true,
      "teams.manage": true,
      "audit.log": true,
    },
    usage: { "bookmarks.used": 3, "seats.used": 3, "workspaces.owned": 1 },
    upgradeAvailable: true,
  };
}

function serve(): void {
  server.use(...createHandlers(document_, { scenario: { name: "export" } }));
  const handle = (body: string, contentType: string, disposition: string) => async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const seen: Seen = { path: url.pathname, includeShared: url.searchParams.get("includeShared") };
    world.seen.push(seen);
    return (await world.answer(seen)) ?? fileOf(body, contentType, disposition);
  };
  server.use(
    ...createResolverHandlers(document_, {
      getMe: () => json(meBody()),
      getEntitlements: () => json(entitlementsBody()),
      exportJson: handle(JSON_FILE, "application/json", `attachment; filename="${JSON_NAME}"`),
      exportNetscape: handle(HTML_FILE, "text/html; charset=utf-8", `attachment; filename="${HTML_NAME}"`),
    }),
  );
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

let restoreWait: () => void = () => undefined;

beforeAll(() => {
  restoreWait = allowSlowRender();
});

afterAll(() => {
  restoreWait();
});

beforeEach(() => {
  world = newWorld();
  stubBrowserApis();
  stubMatchMedia();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
  // jsdom has no object URLs and cannot save a file: the test sees what the page hands to them.
  let next = 0;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: (blob: Blob) => {
      world.created.push(blob);
      next += 1;
      return `blob:export-${String(next)}`;
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: (url: string) => {
      world.revoked.push(url);
    },
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function click(this: HTMLAnchorElement) {
    world.clicks.push({ href: this.href, download: this.download, attached: this.isConnected });
  });
  serve();
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
});

async function openPage(path = "/settings/account/data"): Promise<void> {
  window.history.replaceState(null, "", path);
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
  await screen.findByRole("main", { hidden: true });
  if (path === "/settings/account/data") {
    await screen.findByRole("heading", { level: 1, name: "Import & export" });
  } else {
    await screen.findByRole("heading", { level: 1 });
  }
}

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

const downloadButton = (): HTMLElement => screen.getByRole("button", { name: /^Download/ });

async function download(): Promise<void> {
  await press(downloadButton());
}

describe("the Export section", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("offers SlugBase JSON as the recommended default and Netscape HTML as the lossy choice", async () => {
    await openPage();

    expect(screen.getByRole("heading", { level: 2, name: "Export bookmarks" })).toBeTruthy();
    const group = screen.getByRole("radiogroup", { name: "File format" });
    const json_ = within(group).getByRole("radio", { name: "SlugBase JSON (recommended)" });
    const html = within(group).getByRole("radio", { name: "Netscape HTML" });
    expect(json_.getAttribute("aria-checked")).toBe("true");
    expect(html.getAttribute("aria-checked")).toBe("false");
    expect(json_.getAttribute("aria-describedby")).not.toBeNull();
    expect(within(group).getByText(/Descriptions, pins and forwarding are left out/)).toBeTruthy();
    expect(within(group).getByText(/Keeps everything/)).toBeTruthy();
  });

  it("downloads SlugBase JSON by default under the name the response gives, and revokes the object URL after the save", async () => {
    await openPage();

    await download();

    await waitFor(() => {
      expect(world.clicks).toHaveLength(1);
    });
    expect(world.seen).toEqual([{ path: "/api/v1/export/json", includeShared: "false" }]);
    expect(world.clicks[0]).toMatchObject({ href: "blob:export-1", download: JSON_NAME, attached: true });
    expect(await world.created[0]?.text()).toBe(JSON_FILE);
    expect(document.querySelector("a[download]")).toBeNull();
    const toasts = await screen.findAllByText("Download started");
    expect(toasts.length).toBeGreaterThan(0);
    expect(screen.getAllByText(JSON_NAME).length).toBeGreaterThan(0);
    expect(screen.queryByText("Preparing your export…")).toBeNull();
    await waitFor(
      () => {
        expect(world.revoked).toEqual(["blob:export-1"]);
      },
      { timeout: 3000 },
    );
  });

  it("downloads the browser file when Netscape HTML is chosen", async () => {
    await openPage();

    await press(screen.getByRole("radio", { name: "Netscape HTML" }));
    await download();

    await waitFor(() => {
      expect(world.clicks).toHaveLength(1);
    });
    expect(world.seen).toEqual([{ path: "/api/v1/export/netscape", includeShared: "false" }]);
    expect(world.clicks[0]?.download).toBe(HTML_NAME);
    expect(await world.created[0]?.text()).toBe(HTML_FILE);
  });

  it("shows a loading toast and a loading button while the file is made, and starts no second download meanwhile", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    world.answer = async () => {
      await held;
      return undefined;
    };
    await openPage();

    await download();
    await download();

    expect((await screen.findAllByText("Preparing your export…")).length).toBeGreaterThan(0);
    expect(downloadButton().getAttribute("aria-disabled")).toBe("true");
    expect(world.seen).toHaveLength(1);
    expect(world.clicks).toEqual([]);

    await act(async () => {
      release();
      await held;
    });

    await waitFor(() => {
      expect(world.clicks).toHaveLength(1);
    });
    await waitFor(() => {
      expect(downloadButton().getAttribute("aria-disabled")).toBeNull();
    });
    expect(world.seen).toHaveLength(1);
  });
});

describe("the shared bookmarks", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("asks for them when the checkbox is on, for either format", async () => {
    await openPage();

    await press(await screen.findByRole("checkbox", { name: "Include bookmarks shared with me" }));
    await download();
    await waitFor(() => {
      expect(world.clicks).toHaveLength(1);
    });
    await press(screen.getByRole("radio", { name: "Netscape HTML" }));
    await download();
    await waitFor(() => {
      expect(world.clicks).toHaveLength(2);
    });

    expect(world.seen).toEqual([
      { path: "/api/v1/export/json", includeShared: "true" },
      { path: "/api/v1/export/netscape", includeShared: "true" },
    ]);
  });

  it("does not ask for them by default", async () => {
    await openPage();

    const box = await screen.findByRole("checkbox", { name: "Include bookmarks shared with me" });
    expect(box.getAttribute("aria-checked")).toBe("false");
    await download();
    await waitFor(() => {
      expect(world.seen).toHaveLength(1);
    });

    expect(world.seen[0]?.includeShared).toBe("false");
  });

  it.each([
    ["sharing.members only", { members: true, teams: false }],
    ["sharing.teams only", { members: false, teams: true }],
  ])("is offered with %s", async (_name, sharing) => {
    world.sharing = sharing;
    await openPage();

    expect(await screen.findByRole("checkbox", { name: "Include bookmarks shared with me" })).toBeTruthy();
  });

  it("is not offered, and not asked for, without either sharing grant", async () => {
    world.sharing = { members: false, teams: false };
    await openPage();

    await waitFor(() => {
      expect(screen.queryByRole("checkbox", { name: "Include bookmarks shared with me" })).toBeNull();
    });
    await download();
    await waitFor(() => {
      expect(world.seen).toHaveLength(1);
    });

    expect(world.seen[0]?.includeShared).toBe("false");
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

describe("a download that does not go through", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  async function expectRefused(message: string): Promise<void> {
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The export was not downloaded");
    expect(alert.textContent).toContain(message);
    expect(alert.textContent).not.toContain("Hostile");
    expect(world.clicks).toEqual([]);
    expect(world.created).toEqual([]);
    expect(document.querySelector("a[download]")).toBeNull();
    await waitFor(() => {
      expect(downloadButton().getAttribute("aria-disabled")).toBeNull();
    });
  }

  it.each([
    [30, "Too many exports. Try again in 30 seconds."],
    [1, "Too many exports. Try again in 1 second."],
    [90, "Too many exports. Try again in 2 minutes."],
  ])("tells the wait of a 429 with Retry-After %i and saves nothing", async (seconds, message) => {
    world.answer = () => problemOf(429, "rate_limited", { "Retry-After": String(seconds) });
    await openPage();

    await download();

    await expectRefused(message);
  });

  it("says to try later when a 429 gives no wait", async () => {
    world.answer = () => problemOf(429, "rate_limited");
    await openPage();

    await download();

    await expectRefused("Too many exports. Try again later.");
  });

  it("can be tried again after a refusal, and then saves the file", async () => {
    world.answer = () => (world.seen.length === 1 ? problemOf(429, "rate_limited", { "Retry-After": "5" }) : undefined);
    await openPage();

    await download();
    await expectRefused("Too many exports. Try again in 5 seconds.");
    await download();

    await waitFor(() => {
      expect(world.clicks).toHaveLength(1);
    });
    expect(world.seen).toHaveLength(2);
  });

  it("says the server is busy for a 503", async () => {
    world.answer = () => problemOf(503, "service_unavailable");
    await openPage();

    await download();

    await expectRefused("The server is busy. Try again in a moment.");
  });

  it("says the export could not be made for any other failure, never repeating the server's text", async () => {
    world.answer = () => problemOf(500, "internal_error");
    await openPage();

    await download();

    await expectRefused("The export could not be made. Try again.");
  });

  it("says the export could not be made for an answer that is no problem document", async () => {
    world.answer = () => new Response("<html>Bad gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } });
    await openPage();

    await download();

    await expectRefused("The export could not be made. Try again.");
  });

  it("says the server could not be reached when there is no connection", async () => {
    world.answer = () => Response.error();
    await openPage();

    await download();

    await expectRefused("The server could not be reached. Check your connection and try again.");
  });
});

describe("the file name", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it.each([
    ["a path", 'attachment; filename="../../evil.json"'],
    ["a different extension", 'attachment; filename="update.exe"'],
    ["a name with a space and a quote", 'attachment; filename="my file.json"'],
    ["a name that starts with a dot", 'attachment; filename=".bashrc.json"'],
    ["no name", "attachment"],
  ])("is replaced by a fixed name when the response gives %s", async (_name, disposition) => {
    world.answer = () => fileOf(JSON_FILE, "application/json", disposition);
    await openPage();

    await download();

    await waitFor(() => {
      expect(world.clicks).toHaveLength(1);
    });
    expect(world.clicks[0]?.download).toBe("slugbase-export.json");
  });

  it("takes an unquoted name that is plain", async () => {
    world.answer = () => fileOf(JSON_FILE, "application/json", "attachment; filename=backup-1.json");
    await openPage();

    await download();

    await waitFor(() => {
      expect(world.clicks).toHaveLength(1);
    });
    expect(world.clicks[0]?.download).toBe("backup-1.json");
  });

  it("holds the extension of the format that was chosen", async () => {
    world.answer = () => fileOf(HTML_FILE, "text/html; charset=utf-8", `attachment; filename="${JSON_NAME}"`);
    await openPage();

    await press(screen.getByRole("radio", { name: "Netscape HTML" }));
    await download();

    await waitFor(() => {
      expect(world.clicks).toHaveLength(1);
    });
    expect(world.clicks[0]?.download).toBe("slugbase-export.html");
  });
});

describe("the Import and Export commands", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  async function openPalette(): Promise<HTMLElement> {
    await act(async () => {
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
      await Promise.resolve();
    });
    return screen.findByRole("dialog", { name: "Command palette" });
  }

  it("list Import bookmarks and Export bookmarks under Actions", async () => {
    await openPage("/settings/account");
    const dialog = await openPalette();

    const actions = await within(dialog).findByRole("group", { name: "Actions" });
    const labels = within(actions)
      .getAllByRole("option")
      .map((option) => option.querySelector("span.truncate")?.textContent ?? "");
    expect(labels).toEqual(["New bookmark", "New folder", "Import bookmarks", "Export bookmarks", "Switch workspace", "Toggle theme", "Sign out"]);
  });

  it.each([["Import bookmarks"], ["Export bookmarks"]])("%s opens Import & export and closes the palette", async (name) => {
    await openPage("/settings/account");
    const dialog = await openPalette();

    await press(await within(dialog).findByRole("option", { name: new RegExp(name) }));

    expect(await screen.findByRole("heading", { level: 1, name: "Import & export" })).toBeTruthy();
    expect(window.location.pathname).toBe("/settings/account/data");
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    });
    expect(screen.getByRole("heading", { level: 2, name: "Export bookmarks" })).toBeTruthy();
  });

  it("are found by their keywords", async () => {
    await openPage("/settings/account");
    const dialog = await openPalette();

    const input = within(dialog).getByRole("combobox");
    await act(async () => {
      fireEvent.change(input, { target: { value: "netscape" } });
      await Promise.resolve();
    });

    await waitFor(() => {
      const names = within(dialog)
        .getAllByRole("option")
        .map((option) => option.querySelector("span.truncate")?.textContent);
      expect(names).toEqual(expect.arrayContaining(["Import bookmarks", "Export bookmarks"]));
    });
  });
});
